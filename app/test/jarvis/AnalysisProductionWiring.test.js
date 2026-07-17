const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "../..");

test("production main builds guarded MiniMax workers for each repository runtime epoch", () => {
  const source = fs.readFileSync(path.join(appRoot, "main.js"), "utf8");

  assert.match(source, /const AnalysisInputBuilder = require\(/u);
  assert.match(source, /createProductionAgentCloudComposition/u);
  assert.match(
    source,
    /new JarvisRepository\(configuredDb,\s*\{[\s\S]*?validateRedactedCloudPayload:[\s\S]*?verifyRedactedCloudPayload/u
  );
  assert.match(
    source,
    /cloudCompositionFactory:[\s\S]*?repository,[\s\S]*?getApiKey:\s*\(\)\s*=>\s*environmentManager\.getMiniMaxKey\(\)[\s\S]*?governor,[\s\S]*?previewScheduler/u
  );
  assert.doesNotMatch(source, /cloudTransportEnabled:\s*false/u);
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
