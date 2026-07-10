# Jarvis Capture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a Windows desktop build that manually records the microphone, transcribes locally in near real time, labels speakers, persists 60-second audio chunks and transcript evidence, supports pause/resume/end, and exposes the approved Today dashboard with an explicit tray recording state.

**Architecture:** Import OpenWhispr v1.7.4 under `app/` and preserve its local Whisper, diarization, speaker-profile, Electron, and tray infrastructure. Add an isolated `src/jarvis/` vertical slice: a separate `jarvis.db`, mic-only capture routing, a renderer state machine, and a Jarvis shell. Keep the existing OpenWhispr dictation code intact unless a named integration point must be extended.

**Tech Stack:** Electron 41, React 19, TypeScript 6, Zustand 5, better-sqlite3 12, whisper.cpp, sherpa-onnx diarization, Vitest, Node 24 test runner, electron-builder.

## Global Constraints

- Pin the upstream import to OpenWhispr tag `v1.7.4`, commit `0951d7c5c5f98455f265cc3ebb7096a382491ed2`.
- Preserve OpenWhispr and copied Minutes MIT license and copyright notices.
- Target Windows 10/11 x64; Node.js must be version 24 or newer.
- Capture only the selected microphone in this plan; no system-audio capture path may start.
- Persist microphone PCM as mono signed 16-bit little-endian WAV at 24 kHz, in chunks no longer than 60 seconds.
- The user must explicitly start recording; no startup, schedule, wake-word, or hidden recording behavior.
- Recording state must remain visible in both the main window and system tray.
- No API key or transcript body may be written to application logs.
- Use test-driven development and commit after every task.
- Design source: `docs/superpowers/specs/2026-07-10-jarvis-memory-assistant-design.md`.

## Locked File Structure

```text
app/
  main.js                              # Instantiate Jarvis main-process services
  preload.js                           # Expose narrow window.electronAPI.jarvis bridge
  electron-builder.json                # Jarvis identity and Windows artifacts
  package.json                         # Jarvis scripts and test dependencies
  src/
    AppRouter.jsx                      # Route control-panel window to JarvisShell
    helpers/
      ipcHandlers.js                   # Feed mic PCM into JarvisService in mic-only mode
      tray.js                          # Display and control Jarvis recording state
    stores/
      meetingRecordingStore.ts         # Add mic-only start option; retain upstream pipeline
    types/
      electron.ts                      # Type the Jarvis preload API
    jarvis/
      main/
        AudioChunkWriter.js            # Rotate atomic 24 kHz mono WAV chunks
        JarvisRepository.js            # Own jarvis.db and foundation schema
        JarvisService.js               # Session/audio/recovery orchestration
        registerJarvisIpc.js            # Register Jarvis IPC handlers
        retentionPolicy.js             # Disk and expiry rules
      renderer/
        JarvisShell.tsx                 # Approved A-layout shell and navigation
        TodayView.tsx                   # Live transcript and controls
        RecordingControls.tsx           # Start/pause/resume/end controls
        LiveTranscript.tsx              # Stable/partial transcript list
        SpeakerChip.tsx                 # Rename/mark-self interaction
        sessionMachine.ts               # Pure session-state reducer
        useJarvisRecording.ts            # Bind meeting store to Jarvis persistence
        jarvisStore.ts                  # Renderer queries and view state
      shared/
        contracts.js                    # Runtime validation and IPC channel constants
      types.ts                           # Renderer-visible domain types
  test/jarvis/                           # Node main-process tests; never packaged
  src/jarvis/renderer/__tests__/         # Vitest renderer tests
```

---

### Task 1: Import and Pin the OpenWhispr Base

**Files:**
- Create: `app/**` from OpenWhispr `v1.7.4`
- Create: `app/test/jarvis/productIdentity.test.js`
- Modify: `app/package.json`
- Modify: `app/electron-builder.json`
- Modify: `app/electron-builder.unsigned-win.json`
- Modify: `app/main.js`

**Interfaces:**
- Consumes: the root Jarvis Git repository and upstream tag `v1.7.4`.
- Produces: a buildable `app/` tree, `npm run test:jarvis`, and unsigned Windows build command `npm run build:win:unsigned`.

- [ ] **Step 1: Import the pinned upstream tree with history attribution**

Run from `G:\Jarvis`:

```powershell
git remote add openwhispr https://github.com/OpenWhispr/openwhispr.git
git fetch openwhispr tag v1.7.4
git subtree add --prefix=app openwhispr v1.7.4 --squash
git -C app rev-parse --is-inside-work-tree
```

Expected: subtree import succeeds; the final command prints `true` because `app` belongs to the root worktree.

- [ ] **Step 2: Install the pinned dependencies and verify the unmodified baseline**

Run:

```powershell
npm ci
node --test
npm run typecheck
```

Working directory: `G:\Jarvis\app`.

Expected: dependencies install, upstream Node tests pass, and TypeScript reports no errors. Record any upstream-only failure in the task notes before changing code; do not hide it by weakening tests.

- [ ] **Step 3: Write the failing product identity test**

Create `app/test/jarvis/productIdentity.test.js`:

```js
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
```

- [ ] **Step 4: Run the identity test and verify it fails**

Run:

```powershell
node --test test/jarvis/productIdentity.test.js
```

Expected: FAIL because the imported package is still named `open-whispr`.

- [ ] **Step 5: Apply the minimal Jarvis identity and scripts**

Update the named fields in `app/package.json`:

