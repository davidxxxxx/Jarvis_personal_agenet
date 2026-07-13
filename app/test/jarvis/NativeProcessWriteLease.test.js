const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const LlamaServerManager = require("../../src/helpers/llamaServer");
const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
const WhisperServerManager = require("../../src/helpers/whisperServer");
const { processWriteGate } = require("../../src/jarvis/main/UnifiedRootWriteGate");

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 999999999;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

async function expectGateIdle() {
  processWriteGate.close();
  await processWriteGate.waitForIdle();
  processWriteGate.open();
}

test("native server synchronous spawn failures release capture authority", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-native-spawn-fail-"));
  t.after(async () => {
    processWriteGate.open();
    await fsp.rm(base, { recursive: true, force: true });
  });
  const modelFile = path.join(base, "model.bin");
  const modelDir = path.join(base, "parakeet-model");
  await fsp.writeFile(modelFile, "model");
  await fsp.mkdir(modelDir);
  const spawnFailure = () => {
    throw new Error("injected spawn failure");
  };

  processWriteGate.open();
  const llama = new LlamaServerManager({ spawnImpl: spawnFailure });
  await assert.rejects(llama._startWithBinary("llama", [], {}, 100), /injected spawn failure/);
  await expectGateIdle();

  const parakeet = new ParakeetWsServer({ spawnImpl: spawnFailure });
  parakeet.getWsBinaryPath = () => "parakeet";
  await assert.rejects(parakeet._doStart("model", modelDir), /injected spawn failure/);
  await expectGateIdle();

  const whisper = new WhisperServerManager({ spawnImpl: spawnFailure });
  whisper.getServerBinaryPath = () => path.join(base, "whisper-server.exe");
  whisper.getFFmpegPath = () => null;
  whisper.findAvailablePort = async () => 8178;
  await assert.rejects(whisper._doStart(modelFile, { threads: 1 }), /injected spawn failure/);
  await expectGateIdle();
});

test("native server error events retain authority until the corresponding close event", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-native-close-"));
  t.after(async () => {
    processWriteGate.open();
    await fsp.rm(base, { recursive: true, force: true });
  });
  const modelFile = path.join(base, "model.bin");
  const modelDir = path.join(base, "parakeet-model");
  await fsp.writeFile(modelFile, "model");
  await fsp.mkdir(modelDir);

  const cases = [
    {
      create(child) {
        const manager = new LlamaServerManager({ spawnImpl: () => child });
        manager.checkHealth = async () => false;
        return {
          manager,
          starting: manager._startWithBinary("llama", [], {}, 10_000),
        };
      },
    },
    {
      create(child) {
        const manager = new ParakeetWsServer({ spawnImpl: () => child });
        manager.getWsBinaryPath = () => "parakeet";
        return {
          manager,
          starting: manager._doStart("model", modelDir),
        };
      },
    },
    {
      create(child) {
        const manager = new WhisperServerManager({ spawnImpl: () => child });
        manager.getServerBinaryPath = () => path.join(base, "whisper-server.exe");
        manager.getFFmpegPath = () => null;
        manager.findAvailablePort = async () => 8178;
        manager.waitForReady = () =>
          new Promise((_, reject) => child.once("error", () => reject(new Error("spawn failed"))));
        return {
          manager,
          starting: manager._doStart(modelFile, { threads: 1 }),
        };
      },
    },
  ];

  for (const { create } of cases) {
    processWriteGate.open();
    const child = fakeChild();
    const { starting } = create(child);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn failed"));
    await assert.rejects(starting);
    processWriteGate.close();
    let drained = false;
    const idle = processWriteGate.waitForIdle().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);

    child.exitCode = 1;
    child.emit("close", 1, null);
    await idle;
    assert.equal(drained, true);
    processWriteGate.open();
  }
});
