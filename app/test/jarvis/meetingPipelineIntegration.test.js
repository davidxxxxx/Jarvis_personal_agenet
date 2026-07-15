const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { routeJarvisPcm } = require("../../src/jarvis/main/meetingCaptureMode");

const appRoot = path.resolve(__dirname, "../..");

test("production routing persists exact mic and system PCM before derived consumers", () => {
  for (const sourceType of ["mic", "system"]) {
    const calls = [];
    const pcm = Buffer.from(sourceType === "mic" ? [1, 2, 3, 4] : [5, 6, 7, 8]);

    const accepted = routeJarvisPcm({
      sessionId: "session-integration",
      sourceType,
      pcmBuffer: pcm,
      appendPcm(sessionId, persistedSource, persistedPcm) {
        calls.push({
          kind: "persist",
          sessionId,
          sourceType: persistedSource,
          pcm: Buffer.from(persistedPcm),
        });
        return true;
      },
      afterPersist(derivedPcm, persistedSource) {
        calls.push({
          kind: "derived",
          sourceType: persistedSource,
          pcm: Buffer.from(derivedPcm),
        });
      },
    });

    assert.equal(accepted, true);
    assert.deepEqual(
      calls.map(({ kind, sourceType: source }) => [kind, source]),
      [
        ["persist", sourceType],
        ["derived", sourceType],
      ]
    );
    assert.equal(calls[0].sessionId, "session-integration");
    assert.deepEqual(calls[0].pcm, pcm);
    assert.deepEqual(calls[1].pcm, pcm);
  }
});