```json
{
  "name": "jarvis-memory-assistant",
  "productName": "Jarvis Memory",
  "version": "0.1.0",
  "description": "Local-first Windows conversation memory assistant",
  "scripts": {
    "test:main": "node --test",
    "test:renderer": "vitest run --config src/vitest.config.ts",
    "test:jarvis": "node --test \"test/jarvis/*.test.js\" && npm run test:renderer",
    "build:win:unsigned": "npm run prebuild:win && npm run build:renderer && electron-builder --win --config electron-builder.unsigned-win.json"
  }
}
```

Keep all imported scripts and dependencies, add these scripts without deleting upstream entries, and add these dev dependencies:

```json
{
  "@testing-library/jest-dom": "^6.9.1",
  "@testing-library/react": "^16.3.0",
  "jsdom": "^27.0.0",
  "vitest": "^3.2.4"
}
```

Update `app/electron-builder.json`:

```json
{
  "appId": "com.local.jarvis-memory",
  "productName": "Jarvis Memory",
  "protocols": { "name": "Jarvis Memory Protocol", "schemes": ["jarvis-memory"] },
  "directories": { "output": "dist" },
  "win": { "target": ["nsis", "portable"], "icon": "src/assets/icon.ico" },
  "publish": null
}
```

Preserve every existing `files`, `asarUnpack`, `extraResources`, platform, NSIS, and DMG entry. Set `win.azureSignOptions` to `null` in `app/electron-builder.unsigned-win.json`. Change `BASE_WINDOWS_APP_ID` in `app/main.js` to:

```js
const BASE_WINDOWS_APP_ID = "com.local.jarvis-memory";
```

- [ ] **Step 6: Install new test dependencies and run the identity and baseline checks**

Run:

```powershell
npm install
node --test test/jarvis/productIdentity.test.js
npm run typecheck
npm run build:renderer
```

Expected: identity test PASS, typecheck PASS, renderer build PASS.

- [ ] **Step 7: Commit the pinned base and identity**

```powershell
git add app
git commit -m "chore: import OpenWhispr base for Jarvis"
```

Expected: commit includes the subtree import plus Jarvis product metadata; no `.env`, model binary, or user-data file is staged.

---

### Task 2: Add the Session Repository and Narrow IPC Contract

**Files:**
- Create: `app/src/jarvis/shared/contracts.js`
- Create: `app/src/jarvis/types.ts`
- Create: `app/src/jarvis/main/JarvisRepository.js`
- Create: `app/src/jarvis/main/registerJarvisIpc.js`
- Create: `app/test/jarvis/JarvisRepository.test.js`
- Create: `app/test/jarvis/contracts.test.js`
- Modify: `app/main.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`
- Modify: `app/electron-builder.json`

**Interfaces:**
- Consumes: `better-sqlite3`, Electron `ipcMain`, and `app.getPath("userData")`.
- Produces: `JarvisRepository`, `registerJarvisIpc({ ipcMain, repository })`, and `window.electronAPI.jarvis` methods for sessions, segments, people, and audio metadata.

- [ ] **Step 1: Write the failing repository tests**

Create `app/test/jarvis/JarvisRepository.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

test("session lifecycle and stable transcript upsert are idempotent", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: "mic-1" });
  repo.setSessionStatus("s1", "paused", 2000);
  const segment = {
    id: "seg-1",
    startedAt: 1100,
    endedAt: 1600,
    personId: "person-2",
    speakerLabel: "说话人 2",
    text: "周五之前给你测试反馈",
    confidence: 0.91,
    isStable: true,
  };
  repo.upsertTranscriptSegments("s1", [segment, segment]);

  const session = repo.getSession("s1");
  assert.equal(session.status, "paused");
  assert.equal(repo.listTranscriptSegments("s1").length, 1);
  assert.equal(repo.listTranscriptSegments("s1")[0].text, segment.text);
  repo.close();
});

test("renaming a person changes display metadata without rewriting transcript text", () => {
  const repo = new JarvisRepository(":memory:");
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.upsertTranscriptSegments("s1", [{
    id: "seg-1", startedAt: 1000, endedAt: 1200, personId: "p2",
    speakerLabel: "说话人 2", text: "你好", confidence: 0.8, isStable: true,
  }]);
  repo.renamePerson({ personId: "p2", displayName: "张三", isSelf: false });

  assert.equal(repo.listPeople()[0].display_name, "张三");
  assert.equal(repo.listTranscriptSegments("s1")[0].text, "你好");
  repo.close();
});
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run:

```powershell
node --test test/jarvis/JarvisRepository.test.js
```

Expected: FAIL with `Cannot find module '../../src/jarvis/main/JarvisRepository'`.

- [ ] **Step 3: Define the IPC channel contract**

Create `app/src/jarvis/shared/contracts.js`:

```js
const CHANNELS = Object.freeze({
  createSession: "jarvis:session:create",
  setSessionStatus: "jarvis:session:set-status",
  getSession: "jarvis:session:get",
  listSessions: "jarvis:session:list",
  upsertSegments: "jarvis:segments:upsert",
  listSegments: "jarvis:segments:list",
  renamePerson: "jarvis:person:rename",
  listPeople: "jarvis:person:list",
  listAudioChunks: "jarvis:audio:list",
  control: "jarvis:control",
  stateChanged: "jarvis:state-changed",
});

const SESSION_STATUSES = new Set([
  "recording", "paused", "finalizing", "completed", "recovered", "failed",
]);

function assertId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function assertSessionStatus(value) {
  if (!SESSION_STATUSES.has(value)) throw new TypeError("invalid session status");
  return value;
}

module.exports = { CHANNELS, SESSION_STATUSES, assertId, assertSessionStatus };
```

Create `app/test/jarvis/contracts.test.js` with exact validation expectations:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertId, assertSessionStatus } = require("../../src/jarvis/shared/contracts");

test("contract rejects path traversal and unknown states", () => {
  assert.throws(() => assertId("../secret", "sessionId"), /safe identifier/);
  assert.throws(() => assertSessionStatus("hidden-recording"), /invalid session status/);
  assert.equal(assertSessionStatus("recording"), "recording");
});
```

