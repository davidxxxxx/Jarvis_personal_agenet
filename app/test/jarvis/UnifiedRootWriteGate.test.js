const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  UnifiedRootWriteGate,
  processWriteGate,
} = require("../../src/jarvis/main/UnifiedRootWriteGate");
const MigrationCoordinator = require("../../src/jarvis/main/MigrationCoordinator");
const { getModelsDirForService } = require("../../src/helpers/modelDirUtils");
const { getSafeTempDir, resetSafeTempDir } = require("../../src/helpers/safeTempDir");
const {
  createProductionStorageComposition,
  createUnifiedRootWriterProvider,
} = require("../../src/jarvis/main/JarvisStorageBootstrap");

test("migration closes the shared write gate and drains an in-flight producer lease", async () => {
  const gate = new UnifiedRootWriteGate();
  const release = gate.acquireWriteLease("model-download");
  const events = [];
  const coordinator = new MigrationCoordinator({
    writeGate: gate,
    providers: [
      {
        name: "models",
        async quiesce() {
          events.push("quiesce");
          release();
        },
        async close() {
          events.push("close");
        },
        async reopen() {},
        async rollback() {},
        async resume() {
          events.push("resume");
        },
      },
    ],
  });

  await coordinator.runExclusive(async () => {
    events.push("operation");
    assert.throws(
      () => gate.acquireWriteLease("late-temp-write"),
      (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
    );
  });

  assert.deepEqual(events, ["quiesce", "close", "operation", "resume"]);
  gate.acquireWriteLease("after-resume")();
});

test("unified model and temp path producers fail before creating directories while the process gate is closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-write-gate-"));
  const previous = process.env.JARVIS_DATA_ROOT;
  t.after(() => {
    processWriteGate.open();
    process.env.JARVIS_DATA_ROOT = previous;
    resetSafeTempDir();
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.JARVIS_DATA_ROOT = root;
  processWriteGate.close();

  assert.throws(
    () => getModelsDirForService("whisper"),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  assert.throws(
    () => getSafeTempDir(),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  assert.equal(fs.existsSync(path.join(root, "temp")), false);
});

test("production writer provider quiesces every registered unified-root manager", async () => {
  const events = [];
  const provider = createUnifiedRootWriterProvider({
    getManagers: () => [
      {
        name: "cuda",
        async quiesce() {
          events.push("cuda:quiesce");
        },
        resume() {
          events.push("cuda:resume");
        },
      },
      {
        name: "whisper",
        async cancelDownload() {
          events.push("whisper:cancel");
        },
      },
      {
        name: "parakeet",
        async cancelDownload() {
          events.push("parakeet:cancel");
        },
      },
      {
        name: "diarization",
        async cancelDownload() {
          events.push("diarization:cancel");
        },
      },
    ],
  });

  await provider.quiesce();
  await provider.close();
  await provider.reopen();
  await provider.rollback();
  await provider.resume();

  assert.deepEqual(events, [
    "cuda:quiesce",
    "whisper:cancel",
    "parakeet:cancel",
    "diarization:cancel",
    "cuda:resume",
  ]);
});

test("production storage composition wires startup validation and writer holders into its migrator", async (t) => {
  const fsp = require("node:fs/promises");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-production-storage-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const userDataDir = path.join(base, "user-data");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await fsp.mkdir(path.join(source, "models"), { recursive: true });
  await fsp.writeFile(path.join(source, "jarvis.db"), "database");
  await fsp.writeFile(path.join(source, "models", "model.bin"), "model");
  let pending = null;
  const activationResults = [];
  const dataRootConfig = {
    beginActivation(state) {
      pending = { ...state, phase: "persisted" };
      throw new Error("simulated process crash");
    },
    markActivationPhase() {},
    save(root) {
      return root;
    },
    async recoverActivation(validateRoot) {
      const accepted = await validateRoot(pending.target, pending);
      activationResults.push(accepted);
      return accepted ? pending.target : pending.previous;
    },
  };
  const events = [];
  const directoryIdentityProvider = async (candidate) => {
    const stat = await fsp.lstat(candidate);
    return {
      path: path.resolve(candidate),
      dev: String(stat.dev),
      ino: String(stat.ino),
      finalPath: path.resolve(candidate),
      volumeIdentity: "test-volume",
    };
  };
  const composition = createProductionStorageComposition({
    userDataDir,
    dataRootConfig,
    getManagers: () => [
      {
        async cancelDownload() {
          events.push("manager:cancel");
        },
        async resume() {
          events.push("manager:resume");
        },
      },
    ],
    relocateTarget: async () => {},
    migratorOptions: {
      pathInspector: { inspect: async () => ({ reparse: false, mountPoint: false }) },
      volumeInspector: {
        inspect: async () => ({ kind: "fixed", writable: true, identity: "test-volume" }),
      },
      directoryIdentityProvider,
    },
  });
  composition.registerWriterProvider();

  await assert.rejects(
    composition.dataDirectoryMigrator.migrate({ from: source, to: target }),
    /simulated process crash/
  );
  assert.deepEqual(events, ["manager:cancel", "manager:resume"]);
  assert.equal(await composition.recoverActivation(), target);
  await fsp.writeFile(path.join(target, "models", "model.bin"), "tampered");
  assert.equal(await composition.recoverActivation(), source);
  assert.deepEqual(activationResults, [true, false]);
});
