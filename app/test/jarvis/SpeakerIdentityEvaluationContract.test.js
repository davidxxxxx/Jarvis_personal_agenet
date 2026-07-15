"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

test("tracked speaker evaluation contract contains metadata only and documents the privacy boundary", () => {
  const ignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^\/\.private\/speaker-eval\/$/m);

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "app", "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["test:speaker-eval"],
    "node --test test/jarvis/SpeakerIdentityEvaluation.test.js"
  );

  const manifestText = fs.readFileSync(
    path.join(repoRoot, "app", "test", "fixtures", "speaker-eval", "manifest.json"),
    "utf8"
  );
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    new Set(manifest.profiles.map((profile) => profile.kind)),
    new Set(["self", "known"])
  );
  assert.deepEqual(
    new Set(manifest.cases.flatMap((entry) => entry.speakers.map((speaker) => speaker.kind))),
    new Set(["self", "known", "unknown"])
  );
  assert.doesNotMatch(manifestText, /transcript|embedding|@[a-z]|[A-Z]:[\\/]/i);

  const docs = fs.readFileSync(path.join(repoRoot, "docs", "TESTING.md"), "utf8");
  for (const required of [
    "JARVIS_SPEAKER_EVAL_DIR",
    ".private/speaker-eval",
    "consented",
    "No data is downloaded",
    "local inference",
    "test:speaker-eval",
    "automaticSupport",
    "0.95",
    "0.05",
  ]) {
    assert.ok(docs.includes(required), `docs missing ${required}`);
  }
});