- [ ] **Step 4: Implement the foundation repository schema and methods**

Create `app/src/jarvis/main/JarvisRepository.js`. The constructor must accept a file path so tests can use `:memory:`. Initialize foreign keys, WAL for file-backed databases, and this schema in one transaction:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('recording','paused','finalizing','completed','recovered','failed')),
  mic_device_id TEXT,
  language TEXT NOT NULL DEFAULT 'zh',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  voice_profile_id INTEGER,
  voice_confidence REAL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  speaker_label TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  is_stable INTEGER NOT NULL,
  analysis_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS audio_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  transcription_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_segments_session_time
  ON transcript_segments(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_audio_expiry ON audio_chunks(expires_at);
```

Implement these exact public methods:

```js
createSession({ id, startedAt, micDeviceId, language = "zh" })
setSessionStatus(id, status, at = Date.now())
getSession(id)
listSessions({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 100 } = {})
upsertTranscriptSegments(sessionId, segments)
listTranscriptSegments(sessionId)
renamePerson({ personId, displayName, isSelf = false, voiceProfileId = null })
listPeople()
insertAudioChunk(chunk)
listAudioChunks(sessionId)
listExpiredAudioChunks(now = Date.now())
deleteAudioChunk(id)
recoverOpenSessions(at = Date.now())
close()
```

`upsertTranscriptSegments` must first `INSERT OR IGNORE` every non-null `personId` into `people` using the segment speaker label, then use `INSERT ... ON CONFLICT(id) DO UPDATE` for segment speaker metadata and text. `renamePerson` must reject an empty display name and clear `is_self` from other people when the new person is self.

- [ ] **Step 5: Run repository and contract tests**

Run:

```powershell
node --test test/jarvis/JarvisRepository.test.js test/jarvis/contracts.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Register IPC and expose a narrow preload surface**

Create `app/src/jarvis/main/registerJarvisIpc.js`:

```js
const { CHANNELS, assertId, assertSessionStatus } = require("../shared/contracts");

function registerJarvisIpc({ ipcMain, repository }) {
  ipcMain.handle(CHANNELS.createSession, (_event, input) => repository.createSession(input));
  ipcMain.handle(CHANNELS.setSessionStatus, (_event, id, status, at) =>
    repository.setSessionStatus(assertId(id, "sessionId"), assertSessionStatus(status), at)
  );
  ipcMain.handle(CHANNELS.getSession, (_event, id) =>
    repository.getSession(assertId(id, "sessionId"))
  );
  ipcMain.handle(CHANNELS.listSessions, (_event, query) => repository.listSessions(query));
  ipcMain.handle(CHANNELS.upsertSegments, (_event, sessionId, segments) =>
    repository.upsertTranscriptSegments(assertId(sessionId, "sessionId"), segments)
  );
  ipcMain.handle(CHANNELS.listSegments, (_event, sessionId) =>
    repository.listTranscriptSegments(assertId(sessionId, "sessionId"))
  );
  ipcMain.handle(CHANNELS.renamePerson, (_event, input) => repository.renamePerson(input));
  ipcMain.handle(CHANNELS.listPeople, () => repository.listPeople());
  ipcMain.handle(CHANNELS.listAudioChunks, (_event, sessionId) =>
    repository.listAudioChunks(assertId(sessionId, "sessionId"))
  );
}

module.exports = registerJarvisIpc;
```

In `app/main.js`, create the repository after Electron is ready and before the control panel loads:

```js
const JarvisRepository = require("./src/jarvis/main/JarvisRepository");
const registerJarvisIpc = require("./src/jarvis/main/registerJarvisIpc");

jarvisRepository = new JarvisRepository(path.join(app.getPath("userData"), "jarvis.db"));
registerJarvisIpc({ ipcMain, repository: jarvisRepository });
```

In `app/preload.js`, add a `jarvis` object inside the existing `electronAPI` exposure:

```js
jarvis: {
  createSession: (input) => ipcRenderer.invoke("jarvis:session:create", input),
  setSessionStatus: (id, status, at) =>
    ipcRenderer.invoke("jarvis:session:set-status", id, status, at),
  getSession: (id) => ipcRenderer.invoke("jarvis:session:get", id),
  listSessions: (query) => ipcRenderer.invoke("jarvis:session:list", query),
  upsertSegments: (sessionId, segments) =>
    ipcRenderer.invoke("jarvis:segments:upsert", sessionId, segments),
  listSegments: (sessionId) => ipcRenderer.invoke("jarvis:segments:list", sessionId),
  renamePerson: (input) => ipcRenderer.invoke("jarvis:person:rename", input),
  listPeople: () => ipcRenderer.invoke("jarvis:person:list"),
  listAudioChunks: (sessionId) => ipcRenderer.invoke("jarvis:audio:list", sessionId),
  onControl: registerListener("jarvis:control", (callback) => (_event, action) => callback(action)),
  onStateChanged: registerListener(
    "jarvis:state-changed",
    (callback) => (_event, state) => callback(state)
  ),
},
```

Add matching TypeScript types to `app/src/types/electron.ts` and domain types to `app/src/jarvis/types.ts`. Add `src/jarvis/**/*` to `electron-builder.json` `files`; do not package `test/jarvis`.

- [ ] **Step 7: Verify IPC types and renderer build**

Run:

```powershell
npm run typecheck
npm run build:renderer
node --test "test/jarvis/*.test.js"
```

Expected: typecheck PASS, renderer build PASS, repository/contract tests PASS.

- [ ] **Step 8: Commit the repository slice**

```powershell
git add app/main.js app/preload.js app/electron-builder.json app/src/types/electron.ts app/src/jarvis app/test/jarvis
git commit -m "feat: add Jarvis session repository and IPC"
```

---

### Task 3: Add Mic-Only Capture and Atomic Audio Chunks

**Files:**
- Create: `app/src/jarvis/main/AudioChunkWriter.js`
- Create: `app/src/jarvis/main/JarvisService.js`
- Create: `app/src/jarvis/main/meetingCaptureMode.js`
- Create: `app/src/jarvis/main/retentionPolicy.js`
- Create: `app/test/jarvis/AudioChunkWriter.test.js`
- Create: `app/test/jarvis/meetingCaptureMode.test.js`
- Modify: `app/main.js`
- Modify: `app/src/helpers/ipcHandlers.js`
- Modify: `app/src/stores/meetingRecordingStore.ts`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`

**Interfaces:**
- Consumes: 24 kHz mono PCM chunks emitted by `meetingRecordingStore`, `JarvisRepository`, and the upstream live speaker identifier.
- Produces: `JarvisService.startCapture`, `appendMicPcm`, `pauseCapture`, `resumeCapture`, `finishCapture`, plus mic-only meeting options `{ micOnly: true, jarvisSessionId }`.

- [ ] **Step 1: Write failing mic-mode and WAV chunk tests**

Create `app/test/jarvis/meetingCaptureMode.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMeetingCaptureMode } = require("../../src/jarvis/main/meetingCaptureMode");

