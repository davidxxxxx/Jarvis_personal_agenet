const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const environmentModulePath = require.resolve("../../src/helpers/environment");

async function withTempDirectory(run) {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "jarvis-minimax-secret-persistence-")
  );
  try {
    return await run(directory);
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSecretCrypto({ available = true } = {}) {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value) => ({
      value: value.toString("utf8").replace(/^encrypted:/, ""),
      needsReencrypt: false,
    }),
  };
}

function loadEnvironmentManager({ userDataDirectory, secretCrypto, promiseFs = fsPromises }) {
  const logs = [];
  const originalLoad = Module._load;
  process.resourcesPath = userDataDirectory;
  delete require.cache[environmentModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userDataDirectory } };
    }
    if (request === "./secretCrypto" && parent?.filename === environmentModulePath) {
      return secretCrypto;
    }
    if (request === "./debugLogger" && parent?.filename === environmentModulePath) {
      return {
        error: (...args) => logs.push(["error", ...args]),
        info: (...args) => logs.push(["info", ...args]),
        warn: (...args) => logs.push(["warn", ...args]),
      };
    }
    if (request === "fs/promises" && parent?.filename === environmentModulePath) {
      return promiseFs;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { EnvironmentManager: require(environmentModulePath), logs };
  } finally {
    Module._load = originalLoad;
    delete require.cache[environmentModulePath];
  }
}

async function writeEncryptedKey(directory, value) {
  const secureDirectory = path.join(directory, "secure-keys");
  await fsPromises.mkdir(secureDirectory, { recursive: true });
  const target = path.join(secureDirectory, "MINIMAX_API_KEY.enc");
  await fsPromises.writeFile(target, Buffer.from(`encrypted:${value}`, "utf8"));
  return target;
}

test("resource governance settings persist and reload with advanced overrides", () =>
  withTempDirectory(async (directory) => {
    const keys = [
      "JARVIS_RESOURCE_PROFILE",
      "JARVIS_EXTERNAL_GPU_THRESHOLD_PCT",
      "JARVIS_RESOURCE_RECOVERY_WAIT_MS",
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];

    const { EnvironmentManager } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto(),
    });

    try {
      const first = new EnvironmentManager();
      assert.deepEqual(first.getJarvisResourceSettings(), {
        profile: "balanced",
        externalGpuThresholdPct: 45,
        recoveryWaitMs: 60_000,
      });

      const saved = await first.saveJarvisResourceSettings({
        profile: "game_priority",
        externalGpuThresholdPct: 30,
        recoveryWaitMs: 180_000,
      });
      assert.deepEqual(saved, {
        profile: "game_priority",
        externalGpuThresholdPct: 30,
        recoveryWaitMs: 180_000,
      });

      const persisted = await fsPromises.readFile(path.join(directory, ".env"), "utf8");
      assert.match(persisted, /^JARVIS_RESOURCE_PROFILE=game_priority$/m);
      assert.match(persisted, /^JARVIS_EXTERNAL_GPU_THRESHOLD_PCT=30$/m);
      assert.match(persisted, /^JARVIS_RESOURCE_RECOVERY_WAIT_MS=180000$/m);

      for (const key of keys) delete process.env[key];
      const reloaded = new EnvironmentManager();
      assert.deepEqual(reloaded.getJarvisResourceSettings(), saved);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }));

test("MiniMax save is awaited and changes the process value only after atomic rename", () =>
  withTempDirectory(async (directory) => {
    const previous = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "old-local-value";
    const target = await writeEncryptedKey(directory, "old-local-value");
    const renameEntered = deferred();
    const releaseRename = deferred();
    const renameCompleted = deferred();
    const promiseFs = {
      ...fsPromises,
      async rename(from, to) {
        renameEntered.resolve();
        await releaseRename.promise;
        await fsPromises.rename(from, to);
        renameCompleted.resolve();
      },
    };
    const { EnvironmentManager } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto(),
      promiseFs,
    });
    const manager = new EnvironmentManager();

    try {
      const pending = manager.saveMiniMaxKey("new-local-value");
      const returnedPromise = typeof pending?.then === "function";
      await renameEntered.promise;
      const processValueBeforeRename = process.env.MINIMAX_API_KEY;
      const fileValueBeforeRename = await fsPromises.readFile(target, "utf8");
      releaseRename.resolve();
      await renameCompleted.promise;
      await pending;

      assert.equal(returnedPromise, true);
      assert.equal(processValueBeforeRename, "old-local-value");
      assert.equal(fileValueBeforeRename, "encrypted:old-local-value");
      assert.equal(process.env.MINIMAX_API_KEY, "new-local-value");
      assert.equal(await fsPromises.readFile(target, "utf8"), "encrypted:new-local-value");
    } finally {
      releaseRename.resolve();
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  }));

