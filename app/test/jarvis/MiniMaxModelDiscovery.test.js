const test = require("node:test");
const assert = require("node:assert/strict");

const MiniMaxModelDiscovery = require("../../src/jarvis/main/MiniMaxModelDiscovery");

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test("model discovery performs no network request without a configured key", async () => {
  let calls = 0;
  const discovery = new MiniMaxModelDiscovery({
    getApiKey: () => null,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });

  assert.deepEqual(await discovery.discover(), {
    status: "not_configured",
    configuredModel: "MiniMax-M2.7",
    resolvedModel: "MiniMax-M2.7",
    fallbackUsed: false,
    checkedAt: null,
  });
  assert.equal(calls, 0);
});

test("model discovery uses the official read-only endpoint and caches a ready result", async () => {
  const calls = [];
  let now = 10_000;
  const discovery = new MiniMaxModelDiscovery({
    getApiKey: () => "test-subscription-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ object: "list", data: [{ id: "MiniMax-M2.7", object: "model" }] });
    },
    now: () => now,
  });

  const first = await discovery.discover();
  now += 1_000;
  const second = await discovery.discover();
  assert.deepEqual(first, {
    status: "ready",
    configuredModel: "MiniMax-M2.7",
    resolvedModel: "MiniMax-M2.7",
    fallbackUsed: false,
    checkedAt: 10_000,
  });
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(Object.keys(calls[0].options.headers).length, 1);
});

test("an unavailable configured model falls back only to the supported default", async () => {
  const discovery = new MiniMaxModelDiscovery({
    configuredModel: "MiniMax-M9-preview",
    getApiKey: () => "test-subscription-key",
    fetchImpl: async () => response({ data: [{ id: "MiniMax-M2.7" }] }),
    now: () => 20_000,
  });

  assert.deepEqual(await discovery.discover(), {
    status: "ready",
    configuredModel: "MiniMax-M9-preview",
    resolvedModel: "MiniMax-M2.7",
    fallbackUsed: true,
    checkedAt: 20_000,
  });
});

test("network, malformed, oversized, and missing-model responses degrade without throwing", async () => {
  const implementations = [
    async () => {
      throw new Error("network body with private details");
    },
    async () => response({ unexpected: [] }),
    async () => response({ data: [] }, { headers: { "content-length": "999999" } }),
    async () => response({ data: [{ id: "unrelated-model" }] }),
  ];
  const expectedStatuses = ["unavailable", "unavailable", "unavailable", "model_unavailable"];

  for (let index = 0; index < implementations.length; index += 1) {
    const discovery = new MiniMaxModelDiscovery({
      getApiKey: () => "test-subscription-key",
      fetchImpl: implementations[index],
      now: () => 30_000 + index,
    });
    const result = await discovery.discover();
    assert.equal(result.status, expectedStatuses[index]);
    assert.equal(result.resolvedModel, "MiniMax-M2.7");
    assert.equal(JSON.stringify(result).includes("private details"), false);
  }
});

test("forcing discovery bypasses the cache after a key update", async () => {
  let calls = 0;
  const discovery = new MiniMaxModelDiscovery({
    getApiKey: () => "test-subscription-key",
    fetchImpl: async () => {
      calls += 1;
      return response({ data: [{ id: "MiniMax-M2.7" }] });
    },
    now: () => 40_000,
  });

  await discovery.discover();
  await discovery.discover({ force: true });
  assert.equal(calls, 2);
});

test("model discovery rejects non-official endpoints before any request", () => {
  assert.throws(
    () =>
      new MiniMaxModelDiscovery({
        getApiKey: () => "key",
        baseUrl: "https://example.invalid/v1",
      }),
    /models endpoint is invalid/u
  );
});
