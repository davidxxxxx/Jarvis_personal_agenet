const fs = require("node:fs");
const path = require("node:path");

const JARVIS_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateVersionState({
  packageVersion,
  lockfileVersion,
  lockfileRootVersion,
  changelog,
  tag = null,
}) {
  const errors = [];

  if (!JARVIS_VERSION_PATTERN.test(packageVersion ?? "")) {
    errors.push(`invalid Jarvis Semantic Version: ${packageVersion ?? "<missing>"}`);
  }
  if (lockfileVersion !== packageVersion) {
    errors.push(
      `package-lock version ${lockfileVersion ?? "<missing>"} does not match ${packageVersion}`
    );
  }
  if (lockfileRootVersion !== packageVersion) {
    errors.push(
      `package-lock root version ${lockfileRootVersion ?? "<missing>"} does not match ${packageVersion}`
    );
  }

  const changelogHeading = new RegExp(
    `^## ${escapeRegExp(packageVersion ?? "")}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "m"
  );
  if (!changelogHeading.test(changelog)) {
    errors.push(`CHANGELOG.md has no release heading for ${packageVersion}`);
  }

  const expectedTag = `jarvis-v${packageVersion}`;
  if (tag && tag !== expectedTag) {
    errors.push(`Git tag ${tag} does not match expected ${expectedTag}`);
  }

  return {
    ok: errors.length === 0,
    version: packageVersion,
    expectedTag,
    prerelease: packageVersion?.includes("-") === true,
    errors,
  };
}

function readVersionState(repoRoot, tag = null) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "app", "package.json"), "utf8")
  );
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "app", "package-lock.json"), "utf8")
  );
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

  return validateVersionState({
    packageVersion: packageJson.version,
    lockfileVersion: packageLock.version,
    lockfileRootVersion: packageLock.packages?.[""]?.version,
    changelog,
    tag,
  });
}

function parseTag(argv) {
  const index = argv.indexOf("--tag");
  if (index === -1) return null;
  const tag = argv[index + 1];
  if (!tag || tag.startsWith("--")) {
    throw new Error("--tag requires a value");
  }
  return tag;
}

function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const result = readVersionState(repoRoot, parseTag(process.argv.slice(2)));
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[jarvis-release] ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[jarvis-release] ${result.version} is consistent; expected tag ${result.expectedTag}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[jarvis-release] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  JARVIS_VERSION_PATTERN,
  parseTag,
  readVersionState,
  validateVersionState,
};
