const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "../..");

test("renderer mic-only start bypasses system access and forwards Jarvis identity", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/stores/meetingRecordingStore.ts"), "utf8");

  assert.match(source, /captureSystemAudio\?: boolean/);
  assert.match(source, /jarvisSessionId\?: string \| null/);
  assert.match(
    source,
    /args\.captureSystemAudio === false\s*\? Promise\.resolve\(DEFAULT_SYSTEM_AUDIO_ACCESS\)/
  );
  assert.match(source, /micOnly: args\.captureSystemAudio === false/);
  assert.match(source, /jarvisSessionId: args\.jarvisSessionId \?\? null/);
  assert.match(
    source,
    /hasExactDevice[\s\S]*?args\.captureSystemAudio === false[\s\S]*?return null/
  );
  assert.match(source, /import \{ reacquireIfDead \} from "\.\.\/helpers\/micTrackHealth"/);
  assert.match(source, /await reacquireIfDead\(/);
  assert.match(source, /addEventListener\("ended"/);
  assert.match(source, /MIC_PERMISSION/);
  assert.match(source, /MIC_DISCONNECTED/);
});

test("main mic-only route uses the resolved mode and never finalizes Jarvis on meeting stop", () => {
  const source = fs.readFileSync(path.join(appRoot, "src/helpers/ipcHandlers.js"), "utf8");

  assert.match(source, /resolveMeetingCaptureModeWithPlan/);
  assert.match(source, /routeMicOnlyPcm/);
  assert.match(source, /activeJarvisSessionId/);
  assert.match(
    source,
    /const startMeetingSystemAudio[\s\S]*?if \(captureMode\.micOnly\)[\s\S]*?systemAudioMode: "unsupported"/
  );
  assert.match(source, /if \(activeMeetingCaptureMode\.micOnly\) return/);
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