test("Jarvis mic-only mode disables every system-audio strategy", () => {
  assert.deepEqual(resolveMeetingCaptureMode({ micOnly: true }), {
    micOnly: true,
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
});
```

Create `app/test/jarvis/AudioChunkWriter.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AudioChunkWriter = require("../../src/jarvis/main/AudioChunkWriter");

test("rotates valid WAV files atomically and reports metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wav-"));
  const completed = [];
  const writer = new AudioChunkWriter({
    sessionId: "s1", baseDir: dir, sampleRate: 24000, chunkSeconds: 0.1,
    now: () => 1000, onChunk: (chunk) => completed.push(chunk),
  });
  writer.append(Buffer.alloc(24000 * 2 * 0.15, 1));
  writer.close(1200);

  assert.equal(completed.length, 2);
  assert.equal(fs.readFileSync(completed[0].path, { encoding: "ascii", flag: "r" }).slice(0, 4), "RIFF");
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".part")), false);
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```powershell
node --test test/jarvis/meetingCaptureMode.test.js test/jarvis/AudioChunkWriter.test.js
```

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement capture-mode and disk policy helpers**

Create `app/src/jarvis/main/meetingCaptureMode.js`:

```js
function resolveMeetingCaptureMode(options = {}, upstream = {}) {
  if (options.micOnly === true) {
    return { micOnly: true, systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
  }
  return {
    micOnly: false,
    systemAudioMode: upstream.systemAudioMode || "unsupported",
    systemAudioStrategy: upstream.systemAudioStrategy || "unsupported",
  };
}
module.exports = { resolveMeetingCaptureMode };
```

Create `app/src/jarvis/main/retentionPolicy.js`:

```js
const MIN_FREE_BYTES = 5 * 1024 ** 3;
function requiredFreeBytes(totalBytes) {
  return Math.max(MIN_FREE_BYTES, Math.floor(totalBytes * 0.05));
}
function hasSafeDiskSpace({ freeBytes, totalBytes }) {
  return freeBytes >= requiredFreeBytes(totalBytes);
}
module.exports = { MIN_FREE_BYTES, requiredFreeBytes, hasSafeDiskSpace };
```

- [ ] **Step 4: Implement `AudioChunkWriter`**

`AudioChunkWriter` must:

- accept 16-bit little-endian mono PCM;
- rotate after `sampleRate * 2 * chunkSeconds` bytes;
- write a 44-byte PCM WAV header;
- write `${chunkId}.wav.part`, `fsync`, then rename to `${chunkId}.wav`;
- calculate SHA-256 and call `onChunk({ id, sessionId, path, startedAt, endedAt, durationMs, sha256 })`;
- retain leftover bytes for the next chunk;
- never emit an empty file.

Use this exact WAV header function inside `app/src/jarvis/main/AudioChunkWriter.js`:

```js
function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
```

- [ ] **Step 5: Run WAV and policy tests**

Add assertions for the 5 GB / 5% rule to `meetingCaptureMode.test.js`, then run:

```powershell
node --test test/jarvis/meetingCaptureMode.test.js test/jarvis/AudioChunkWriter.test.js
```

Expected: PASS; emitted files have RIFF headers and no `.part` files remain.

- [ ] **Step 6: Implement `JarvisService` and wire it into main**

Create `app/src/jarvis/main/JarvisService.js` with this public interface:

```js
class JarvisService {
  constructor({ repository, userDataDir, broadcast, now = Date.now })
  startCapture({ sessionId, startedAt, micDeviceId })
  appendMicPcm(sessionId, pcmBuffer)
  pauseCapture(sessionId, at)
  resumeCapture(sessionId, at)
  finishCapture(sessionId, at)
  failCapture(sessionId, code, at)
  recoverOpenSessions(at)
  getState()
  shutdown()
}
```

`startCapture` creates `recordings/<sessionId>/`, constructs `AudioChunkWriter`, and stores every completed chunk with `expiresAt = endedAt + 7 * 86400000`. `appendMicPcm` rejects a session mismatch. `pauseCapture` closes the current chunk so wall-clock pause time is never counted as audio duration; `resumeCapture` constructs a new writer for the same session. `finishCapture` closes the writer before marking the session `completed`. `broadcast` receives `{ sessionId, status, startedAt, elapsedMs, errorCode }` and must not receive transcript text.

