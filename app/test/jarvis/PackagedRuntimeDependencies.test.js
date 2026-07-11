const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = path.resolve(__dirname, "../..");

test("declares startup modules as direct production dependencies", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));

  for (const dependency of ["bindings", "file-uri-to-path", "fs-extra", "onnxruntime-common"]) {
    assert.equal(
      typeof packageJson.dependencies?.[dependency],
      "string",
      `${dependency} must be a direct production dependency so electron-builder includes it in app.asar`
    );
  }
});
