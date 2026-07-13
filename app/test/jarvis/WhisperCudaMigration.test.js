const assert = require("node:assert/strict");
const test = require("node:test");

const WhisperCudaManager = require("../../src/helpers/whisperCudaManager");

test("CUDA manager quiesce blocks new downloads and waits for the active producer", async () => {
  const manager = new WhisperCudaManager();
  let resolveDownload;
  manager._download = () =>
    new Promise((resolve) => {
      resolveDownload = resolve;
    });
  manager.cancelDownload = async () => ({ success: true });
  assert.equal(typeof manager.quiesce, "function");
  const active = manager.download();
  let drained = false;
  const quiesced = manager.quiesce().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(drained, false);
  await assert.rejects(
    manager.download(),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  resolveDownload({ success: true });
  await Promise.all([active, quiesced]);
  manager.resume();
});