Instantiate the service in `app/main.js` and pass it into `IPCHandlers`:

```js
jarvisService = new JarvisService({
  repository: jarvisRepository,
  userDataDir: app.getPath("userData"),
  broadcast: (state) => windowManager?.sendToControlPanel("jarvis:state-changed", state),
});
jarvisService.recoverOpenSessions(Date.now());
```

- [ ] **Step 7: Extend the upstream meeting pipeline with a mic-only option**

Add these fields to `StartRecordingArgs` in `app/src/stores/meetingRecordingStore.ts`:

```ts
captureSystemAudio?: boolean;
jarvisSessionId?: string | null;
```

When `captureSystemAudio === false`:

```ts
const systemAudioAccessPromise = Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS);
const systemCapturePromise = Promise.resolve({ stream: null, error: null });
```

Pass the exact flags to main:

```ts
window.electronAPI?.meetingTranscriptionStart?.({
  ...getMeetingTranscriptionOptions(),
  noteId: args.noteId ?? null,
  micOnly: args.captureSystemAudio === false,
  jarvisSessionId: args.jarvisSessionId ?? null,
});
```

In `app/src/helpers/ipcHandlers.js`:

- store `this.jarvisService = managers.jarvisService`;
- when `options.micOnly`, bypass `getMeetingSystemAudioPlan()` and every system-audio manager;
- remember `activeJarvisSessionId` for the current meeting pipeline;
- in the mic branch of `sendMeetingAudio`, call `jarvisService.appendMicPcm(activeJarvisSessionId, outboundBuffer)` before dispatching to local transcription;
- when mic-only, feed the mic buffer to `liveSpeakerIdentifier` and to the diarization PCM stream;
- never feed the same mic buffer twice;
- on stop, close the Jarvis writer only when renderer requests `finish`, not on a pause.

Use `resolveMeetingCaptureMode(options, upstreamPlan)` instead of branching in multiple places.

- [ ] **Step 8: Add capture IPC commands and verify main tests**

Change the factory signature to `registerJarvisIpc({ ipcMain, repository, service })` and extend it with:

```js
ipcMain.handle("jarvis:capture:start", (_event, input) => service.startCapture(input));
ipcMain.handle("jarvis:capture:pause", (_event, id, at) => service.pauseCapture(id, at));
ipcMain.handle("jarvis:capture:resume", (_event, id, at) => service.resumeCapture(id, at));
ipcMain.handle("jarvis:capture:finish", (_event, id, at) => service.finishCapture(id, at));
```

Expose the four methods under `window.electronAPI.jarvis`. Then run:

```powershell
node --test "test/jarvis/*.test.js"
npm run typecheck
npm run build:renderer
```

Expected: all Jarvis tests PASS, upstream typecheck PASS, renderer build PASS.

- [ ] **Step 9: Commit mic-only capture**

```powershell
git add app/main.js app/preload.js app/src/helpers/ipcHandlers.js app/src/stores/meetingRecordingStore.ts app/src/types/electron.ts app/src/jarvis app/test/jarvis
git commit -m "feat: add mic-only capture and audio chunking"
```

---

### Task 4: Add the Renderer Session State Machine and Persistence Bridge

**Files:**
- Create: `app/src/jarvis/renderer/sessionMachine.ts`
- Create: `app/src/jarvis/renderer/jarvisStore.ts`
- Create: `app/src/jarvis/renderer/useJarvisRecording.ts`
- Create: `app/src/jarvis/renderer/__tests__/sessionMachine.test.ts`
- Create: `app/src/vitest.config.ts`
- Create: `app/src/vitest.setup.ts`
- Modify: `app/src/stores/meetingRecordingStore.ts`

**Interfaces:**
- Consumes: `window.electronAPI.jarvis`, upstream `startRecording`, `stopRecording`, and `useMeetingRecordingStore`.
- Produces: `useJarvisRecording()` with `start`, `pause`, `resume`, `finish`, `renameSpeaker`, session state, segments, partial text, mic level, and error.

- [ ] **Step 1: Configure renderer tests and write the failing state-machine test**

Create `app/src/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./vitest.setup.ts"] },
});
```

Create `app/src/vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Create `app/src/jarvis/renderer/__tests__/sessionMachine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialSessionState, reduceSession } from "../sessionMachine";

describe("Jarvis session machine", () => {
  it("keeps one session id across pause and resume", () => {
    const recording = reduceSession(initialSessionState, { type: "STARTED", id: "s1", at: 1000 });
    const paused = reduceSession(recording, { type: "PAUSED", at: 2000 });
    const resumed = reduceSession(paused, { type: "RESUMED", at: 3000 });
    expect(resumed).toMatchObject({ id: "s1", status: "recording", accumulatedMs: 1000 });
  });

  it("rejects impossible transitions", () => {
    expect(() => reduceSession(initialSessionState, { type: "FINISHED", at: 1000 }))
      .toThrow("cannot finish from idle");
  });
});
```

- [ ] **Step 2: Run the renderer test and verify it fails**

Run:

```powershell
npm run test:renderer -- src/jarvis/renderer/__tests__/sessionMachine.test.ts
```

Expected: FAIL because `sessionMachine.ts` does not exist.

- [ ] **Step 3: Implement the pure state machine**

Create `sessionMachine.ts` with states `idle | starting | recording | paused | finalizing | completed | failed`. Export:

```ts
export type SessionState = {
  id: string | null;
  status: "idle" | "starting" | "recording" | "paused" | "finalizing" | "completed" | "failed";
  startedAt: number | null;
  activeSince: number | null;
  accumulatedMs: number;
  errorCode: string | null;
};

