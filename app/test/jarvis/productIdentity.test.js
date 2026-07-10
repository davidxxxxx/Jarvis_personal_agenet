const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("package and Windows builder identify Jarvis", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const builder = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.json"), "utf8"));

  assert.equal(pkg.name, "jarvis-memory-assistant");
  assert.equal(pkg.productName, "Jarvis Memory");
  assert.equal(builder.appId, "com.local.jarvis-memory");
  assert.equal(builder.productName, "Jarvis Memory");
  assert.deepEqual(builder.win.target, ["nsis", "portable"]);
});
