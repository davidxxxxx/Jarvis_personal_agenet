"use strict";

const { readdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const testRoot = path.join(appRoot, "test", "jarvis");
const soakFiles = new Set(["AllDayCaptureSoak.test.js", "AllDayResourceSoak.test.js"]);
const files = readdirSync(testRoot)
  .filter((file) => file.endsWith(".test.js") && !soakFiles.has(file))
  .sort()
  .map((file) => path.join(testRoot, file));

if (files.length === 0) {
  throw new Error("No Jarvis main-process tests were found");
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: appRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
