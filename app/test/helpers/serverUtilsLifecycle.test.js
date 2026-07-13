const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { gracefulStopProcess } = require("../../src/utils/serverUtils");

test("forced native stop does not resolve until process close confirms termination", async () => {
  const child = new EventEmitter();
  child.pid = 999999999;
  child.exitCode = null;
  child.kill = () => true;
  let settled = false;

  const stopping = gracefulStopProcess(child, {
    gracefulTimeoutMs: 1,
    forcedTimeoutMs: 100,
  }).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  child.exitCode = 1;
  child.emit("close", 1, "SIGKILL");
  await stopping;
  assert.equal(settled, true);
  assert.equal(child.listenerCount("close"), 0);
});

test("forced native stop fails closed when termination cannot be confirmed", async () => {
  const child = new EventEmitter();
  child.pid = 999999999;
  child.exitCode = null;
  child.kill = () => true;

  await assert.rejects(
    gracefulStopProcess(child, { gracefulTimeoutMs: 1, forcedTimeoutMs: 1 }),
    /termination could not be confirmed/
  );
  assert.equal(child.listenerCount("close"), 0);
});