export const initialSessionState: SessionState = {
  id: null, status: "idle", startedAt: null, activeSince: null, accumulatedMs: 0, errorCode: null,
};

export function reduceSession(state: SessionState, event: SessionEvent): SessionState
```

On pause, add `at - activeSince` to `accumulatedMs`. Resume preserves `id`. Finish is allowed only from `recording` or `paused` and enters `finalizing`; `COMPLETED` then enters `completed`.

- [ ] **Step 4: Run state-machine tests**

Run:

```powershell
npm run test:renderer -- src/jarvis/renderer/__tests__/sessionMachine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement `jarvisStore` and `useJarvisRecording`**

`jarvisStore.ts` must hold the session state, persisted sessions, people, and the selected view. `useJarvisRecording.ts` must execute this exact sequence:

```ts
start:
  create UUID session id
  jarvis.createSession(...)
  jarvis.startCapture(...)
  startRecording({ noteId: null, noteTitle: "今日记录", folderId: null,
                   captureSystemAudio: false, jarvisSessionId: id,
                   diarizationEnabled: true })

pause:
  stopRecording()
  jarvis.pauseCapture(id, Date.now())

resume:
  jarvis.resumeCapture(id, Date.now())
  startRecording({ ..., seedSegments: currentSegments,
                   captureSystemAudio: false, jarvisSessionId: id })

finish:
  if recording, stopRecording()
  persist stable segments
  jarvis.finishCapture(id, Date.now())
```

Subscribe to `useMeetingRecordingStore` and debounce stable segment persistence by 500 ms. Map upstream segments to foundation fields without persisting partial text. Use deterministic `id`, timestamp, speaker, speakerName, and text; assign `confidence=0.5` only when upstream gives no confidence, and set such entries for later confirmation.

- [ ] **Step 6: Add hook tests with mocked APIs**

Create a dependency-injected controller factory inside `useJarvisRecording.ts`:

```ts
export function createRecordingController(deps: RecordingDependencies): RecordingController
```

Test in `recordingController.test.ts` that:

- start passes `captureSystemAudio:false`;
- pause calls upstream stop before main-process pause;
- resume reuses the same session ID and seeds current segments;
- finish persists stable segments before finishing the capture.

Run:

```powershell
npm run test:renderer -- src/jarvis/renderer/__tests__/recordingController.test.ts
```

Expected: PASS with call order assertions.

- [ ] **Step 7: Run all foundation checks and commit**

```powershell
npm run test:jarvis
npm run typecheck
npm run build:renderer
git add app/src/jarvis/renderer app/src/vitest.config.ts app/src/vitest.setup.ts app/src/stores/meetingRecordingStore.ts app/package.json app/package-lock.json
git commit -m "feat: add Jarvis recording session controller"
```

---

### Task 5: Build the Approved Today Dashboard and Speaker Correction

**Files:**
- Create: `app/src/jarvis/renderer/JarvisShell.tsx`
- Create: `app/src/jarvis/renderer/TodayView.tsx`
- Create: `app/src/jarvis/renderer/RecordingControls.tsx`
- Create: `app/src/jarvis/renderer/LiveTranscript.tsx`
- Create: `app/src/jarvis/renderer/SpeakerChip.tsx`
- Create: `app/src/jarvis/renderer/FirstUseConsentDialog.tsx`
- Create: `app/src/jarvis/main/VoiceEnrollmentService.js`
- Create: `app/src/jarvis/renderer/VoiceEnrollment.tsx`
- Create: `app/test/jarvis/VoiceEnrollmentService.test.js`
- Create: `app/src/jarvis/renderer/__tests__/JarvisShell.test.tsx`
- Create: `app/src/jarvis/renderer/__tests__/SpeakerChip.test.tsx`
- Create: `app/src/jarvis/renderer/__tests__/FirstUseConsentDialog.test.tsx`
- Modify: `app/src/AppRouter.jsx`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`

**Interfaces:**
- Consumes: `useJarvisRecording`, `jarvisStore`, and `window.electronAPI.jarvis.renamePerson`.
- Produces: the approved A-layout, visible recording state, live transcript, and local speaker rename/mark-self operations.

- [ ] **Step 1: Write failing shell and speaker tests**

Create `JarvisShell.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import JarvisShell from "../JarvisShell";

vi.mock("../useJarvisRecording", () => ({
  useJarvisRecording: () => ({
    session: { status: "recording", id: "s1", accumulatedMs: 42000 },
    segments: [{ id: "seg1", text: "下一版先把支付流程跑通", speaker: "self", speakerName: "我", timestamp: 1000 }],
    partialText: "", micLevel: 0.4, start: vi.fn(), pause: vi.fn(), resume: vi.fn(), finish: vi.fn(),
  }),
}));

import i18n from "../../../i18n";
void i18n.changeLanguage("zh-CN");