test("renderer mic-only start bypasses system access and forwards Jarvis identity", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/stores/meetingRecordingStore.ts"), "utf8");

  assert.match(source, /captureSystemAudio\?: boolean/);
  assert.match(source, /captureMicrophone\?: boolean/);
  assert.match(source, /requireAllSources\?: boolean/);
  assert.match(source, /jarvisSessionId\?: string \| null/);
  assert.match(source, /!captureSystemAudio\s*\? Promise\.resolve\(DEFAULT_SYSTEM_AUDIO_ACCESS\)/);
  assert.match(source, /micOnly,/);
  assert.match(
    source,
    /captureMicrophone\s*\? getMeetingMicConstraints\(args\.micDeviceIdOverride\)[\s\S]*?: Promise\.resolve\(null\)/
  );
  assert.match(source, /jarvisSessionId: args\.jarvisSessionId \?\? null/);
  assert.match(source, /hasExactDevice[\s\S]*?micOnly[\s\S]*?return null/);
  assert.match(source, /args\.requireAllSources && missingRequiredSource/);
  assert.match(source, /import \{ reacquireIfDead \} from "\.\.\/helpers\/micTrackHealth"/);
  assert.match(source, /await reacquireIfDead\(/);
  assert.match(source, /addEventListener\("ended"/);
  assert.match(source, /MIC_PERMISSION/);
  assert.match(source, /MIC_DISCONNECTED/);
});

test("main Jarvis route uses the resolved mode and never finalizes Jarvis on meeting stop", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");

  assert.match(source, /resolveMeetingCaptureModeWithPlan/);
  assert.match(source, /routeJarvisPcm/);
  assert.match(source, /activeJarvisSessionId/);
  assert.match(
    source,
    /const startMeetingSystemAudio[\s\S]*?if \(captureMode\.micOnly\)[\s\S]*?systemAudioMode: "unsupported"/
  );
  assert.match(
    source,
    /if \(source === "system" && activeMeetingCaptureMode\.micOnly\) return false/
  );
  assert.doesNotMatch(
    source,
    /ipcMain\.handle\("meeting-transcription-stop"[\s\S]*?jarvisService\.finishCapture/
  );
  assert.match(
    source,
    /diarizationSegments\.map\([\s\S]*?return \{ success: true, transcript, diarizationSessionId, finalSegments \}/,
    "main stop must return structured final segments after stream flush"
  );

  const meetingSection = source.slice(
    source.indexOf("let meetingTranscriptionStartInProgress"),
    source.indexOf("const startManagedMeetingSystemAudio")
  );
  assert.doesNotMatch(
    meetingSection,
    /text:\s*(?:pending\.text|latestSegment|text)\.slice/,
    "meeting recording must not log transcript bodies"
  );
});

test("main preserves an optional Jarvis identity for system and dual meeting capture", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");
  const startSection = source.slice(
    source.indexOf('ipcMain.handle("meeting-transcription-start"'),
    source.indexOf("const writeMeetingDiarizationPcm")
  );

  assert.match(
    startSection,
    /activeJarvisSessionId\s*=\s*captureMode\.micOnly\s*\|\|\s*options\.jarvisSessionId\s*!=\s*null\s*\?\s*assertId\(options\.jarvisSessionId,\s*"jarvisSessionId"\)\s*:\s*null/
  );
  assert.match(startSection, /if \(activeJarvisSessionId && !this\.jarvisService\)/);
});

test("main routes exact mic and system PCM once before every derived consumer", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");
  const sendSection = source.slice(
    source.indexOf("const sendMeetingAudio"),
    source.indexOf("const startManagedMeetingSystemAudio")
  );

  assert.equal((sendSection.match(/routeJarvisPcm\(/g) || []).length, 1);
  assert.equal((sendSection.match(/\.appendPcm\(/g) || []).length, 1);
  assert.doesNotMatch(sendSection, /appendMicPcm/);
  assert.match(sendSection, /return routeJarvisPcm\(\{/);
  assert.match(sendSection, /sourceType:\s*source/);
  assert.match(sendSection, /pcmBuffer:\s*outboundBuffer/);
  assert.match(
    sendSection,
    /appendPcm:\s*\(sessionId,\s*persistedSource,\s*buffer\)\s*=>\s*this\.jarvisService\.appendPcm\(sessionId,\s*persistedSource,\s*buffer\)/
  );
  assert.match(sendSection, /if \(persistedSource === "system"\)/);
  assert.match(sendSection, /if \(persistedSource === "mic"\)/);
  assert.match(
    sendSection,
    /const derivedBuffer = activeJarvisSessionId \? Buffer\.from\(buffer\) : buffer/
  );

  const routeIndex = sendSection.indexOf("return routeJarvisPcm");
  for (const derivedConsumer of [
    "recordSystemChunk",
    "processSystemBuffer",
    "processMeetingMicWithAec",
    "analyzeMicChunk",
    "feedAudio",
    "writeMeetingDiarizationPcm",
    "dispatchMeetingAudioBuffer",
  ]) {
    assert.ok(
      routeIndex < sendSection.indexOf(derivedConsumer),
      `${derivedConsumer} must be lexically contained after the evidence-first route`
    );
  }
});

test("Jarvis local mode uses stable bilingual windows with PCM overlap and quality confidence", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");

  assert.match(source, /buildBilingualPrompt/);
  assert.match(source, /classifyTranscriptQuality/);
  assert.match(source, /mergeOverlappingTranscript/);
  assert.match(source, /JARVIS_STABLE_WINDOW_MS/);
  assert.match(source, /JARVIS_OVERLAP_MS/);
  assert.match(source, /initialPrompt:\s*buildBilingualPrompt\(meetingLocalTranscript\)/);
  assert.match(source, /activeJarvisSessionId\s*\?\s*JARVIS_STABLE_WINDOW_MS\s*:\s*5000/);
  assert.match(source, /confidence:\s*quality\.suspicious\s*\?\s*0\.25\s*:\s*0\.8/);
});

test("suspicious Jarvis audio is corrected asynchronously without replacing local identity", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");

  assert.match(source, /openAiCorrectionService\s*\.maybeCorrect/);
  assert.match(source, /type:\s*"correction"/);
  assert.match(source, /originalText/);
  assert.match(source, /addTranscriptRevision/);
  assert.match(source, /correctionSessionId\s*!==\s*activeJarvisSessionId/);
});

test("renderer reacts to authoritative capture failures and active mic loss", () => {
  const source = fs.readFileSync(
    path.join(appRoot, "src/jarvis/renderer/useJarvisRecording.ts"),
    "utf8"
  );

  assert.match(source, /jarvis\.onStateChanged/);
  assert.match(source, /state\.status === "failed"/);
  assert.match(source, /stopRecording\(\{ throwOnError: false \}\)/);
  assert.match(source, /pauseForError\(upstreamError\)/);
});

test("renderer shared segment-id module is browser-native ESM for Vite development", () => {
  const sourcePath = path.join(appRoot, "src/jarvis/shared/segmentIds.ts");
  assert.equal(fs.existsSync(sourcePath), true);
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /export function createStableSegmentId/);
  assert.doesNotMatch(source, /module\.exports/);
});
