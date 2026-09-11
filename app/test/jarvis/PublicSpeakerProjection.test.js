const assert = require("node:assert/strict");
const test = require("node:test");

const { isPublicSpeakerCluster } = require("../../src/jarvis/main/JarvisRepository");

test("public speaker projection hides short fragment clusters", () => {
  assert.equal(
    isPublicSpeakerCluster({
      linkState: "unknown",
      speechMs: 4_999,
      windowCount: 20,
    }),
    false
  );
  assert.equal(
    isPublicSpeakerCluster({
      linkState: "unknown",
      speechMs: 20_000,
      windowCount: 2,
    }),
    false
  );
});

test("public speaker projection keeps durable and user-confirmed speakers", () => {
  assert.equal(
    isPublicSpeakerCluster({
      linkState: "unknown",
      speechMs: 5_000,
      windowCount: 3,
      qualityScore: 0.72,
    }),
    true
  );
  assert.equal(
    isPublicSpeakerCluster({
      linkState: "unknown",
      speechMs: 20_000,
      windowCount: 20,
      qualityScore: 0.71,
    }),
    false
  );
  assert.equal(
    isPublicSpeakerCluster({
      linkState: "confirmed",
      speechMs: 800,
      windowCount: 1,
    }),
    true
  );
});