describe("JarvisShell", () => {
  it("shows the approved Today command-center hierarchy", () => {
    render(<JarvisShell />);
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("实时对话")).toBeInTheDocument();
    expect(screen.getByText("正在监听")).toBeInTheDocument();
    expect(screen.getByText("当前主题")).toBeInTheDocument();
    expect(screen.getByText("AI 建议")).toBeInTheDocument();
  });
});
```

Create `SpeakerChip.test.tsx` to render `说话人 2`, open the rename popover, enter `张三`, submit, and assert `renamePerson({ personId:"p2", displayName:"张三", isSelf:false })` was called once.

- [ ] **Step 2: Run UI tests and verify they fail**

Run:

```powershell
npm run test:renderer -- src/jarvis/renderer/__tests__/JarvisShell.test.tsx src/jarvis/renderer/__tests__/SpeakerChip.test.tsx
```

Expected: FAIL because the components are missing.

- [ ] **Step 3: Implement `JarvisShell` and `TodayView`**

Use a three-column desktop grid:

```tsx
<div className="h-screen grid grid-cols-[176px_minmax(420px,1fr)_320px] bg-background">
  <JarvisNavigation items={["today", "people", "topics", "todos", "memory"]} />
  <main className="min-w-0 flex flex-col">
    <RecordingControls />
    <LiveTranscript />
  </main>
  <aside className="border-l border-border/40 p-4 space-y-3">
    <InsightCard title={t("jarvis.currentTopic")} state="empty" />
    <InsightCard title={t("jarvis.newTodos")} state="empty" />
    <InsightCard title={t("jarvis.aiAdvice")} state="empty" />
  </aside>
</div>
```

For this foundation plan, right-column cards show `等待首次分析` and do not call a cloud model. RecordingControls must display microphone name, elapsed active recording time, mic level, and one primary action appropriate to state.

Before the first recording, `FirstUseConsentDialog` must block the start action until the user checks `我确认仅在有权录音并已履行必要告知的场景中使用`. Persist consent as `jarvisRecordingConsentVersion=1` in local storage. The dialog must not contain an option to hide tray or window recording indicators. Test that start remains disabled before consent and proceeds once after consent.

- [ ] **Step 4: Implement live transcript and speaker correction**

`LiveTranscript.tsx` must:

- render stable segments in timestamp order;
- show partial text with reduced opacity and `aria-label="临时转写"`;
- keep the latest segment visible without stealing keyboard focus;
- expose `SpeakerChip` only for stable segments;
- show `待确认` when confidence is below 0.65.

`SpeakerChip.tsx` must support rename and “标记为我”. On success, call upstream `lockSpeaker` for current-session labels and `jarvis.renamePerson` for persistent local metadata.

- [ ] **Step 5: Route the control-panel window directly to Jarvis**

In `AppRouter.jsx`, lazy-load `JarvisShell` and, when `isControlPanel`, render it before OpenWhispr authentication/onboarding checks:

```jsx
const JarvisShell = React.lazy(() => import("./jarvis/renderer/JarvisShell.tsx"));

if (isControlPanel) {
  return (
    <Suspense fallback={<LoadingFallback message="正在启动 Jarvis…" />}>
      <JarvisShell />
    </Suspense>
  );
}
```

Keep dictation and agent windows unchanged. Do not start OpenWhispr cloud sync from the Jarvis control-panel route.

Until the intelligence plan lands, show People, Topics, Todos, and Memory navigation items as disabled with the explicit label `完成首次分析后启用`; clicking them must not change the active view.

- [ ] **Step 6: Add the 30-second self-voice enrollment flow**

Create `VoiceEnrollmentService` with injected `speakerEmbeddings`, imported OpenWhispr `databaseManager`, and `JarvisRepository`. It accepts three non-overlapping speech sample windows totaling at least 24 seconds from a 30-second guided recording, extracts one embedding per window, computes the centroid, and calls:

```js
const profile = databaseManager.upsertSpeakerProfile(
  "我",
  null,
  Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength)
);
repository.renamePerson({
  personId: "self",
  displayName: "我",
  isSelf: true,
  voiceProfileId: profile.id,
});
```

The renderer `VoiceEnrollment.tsx` must show a 30-second countdown, a visible audio-level meter, start/cancel/save controls, and the text `请独自朗读，避免其他人同时说话`. Reuse the mic PCM AudioWorklet pattern at 16 kHz and send samples only to the local main-process enrollment IPC; never persist this calibration recording as a normal session audio chunk.

Write `VoiceEnrollmentService.test.js` with three deterministic embeddings and assert their centroid is saved once, the `self` person points to the created profile, and fewer than three valid samples is rejected.

- [ ] **Step 7: Add locale keys to every supported locale**

Add a `jarvis` object with the same key set to all supported translation files: `en`, `de`, `es`, `fr`, `it`, `ja`, `pt`, `ru`, `zh-CN`, and `zh-TW`. Use accurate Simplified Chinese in `zh-CN`, accurate English in `en`, and English fallback values in other locales when a reviewed translation is unavailable. The object includes:

```json
{
  "today": "今天",
  "people": "人物",
  "topics": "主题",
  "todos": "待办",
  "memory": "记忆库",
  "liveConversation": "实时对话",
  "listening": "正在监听",
  "paused": "已暂停",
  "currentTopic": "当前主题",
  "newTodos": "新待办",
  "aiAdvice": "AI 建议",
  "waitingForAnalysis": "等待首次分析",
  "start": "开始监听",
  "pause": "暂停",
  "resume": "继续",
  "finish": "结束并总结"
}
```

Add `voiceEnrollment`, `voiceEnrollmentInstruction`, `voiceEnrollmentStart`, `voiceEnrollmentCancel`, and `voiceEnrollmentSave` to the same object in every locale.

- [ ] **Step 8: Run UI, enrollment, type, and build checks**

```powershell
npm run test:renderer
node --test test/jarvis/VoiceEnrollmentService.test.js
npm run typecheck
npm run i18n:check
npm run build:renderer
```

Expected: UI tests PASS, typecheck PASS, i18n check PASS, build PASS.

- [ ] **Step 9: Commit the Today dashboard and enrollment**

```powershell
git add app/src/AppRouter.jsx app/src/jarvis app/test/jarvis/VoiceEnrollmentService.test.js app/src/locales
git commit -m "feat: add Jarvis Today dashboard"
```

---

### Task 6: Add Tray Controls, Recovery, Retention, and a Windows Foundation Build

**Files:**
- Create: `app/src/jarvis/main/RetentionCleaner.js`
- Create: `app/test/jarvis/RetentionCleaner.test.js`
- Create: `app/test/jarvis/JarvisRecovery.test.js`
- Modify: `app/src/helpers/tray.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/main.js`
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`

