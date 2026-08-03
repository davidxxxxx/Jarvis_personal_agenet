const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  parseTag,
  readVersionState,
  validateVersionState,
} = require("../../scripts/jarvis-release-version");

const repoRoot = path.resolve(__dirname, "../../..");

test("current Jarvis package, lockfile, changelog, and tag are consistent", () => {
  const result = readVersionState(repoRoot, "jarvis-v0.2.0-rc.1");

  assert.deepEqual(result, {
    ok: true,
    version: "0.2.0-rc.1",
    expectedTag: "jarvis-v0.2.0-rc.1",
    prerelease: true,
    errors: [],
  });
});

test("version gate rejects mismatched lockfiles, changelogs, and Git tags", () => {
  const result = validateVersionState({
    packageVersion: "0.2.0-alpha.3",
    lockfileVersion: "0.2.0-alpha.2",
    lockfileRootVersion: "0.2.0-alpha.2",
    changelog: "# Changelog\n\n## 0.2.0-alpha.2 - 2026-07-20\n",
    tag: "v0.2.0-alpha.3",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "package-lock version 0.2.0-alpha.2 does not match 0.2.0-alpha.3",
    "package-lock root version 0.2.0-alpha.2 does not match 0.2.0-alpha.3",
    "CHANGELOG.md has no release heading for 0.2.0-alpha.3",
    "Git tag v0.2.0-alpha.3 does not match expected jarvis-v0.2.0-alpha.3",
  ]);
});

test("release tag parser requires an explicit value", () => {
  assert.equal(parseTag([]), null);
  assert.equal(parseTag(["--tag", "jarvis-v0.2.0"]), "jarvis-v0.2.0");
  assert.throws(() => parseTag(["--tag"]), /requires a value/);
});
