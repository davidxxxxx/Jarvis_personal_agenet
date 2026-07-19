const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeApplicationAudio } = require("../../src/jarvis/main/AudioChunkPublicView");

test("application capture projection reports exact coverage, degraded spans, and recovery points", () => {
  const summary = summarizeApplicationAudio([
    {
      id: "exact-1",
      session_id: "session-1",
      track_id: "chrome-1",
      interval_kind: "application_active",
      application_key: "chrome",
      attribution_state: "exact",
      capture_generation: 1,
      started_at: 1_000,
      ended_at: 2_000,
      reason: null,
    },
    {
      id: "fallback-2",
      session_id: "session-1",
      track_id: "system-mix",
      interval_kind: "mixed_fallback",
      application_key: null,
      attribution_state: "mixed_unknown",
      capture_generation: 2,
      started_at: 2_000,
      ended_at: 2_500,
      reason: "application_capture_failed",
      raw_process_path: "C:\\private\\chrome.exe",
    },
    {
      id: "exact-2",
      session_id: "session-1",
      track_id: "chrome-2",
      interval_kind: "application_active",
      application_key: "chrome",
      attribution_state: "exact",
      capture_generation: 2,
      started_at: 2_500,
      ended_at: 3_500,
      reason: null,
    },
    {
      id: "open-fallback",
      session_id: "session-1",
      track_id: "system-mix",
      interval_kind: "mixed_fallback",
      application_key: null,
      attribution_state: "mixed_unknown",
      capture_generation: 3,
      started_at: 4_000,
      ended_at: null,
      reason: "retry_wait",
    },
  ]);

  assert.equal(summary.exact_duration_ms, 2_000);
  assert.equal(summary.fallback_duration_ms, 500);
  assert.equal(summary.exact_coverage_pct, 80);
  assert.deepEqual(summary.recovery_points, [2_500]);
  assert.deepEqual(summary.degraded_intervals.map((interval) => interval.id), ["fallback-2"]);
  assert.equal("raw_process_path" in summary.degraded_intervals[0], false);
});
