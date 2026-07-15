"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");
const { loadPrivateSpeakerEvaluation } = require("./support/SpeakerIdentityEvaluationGate");
const {
  evaluatePreparedSpeakerFixtures,
  createProductionSpeakerRuntime,
  withPrivateLoggingSuppressed,
} = require("./support/SpeakerIdentityEvaluationAdapter");
const { evaluateSpeakerReleaseGates } = require("./support/SpeakerIdentityMetrics");

test("consented private speaker fixtures satisfy production release gates", async (t) => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const production = createProductionSpeakerRuntime();
  const prepared = await loadPrivateSpeakerEvaluation({
    repoRoot,
    manifestPath: path.join(repoRoot, "app", "test", "fixtures", "speaker-eval", "manifest.json"),
    runtime: production.runtime,
  });
  if (prepared.status === "skip") {
    t.skip(prepared.hint);
    return;
  }

  const report = await withPrivateLoggingSuppressed(() =>
    evaluatePreparedSpeakerFixtures({
      prepared,
      inference: production.inference,
      resolver: production.resolver,
      policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
    })
  );
  const release = evaluateSpeakerReleaseGates(report);

  // The report contains anonymous manifest IDs and aggregate metrics only.
  console.log(`speaker-eval aggregate report: ${JSON.stringify(report)}`);
  assert.deepEqual(release, { passed: true, failures: [] });
});
