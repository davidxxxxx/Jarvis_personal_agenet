const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "../..");

test("production main keeps MiniMax analysis transport unreachable until guarded runtime lands", () => {
  const source = fs.readFileSync(path.join(appRoot, "main.js"), "utf8");

  assert.doesNotMatch(source, /require\("\.\/src\/jarvis\/main\/MiniMaxAnalysisClient"\)/u);
  assert.doesNotMatch(source, /new MiniMaxAnalysisClient\s*\(/u);
  assert.match(source, /const AnalysisInputBuilder = require\(/u);
  assert.match(
    source,
    /new JarvisRepository\(configuredDb,\s*\{[\s\S]*?validateRedactedCloudPayload:[\s\S]*?verifyRedactedCloudPayload/u
  );
  assert.match(
    source,
    /new AnalysisScheduler\(\{[\s\S]*?cloudTransportEnabled:\s*false[\s\S]*?\}\)/u
  );
});

test("MiniMax key IPC waits for secure persistence before reporting configured state", () => {
  const source = fs.readFileSync(
    path.join(appRoot, "src/jarvis/main/registerJarvisIpc.js"),
    "utf8"
  );
  assert.match(
    source,
    /ipcMain\.handle\(CHANNELS\.setMiniMaxKey,\s*async[\s\S]*?await environmentManager\.saveMiniMaxKey\(key\.trim\(\)\)/u
  );
});