test("MiniMax set and clear are serialized across instances", () =>
  withTempDirectory(async (directory) => {
    const previous = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const renameEntered = deferred();
    const releaseRename = deferred();
    let unlinkCalls = 0;
    const promiseFs = {
      ...fsPromises,
      async rename(from, to) {
        renameEntered.resolve();
        await releaseRename.promise;
        return fsPromises.rename(from, to);
      },
      async unlink(target) {
        unlinkCalls += 1;
        return fsPromises.unlink(target);
      },
    };
    const { EnvironmentManager } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto(),
      promiseFs,
    });
    const first = new EnvironmentManager();
    const second = new EnvironmentManager();

    try {
      const saving = first.saveMiniMaxKey("queued-value");
      await renameEntered.promise;
      const clearing = second.clearMiniMaxKey();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unlinkCalls, 0);

      releaseRename.resolve();
      await saving;
      await clearing;
      assert.equal(unlinkCalls, 1);
      assert.equal(process.env.MINIMAX_API_KEY, undefined);
      assert.equal(
        fs.existsSync(path.join(directory, "secure-keys", "MINIMAX_API_KEY.enc")),
        false
      );
    } finally {
      releaseRename.resolve();
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  }));

test("failed MiniMax save preserves the previous file and process value and emits only a safe log", () =>
  withTempDirectory(async (directory) => {
    const previous = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "old-local-value";
    const target = await writeEncryptedKey(directory, "old-local-value");
    const privateFailure = `private failure at ${target}`;
    const promiseFs = {
      ...fsPromises,
      async rename() {
        throw new Error(privateFailure);
      },
    };
    const { EnvironmentManager, logs } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto(),
      promiseFs,
    });
    const manager = new EnvironmentManager();

    try {
      const pending = manager.saveMiniMaxKey("new-local-value");
      assert.equal(typeof pending?.then, "function");
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, "MINIMAX_SECRET_PERSIST_FAILED");
        assert.equal(error.message, "MINIMAX_SECRET_PERSIST_FAILED");
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(process.env.MINIMAX_API_KEY, "old-local-value");
      assert.equal(await fsPromises.readFile(target, "utf8"), "encrypted:old-local-value");
      const serializedLogs = JSON.stringify(logs);
      assert.equal(serializedLogs.includes("old-local-value"), false);
      assert.equal(serializedLogs.includes("new-local-value"), false);
      assert.equal(serializedLogs.includes(target), false);
      assert.equal(serializedLogs.includes(privateFailure), false);
      assert.equal(serializedLogs.includes("MINIMAX_API_KEY"), false);
      assert.match(serializedLogs, /MINIMAX_SECRET_PERSIST_FAILED/);
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  }));

test("secure storage unavailability fails closed without changing memory or disk", () =>
  withTempDirectory(async (directory) => {
    const previous = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "old-local-value";
    const target = await writeEncryptedKey(directory, "old-local-value");
    const { EnvironmentManager, logs } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto({ available: false }),
    });
    const manager = new EnvironmentManager();

    try {
      await assert.rejects(manager.saveMiniMaxKey("new-local-value"), (error) => {
        assert.equal(error.code, "MINIMAX_SECURE_STORAGE_UNAVAILABLE");
        assert.equal(error.message, "MINIMAX_SECURE_STORAGE_UNAVAILABLE");
        return true;
      });
      assert.equal(process.env.MINIMAX_API_KEY, "old-local-value");
      assert.equal(await fsPromises.readFile(target, "utf8"), "encrypted:old-local-value");
      assert.deepEqual(logs, []);
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  }));

test("failed MiniMax clear preserves the encrypted file and process value", () =>
  withTempDirectory(async (directory) => {
    const previous = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "old-local-value";
    const target = await writeEncryptedKey(directory, "old-local-value");
    const privateFailure = `cannot remove ${target}`;
    const promiseFs = {
      ...fsPromises,
      async unlink() {
        throw new Error(privateFailure);
      },
    };
    const { EnvironmentManager, logs } = loadEnvironmentManager({
      userDataDirectory: directory,
      secretCrypto: createSecretCrypto(),
      promiseFs,
    });
    const manager = new EnvironmentManager();

    try {
      await assert.rejects(manager.clearMiniMaxKey(), (error) => {
        assert.equal(error.code, "MINIMAX_SECRET_CLEAR_FAILED");
        assert.equal(error.message, "MINIMAX_SECRET_CLEAR_FAILED");
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(process.env.MINIMAX_API_KEY, "old-local-value");
      assert.equal(await fsPromises.readFile(target, "utf8"), "encrypted:old-local-value");
      const serializedLogs = JSON.stringify(logs);
      assert.equal(serializedLogs.includes("old-local-value"), false);
      assert.equal(serializedLogs.includes(target), false);
      assert.equal(serializedLogs.includes(privateFailure), false);
      assert.equal(serializedLogs.includes("MINIMAX_API_KEY"), false);
      assert.match(serializedLogs, /MINIMAX_SECRET_CLEAR_FAILED/);
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  }));
