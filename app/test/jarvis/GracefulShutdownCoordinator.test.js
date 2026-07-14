const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GracefulShutdownCoordinator,
  RendererShutdownHandshake,
} = require("../../src/jarvis/main/GracefulShutdownCoordinator");

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("renderer shutdown handshake acknowledges, times out, and falls back on crash", async () => {
  const sent = [];
  let timeoutCallback;
  const handshake = new RendererShutdownHandshake({
    send: (request) => sent.push(request),
    isAvailable: () => true,
    createId: () => `shutdown-${sent.length + 1}`,
    setTimeoutImpl: (callback) => {
      timeoutCallback = callback;
      return { id: sent.length };
    },
    clearTimeoutImpl: () => {},
  });

  const acknowledged = handshake.request(500);
  assert.equal(handshake.acknowledge(sent[0].id, "ok"), true);
  assert.deepEqual(await acknowledged, { status: "acknowledged", outcome: "ok" });

  const crashed = handshake.request(500);
  handshake.markRendererGone();
  assert.deepEqual(await crashed, { status: "renderer_gone" });

  const timedOut = handshake.request(500);
  timeoutCallback();
  assert.deepEqual(await timedOut, { status: "timeout" });
});

test("shutdown is idempotent and preserves renderer, upstream, runtime, writer, repository order", async () => {
  const order = [];
  const renderer = deferred();
  const upstream = deferred();
  const coordinator = new GracefulShutdownCoordinator({
    requestRendererFlush: async () => {
      order.push("renderer");
      await renderer.promise;
    },
    beginClose: () => order.push("begin-close"),
    stopUpstream: [
      async () => {
        order.push("upstream-a");
        await upstream.promise;
      },
      async () => order.push("upstream-b"),
    ],
    stopRuntime: [async () => order.push("runtime")],
    closeWriter: async () => order.push("writer"),
    closeRepository: async () => order.push("repository"),
    phaseTimeoutMs: 1_000,
  });

  const first = coordinator.shutdown();
  const second = coordinator.shutdown();
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(order, ["renderer"]);
  renderer.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["renderer", "begin-close", "upstream-a", "upstream-b"]);
  upstream.resolve();
  await first;
  assert.deepEqual(order, [
    "renderer",
    "begin-close",
    "upstream-a",
    "upstream-b",
    "runtime",
    "writer",
    "repository",
  ]);
});

test("rejections and bounded upstream timeouts still close writer and repository", async () => {
  const order = [];
  const coordinator = new GracefulShutdownCoordinator({
    requestRendererFlush: async () => {
      throw new Error("renderer crashed");
    },
    beginClose: () => order.push("begin-close"),
    stopUpstream: [
      async () => {
        order.push("stuck-upstream");
        await new Promise(() => {});
      },
      async () => {
        throw new Error("stop failed");
      },
    ],
    stopRuntime: [async () => order.push("runtime")],
    closeWriter: async () => order.push("writer"),
    closeRepository: async () => order.push("repository"),
    phaseTimeoutMs: 5,
  });

  await coordinator.shutdown();
  assert.deepEqual(order, ["begin-close", "stuck-upstream", "runtime", "writer", "repository"]);
});

test("runtime shutdown is never timed out before writer and repository closure", async () => {
  const order = [];
  const runtime = deferred();
  const coordinator = new GracefulShutdownCoordinator({
    requestRendererFlush: async () => {},
    beginClose: async () => {},
    stopUpstream: [],
    stopRuntime: [async () => {
      order.push("runtime");
      await runtime.promise;
      order.push("runtime-stopped");
    }],
    closeWriter: async () => order.push("writer"),
    closeRepository: async () => order.push("repository"),
    phaseTimeoutMs: 5,
  });

  const stopping = coordinator.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(order, ["runtime"]);
  runtime.resolve();
  await stopping;
  assert.deepEqual(order, ["runtime", "runtime-stopped", "writer", "repository"]);
});
