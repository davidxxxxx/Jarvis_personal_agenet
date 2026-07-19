const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { resolveQdrantStorageDir } = require("../../src/helpers/qdrantManager");

test("qdrant follows the active Jarvis data root instead of the home drive", () => {
  const dataRoot = path.resolve(path.parse(process.cwd()).root, "JarvisData", "recordings-data");
  const homeDir = path.resolve(path.parse(process.cwd()).root, "Users", "example");

  assert.equal(
    resolveQdrantStorageDir({ dataRoot, homeDir }),
    path.join(dataRoot, "qdrant-data")
  );
});

test("qdrant keeps the legacy cache fallback when no absolute Jarvis root is active", () => {
  const homeDir = path.resolve(path.parse(process.cwd()).root, "Users", "example");

  assert.equal(
    resolveQdrantStorageDir({ dataRoot: "relative-data", homeDir }),
    path.join(homeDir, ".cache", "openwhispr", "qdrant-data")
  );
});
