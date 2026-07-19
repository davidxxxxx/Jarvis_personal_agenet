const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveFullscreenYieldActive,
} = require("../../src/jarvis/main/FullscreenYieldPolicy");

test("fullscreen yield uses prior fullscreen state to distinguish generic recovery", () => {
  assert.equal(
    resolveFullscreenYieldActive(
      {
        state: "busy",
        reason: "recovery_hysteresis",
        fullscreenActivityActive: false,
      },
      false
    ),
    false
  );
  assert.equal(
    resolveFullscreenYieldActive({
      state: "busy",
      reason: "fullscreen_game",
      fullscreenActivityActive: true,
    }),
    true
  );
  assert.equal(
    resolveFullscreenYieldActive(
      {
        state: "busy",
        reason: "recovery_hysteresis",
        fullscreenActivityActive: false,
      },
      true
    ),
    true
  );
  assert.equal(
    resolveFullscreenYieldActive(
      {
        state: "available",
        reason: null,
        fullscreenActivityActive: false,
      },
      true
    ),
    false
  );
});