**Interfaces:**
- Consumes: repository expiry queries, JarvisService state broadcasts, and the control-panel renderer.
- Produces: daily retention cleanup, crash recovery, tray start/pause/resume/end commands, disk safety stops, and an unsigned Windows installer/portable build.

- [ ] **Step 1: Write failing retention and recovery tests**

Create `RetentionCleaner.test.js` with a temp recording file and in-memory repository. Insert one expired chunk and one future chunk, run `clean(now)`, then assert the expired file and row are gone while the future pair remains. Add a deletion-failure case that leaves the row for retry.

Create `JarvisRecovery.test.js`:

```js
test("startup marks interrupted recording sessions recovered", () => {
  const repo = makeRepository();
  repo.createSession({ id: "s1", startedAt: 1000, micDeviceId: null });
  repo.setSessionStatus("s1", "recording", 1000);
  const recovered = repo.recoverOpenSessions(5000);
  assert.deepEqual(recovered.map((row) => row.id), ["s1"]);
  assert.equal(repo.getSession("s1").status, "recovered");
});
```

- [ ] **Step 2: Run tests and verify the retention test fails**

```powershell
node --test test/jarvis/RetentionCleaner.test.js test/jarvis/JarvisRecovery.test.js
```

Expected: recovery may pass from Task 2; retention FAIL because `RetentionCleaner` is missing.

- [ ] **Step 3: Implement `RetentionCleaner`**

Create a class with injected repository, filesystem, and clock:

```js
class RetentionCleaner {
  constructor({ repository, fsImpl = require("node:fs"), now = Date.now })
  clean(at = this.now())
  start(intervalMs = 24 * 60 * 60 * 1000)
  stop()
}
```

`clean` processes `repository.listExpiredAudioChunks(at)` in order. Delete the file first and the database row second. Treat `ENOENT` as already deleted; leave the database row on any other error. Return `{ deleted, retry, missing }` counts and log counts only.

- [ ] **Step 4: Add tray state and commands**

Extend `TrayManager` with:

```js
setJarvisState(state) {
  this.jarvisState = state;
  this.updateTrayMenu();
}
```

When status is `recording`, tooltip must be `Jarvis Memory · 正在监听` and the menu must contain `暂停` and `结束并总结`. When paused, show `继续` and `结束并总结`. When idle/completed, show `开始监听`. Each click sends `jarvis:control` with exactly one of `start | pause | resume | finish` to the control-panel window; tray commands do not manipulate audio directly.

Subscribe `JarvisService` state changes in `main.js` and call `trayManager?.setJarvisState(state)`. In the renderer hook, subscribe to `jarvis.onControl` and call the matching controller method.

- [ ] **Step 5: Enforce recovery and disk safety**

At startup:

```js
const recovered = jarvisService.recoverOpenSessions(Date.now());
retentionCleaner.clean(Date.now());
retentionCleaner.start();
```

Before creating each new audio chunk, check free space with `fs.statfsSync(recordingsDir)` and `hasSafeDiskSpace`. If unsafe, close the current chunk, mark the session failed with `DISK_SPACE_LOW`, and broadcast without transcript content. On app shutdown, stop the cleaner and close the current writer before closing the repository.

Subscribe to the active microphone track's `ended` event and the imported `micTrackHealth` result. Permission denial maps to `MIC_PERMISSION`; a track that ends or cannot recover maps to `MIC_DISCONNECTED`. In both cases call `pauseCapture`, stop the upstream meeting pipeline, retain completed chunks, and show the error in window and tray. Never continue with system audio as fallback in Jarvis mic-only mode.

- [ ] **Step 6: Run the full automated foundation suite**

```powershell
npm run test:jarvis
npm run typecheck
npm run i18n:check
npm run build:renderer
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 7: Run the desktop smoke test**

Run:

```powershell
npm run dev
```

Manual evidence required:

1. Jarvis control panel opens without OpenWhispr sign-in.
2. Clicking start uses only the selected microphone; no screen/system-audio permission appears.
3. Tray and header show red recording state.
4. Chinese speech appears as stable local transcript within the target 5 seconds.
5. Pause creates no new audio, resume keeps the same session, and finish closes the last WAV.
6. `jarvis.db` contains one session and source-linked transcript segments.
7. `recordings/<sessionId>/` contains WAV chunks no longer than 60 seconds.

Stop the dev process cleanly after capturing evidence.

- [ ] **Step 8: Build unsigned Windows artifacts**

Run:

```powershell
npm run build:win:unsigned
Get-ChildItem dist -File | Select-Object Name,Length
```

Expected: an NSIS installer and a portable `.exe` exist. Launch the portable build once and repeat start/pause/resume/finish with a 30-second sample.

- [ ] **Step 9: Commit the completed foundation**

```powershell
git add app
git commit -m "feat: complete Jarvis capture foundation"
git status --short
```

Expected: commit succeeds and status is clean. Do not commit `app/dist`, `app/recordings`, model files, logs, `.env`, or user databases.

## Foundation Completion Gate

Do not begin the intelligence plan until all of these are true:

- `npm run test:jarvis`, `typecheck`, `i18n:check`, `build:renderer`, and `lint` pass.
- A real microphone recording produces local Chinese transcript and speaker labels.
- Start/pause/resume/end and tray visibility work without system-audio capture.
- WAV chunks and `jarvis.db` survive an app restart.
- An unsigned Windows portable build launches on the target machine.
