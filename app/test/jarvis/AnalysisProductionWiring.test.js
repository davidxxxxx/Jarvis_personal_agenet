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
    /new JarvisRepository\(configuredDb,\s*\{[\s\S]*?log:\s*\(entry\)\s*=>[\s\S]*?"Jarvis repository deferred maintenance"[\s\S]*?createSafeJarvisRepositoryLogRecord\(entry\)/u
  );
  assert.match(
    source,
    /cloudCompositionFactory:[\s\S]*?repository,[\s\S]*?getApiKey:\s*\(\)\s*=>\s*environmentManager\.getMiniMaxKey\(\)[\s\S]*?governor,[\s\S]*?previewScheduler/u
  );
  assert.doesNotMatch(source, /cloudTransportEnabled:\s*false/u);
  assert.match(
    source,
    /jarvisAnalysisBudgetGuard\s*=\s*\{[\s\S]*?getStatus\(options\)[\s\S]*?jarvisProcessingLifecycle\.runtime\?\.analysisBudgetGuard[\s\S]*?setPolicy\(input\)[\s\S]*?jarvisProcessingLifecycle\.runtime\?\.analysisBudgetGuard/u
  );
  assert.match(
    source,
    /registerJarvisIpc\(\{[\s\S]*?analysisBudgetGuard:\s*jarvisAnalysisBudgetGuard/u
  );
  assert.match(source, /ANALYSIS_BUDGET_RUNTIME_UNAVAILABLE/u);
});

test("production repository diagnostics retain only allowlisted phase and error code", () => {
  const source = fs.readFileSync(path.join(appRoot, "main.js"), "utf8");
  const helperSource = source.match(
    /const SAFE_JARVIS_REPOSITORY_LOG_PHASES = new Set\([\s\S]*?function createSafeJarvisRepositoryLogRecord\([\s\S]*?\n\}/u
  )?.[0];
  assert.ok(helperSource, "production repository diagnostics need a pure safe-record adapter");
  const createRecord = Function(
    `"use strict";\n${helperSource}\nreturn createSafeJarvisRepositoryLogRecord;`
  )();
  const secret = "hf_test_token_redacted_not_real";
  const record = createRecord({
    phase: "activity_correction_participant_refresh",
    errorCode: secret,
    transcript: "private transcript",
    audio: Buffer.from("private audio"),
    displayName: "张三",
    filePath: "G:\\private\\recording.flac",
    apiKey: secret,
    embedding: [0.1, 0.2],
  });

  assert.deepEqual(record, {
    phase: "activity_correction_participant_refresh",
    errorCode: "PARTICIPANT_SNAPSHOT_REFRESH_FAILED",
  });
  assert.deepEqual(Object.keys(record).sort(), ["errorCode", "phase"]);
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(
    createRecord({ phase: "unsafe/phase", errorCode: "SQLITE_BUSY" }).phase,
    "repository_deferred"
  );
  assert.equal(
    createRecord({ phase: "unsafe/phase", errorCode: "SQLITE_BUSY" }).errorCode,
    "SQLITE_BUSY"
  );
});

test("MiniMax key IPC waits for secure persistence before reporting configured state", () => {
  const source = fs.readFileSync(
    path.join(appRoot, "src/jarvis/main/registerJarvisIpc.js"),
    "utf8"
  );
  assert.match(
    source,
    /ipcMain\.handle\(CHANNELS\.setMiniMaxKey,\s*async[\s\S]*?normalizeMiniMaxKeyInput\(args\[0\]\)[\s\S]*?await environmentManager\.saveMiniMaxKey\(key\)/u
  );
  assert.match(
    source,
    /ipcMain\.handle\(CHANNELS\.clearMiniMaxKey,\s*async[\s\S]*?await environmentManager\.clearMiniMaxKey\(\)/u
  );
});
