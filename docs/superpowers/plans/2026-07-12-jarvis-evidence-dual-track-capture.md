# Jarvis Evidence and Dual-Track Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a crash-recoverable evidence layer that records microphone and Windows system audio as independent tracks in one Jarvis session.

**Architecture:** Keep the existing OpenWhispr capture implementations, but make `JarvisService` the authoritative multi-track session coordinator. Every committed WAV chunk is registered in SQLite with a source, sequence, hash, gap history, and durable processing job; renderer state only reflects this authority.

**Tech Stack:** Electron 41, Node.js 24, React 19, TypeScript 6, Zustand, better-sqlite3 12, Node test runner, Vitest, Windows WASAPI Loopback with Chromium Loopback fallback.

## Global Constraints

- Windows 10/11 x64 is the release platform.
- Capture modes are exactly `mic`, `system`, and `dual`.
- System audio is off until the user explicitly selects it for a recording.
- Microphone and system audio remain separate 24 kHz mono PCM tracks and separate WAV chunks.
- Each WAV chunk is at most 60 seconds and is atomically committed with SHA-256 metadata.
- Runtime loss of one source cannot stop the other source.
- Automatic microphone recovery excludes Sonar, VoiceMeeter, Steam, and YY devices.
- Raw audio remains local and expires after 7 days; metadata tombstones remain.
- Do not change MiniMax analysis, speaker identity, or memory merging in this plan.

---

## File Structure

- Create `app/src/jarvis/main/JarvisMigrations.js`: idempotent schema/version migrations.
- Create `app/src/jarvis/main/CaptureEvidenceStore.js`: focused CRUD for tracks, gaps, chunks, and processing jobs.
- Create `app/src/jarvis/main/MultiTrackAudioWriter.js`: owns one `AudioChunkWriter` per source.
- Create `app/src/jarvis/shared/captureModes.js`: capture-mode and source validation shared by main tests and IPC.
- Create `app/src/jarvis/renderer/JarvisCaptureModeSelector.tsx`: explicit three-mode selector.
- Modify `app/src/jarvis/main/AudioChunkWriter.js`: include track/source/sequence metadata.
- Modify `app/src/jarvis/main/JarvisRepository.js`: run migrations and delegate evidence operations.
- Modify `app/src/jarvis/main/JarvisService.js`: coordinate multiple source tracks.
- Modify `app/src/jarvis/main/registerJarvisIpc.js`: validate capture mode and expose track status.
- Modify `app/src/jarvis/main/RetentionCleaner.js`: tombstone deleted audio instead of deleting evidence rows.
- Modify `app/src/jarvis/main/meetingCaptureMode.js`: route both Jarvis PCM sources.
- Modify `app/src/helpers/ipcHandlers.js`: persist mic and system PCM before transcription/AEC-derived processing.
- Modify `app/src/stores/meetingRecordingStore.ts`: start the requested mode without silent initial downgrade.
- Modify `app/src/jarvis/renderer/useJarvisRecording.ts`: pass capture mode and consume authoritative source state.
- Modify `app/src/jarvis/renderer/RecordingControls.tsx`: show MIC and PC independently.
- Modify `app/src/jarvis/renderer/jarvisStore.ts`: persist capture-mode choice and source states.
- Modify `app/src/jarvis/types.ts` and `app/src/types/electron.ts`: add public contracts.
- Modify `app/main.js`: wire migration backup and evidence store dependencies.

### Task 1: Add Idempotent Evidence Schema Migrations

**Files:**
- Create: `app/src/jarvis/main/JarvisMigrations.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js:23-188`
- Test: `app/test/jarvis/JarvisMigrations.test.js`

**Interfaces:**
- Produces: `applyJarvisMigrations(db, { now }): { fromVersion, toVersion }`
- Produces tables: `audio_tracks`, `audio_gaps`, `processing_jobs`
- Adds columns to `sessions`: `capture_mode`, `processing_state`, `timeline_version`, `finalized_at`, `ready_at`
- Adds columns to `audio_chunks`: `track_id`, `source_type`, `sequence_number`, `write_state`, `deleted_at`

- [ ] **Step 1: Write migration tests against both an empty DB and a legacy schema**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

test("creates dual-track evidence schema idempotently", () => {
  const db = new Database(":memory:");
  const first = applyJarvisMigrations(db, { now: () => 1000 });
  const second = applyJarvisMigrations(db, { now: () => 2000 });
  assert.deepEqual(first, { fromVersion: 0, toVersion: TARGET_VERSION });
  assert.deepEqual(second, { fromVersion: TARGET_VERSION, toVersion: TARGET_VERSION });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("audio_tracks"));
  assert.ok(tables.includes("audio_gaps"));
  assert.ok(tables.includes("processing_jobs"));
});

test("preserves legacy sessions and chunks", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL); CREATE TABLE audio_chunks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, sha256 TEXT NOT NULL, expires_at INTEGER NOT NULL, transcription_status TEXT NOT NULL)");
  db.prepare("INSERT INTO sessions VALUES ('s1', 10, 'completed')").run();
  db.prepare("INSERT INTO audio_chunks VALUES ('c1','s1','x.wav',10,20,10,'abc',30,'pending')").run();
  applyJarvisMigrations(db, { now: () => 1000 });
  assert.equal(db.prepare("SELECT capture_mode FROM sessions WHERE id='s1'").get().capture_mode, "mic");
  assert.equal(db.prepare("SELECT source_type FROM audio_chunks WHERE id='c1'").get().source_type, "mic");
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `cd app && node --test test/jarvis/JarvisMigrations.test.js`

Expected: FAIL with `Cannot find module '../../src/jarvis/main/JarvisMigrations'`.

- [ ] **Step 3: Implement versioned migrations**

```js
const TARGET_VERSION = 1;

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function applyJarvisMigrations(db, { now = Date.now } = {}) {
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion >= TARGET_VERSION) return { fromVersion, toVersion: fromVersion };
  db.transaction(() => {
    addColumn(db, "sessions", "capture_mode TEXT NOT NULL DEFAULT 'mic'");
    addColumn(db, "sessions", "processing_state TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, "sessions", "timeline_version INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "sessions", "finalized_at INTEGER");
    addColumn(db, "sessions", "ready_at INTEGER");
    addColumn(db, "audio_chunks", "track_id TEXT");
    addColumn(db, "audio_chunks", "source_type TEXT NOT NULL DEFAULT 'mic'");
    addColumn(db, "audio_chunks", "sequence_number INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "audio_chunks", "write_state TEXT NOT NULL DEFAULT 'committed'");
    addColumn(db, "audio_chunks", "deleted_at INTEGER");
    db.exec(`
      CREATE TABLE IF NOT EXISTS audio_tracks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('mic','system')),
        device_id TEXT, device_label TEXT, strategy TEXT,
        sample_rate INTEGER NOT NULL, channels INTEGER NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        state TEXT NOT NULL, UNIQUE(session_id, source_type)
      );
      CREATE TABLE IF NOT EXISTS audio_gaps (
        id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT NOT NULL, recovery_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processing_jobs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        track_id TEXT REFERENCES audio_tracks(id) ON DELETE CASCADE,
        chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL, state TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, input_hash TEXT NOT NULL, input_version INTEGER NOT NULL DEFAULT 1,
        model_version TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
        lease_owner TEXT, lease_expires_at INTEGER, error_code TEXT,
        created_at INTEGER NOT NULL, completed_at INTEGER,
        UNIQUE(job_type, input_hash)
      );
    `);
    db.pragma(`user_version = ${TARGET_VERSION}`);
    void now();
  })();
  return { fromVersion, toVersion: TARGET_VERSION };
}

module.exports = { applyJarvisMigrations, TARGET_VERSION };
```

- [ ] **Step 4: Run migration and repository regression tests**

Run: `cd app && node --test test/jarvis/JarvisMigrations.test.js test/jarvis/JarvisRepository.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/JarvisMigrations.js app/src/jarvis/main/JarvisRepository.js app/test/jarvis/JarvisMigrations.test.js
git commit -m "feat(jarvis): add dual-track evidence migrations"
```

### Task 2: Implement Focused Capture Evidence Storage

**Files:**
- Create: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Test: `app/test/jarvis/CaptureEvidenceStore.test.js`

**Interfaces:**
- Consumes: migrated better-sqlite3 handle.
- Produces: `createTrack`, `setTrackState`, `openGap`, `closeGap`, `commitChunk`, `tombstoneChunk`, `enqueueChunkTranscription`.

- [ ] **Step 1: Write transaction and uniqueness tests**

```js
test("commits a chunk and one transcription job atomically", () => {
  const { store, db } = fixture();
  store.createTrack({ id: "t1", sessionId: "s1", sourceType: "system", startedAt: 10, sampleRate: 24000, channels: 1, strategy: "wasapi-loopback" });
  store.commitChunk({ id: "c1", sessionId: "s1", trackId: "t1", sourceType: "system", sequenceNumber: 0, path: "c1.wav", startedAt: 10, endedAt: 20, durationMs: 10, sha256: "abc", expiresAt: 30 });
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs WHERE job_type='transcribe_chunk'").get().count, 1);
  assert.throws(() => store.commitChunk({ id: "c2", sessionId: "s1", trackId: "t1", sourceType: "system", sequenceNumber: 0, path: "c2.wav", startedAt: 20, endedAt: 30, durationMs: 10, sha256: "def", expiresAt: 40 }), /sequence/i);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/CaptureEvidenceStore.test.js`

Expected: FAIL because `CaptureEvidenceStore` does not exist.

- [ ] **Step 3: Implement the store with a transaction around chunk plus job**

```js
class CaptureEvidenceStore {
  constructor(db, { createId, now = Date.now }) {
    this.db = db;
    this.createId = createId;
    this.now = now;
    this.commitChunkTransaction = db.transaction((chunk) => {
      db.prepare(`INSERT INTO audio_chunks
        (id,session_id,track_id,source_type,sequence_number,path,started_at,ended_at,duration_ms,sha256,expires_at,transcription_status,write_state)
        VALUES (@id,@sessionId,@trackId,@sourceType,@sequenceNumber,@path,@startedAt,@endedAt,@durationMs,@sha256,@expiresAt,'pending','committed')`).run(chunk);
      db.prepare(`INSERT INTO processing_jobs
        (id,session_id,track_id,chunk_id,job_type,state,input_hash,created_at)
        VALUES (?,?,?,?, 'transcribe_chunk','pending',?,?)`).run(
        this.createId("job"), chunk.sessionId, chunk.trackId, chunk.id, chunk.sha256, this.now()
      );
    });
  }

  commitChunk(chunk) { return this.commitChunkTransaction(chunk); }
  tombstoneChunk(id, deletedAt = this.now()) {
    return this.db.prepare("UPDATE audio_chunks SET path='', deleted_at=? WHERE id=? AND deleted_at IS NULL").run(deletedAt, id);
  }
}

module.exports = CaptureEvidenceStore;
```

- [ ] **Step 4: Run focused tests**

Run: `cd app && node --test test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisRepository.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/CaptureEvidenceStore.js app/src/jarvis/main/JarvisRepository.js app/test/jarvis/CaptureEvidenceStore.test.js
git commit -m "feat(jarvis): persist capture tracks and jobs"
```

### Task 3: Make WAV Writing Source-Aware

**Files:**
- Create: `app/src/jarvis/main/MultiTrackAudioWriter.js`
- Modify: `app/src/jarvis/main/AudioChunkWriter.js`
- Test: `app/test/jarvis/AudioChunkWriter.test.js`
- Test: `app/test/jarvis/MultiTrackAudioWriter.test.js`

**Interfaces:**
- Produces: `new MultiTrackAudioWriter({ sessionId, tracks, baseDir, onChunk })`
- Produces methods: `append(sourceType, pcm)`, `closeSource(sourceType, at)`, `closeAll(at)`, `abortAll()`.

- [ ] **Step 1: Add tests proving independent sequences and files**

```js
test("writes mic and system chunks independently", () => {
  const chunks = [];
  const writer = new MultiTrackAudioWriter({
    sessionId: "s1", baseDir, now: () => 1000,
    tracks: { mic: { id: "tm", startedAt: 10 }, system: { id: "ts", startedAt: 20 } },
    onChunk: (chunk) => chunks.push(chunk),
  });
  writer.append("mic", Buffer.alloc(24000 * 2));
  writer.append("system", Buffer.alloc(24000 * 2));
  writer.closeAll(2000);
  assert.deepEqual(chunks.map(({ sourceType, sequenceNumber }) => [sourceType, sequenceNumber]), [["mic", 0], ["system", 0]]);
  assert.notEqual(chunks[0].path, chunks[1].path);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/AudioChunkWriter.test.js test/jarvis/MultiTrackAudioWriter.test.js`

Expected: FAIL because source metadata and `MultiTrackAudioWriter` are absent.

- [ ] **Step 3: Add source metadata and the multi-track owner**

```js
class MultiTrackAudioWriter {
  constructor({ sessionId, tracks, baseDir, now, onChunk, beforeChunk = () => {} }) {
    this.writers = new Map(Object.entries(tracks).map(([sourceType, track]) => [sourceType,
      new AudioChunkWriter({
        sessionId, trackId: track.id, sourceType, baseDir: path.join(baseDir, sourceType),
        startedAt: track.startedAt, now, beforeChunk,
        onChunk,
      })
    ]));
  }
  append(sourceType, pcm) {
    const writer = this.writers.get(sourceType);
    if (!writer) throw new Error(`inactive audio source: ${sourceType}`);
    writer.append(pcm);
  }
  closeSource(sourceType, at) { this.writers.get(sourceType)?.close(at); }
  closeAll(at) { for (const writer of this.writers.values()) writer.close(at); }
  abortAll() { for (const writer of this.writers.values()) writer.abort(); }
}
```

Update `AudioChunkWriter._emit` to include `trackId`, `sourceType`, and a monotonically increasing `sequenceNumber` initialized to zero.

- [ ] **Step 4: Run writer tests**

Run: `cd app && node --test test/jarvis/AudioChunkWriter.test.js test/jarvis/MultiTrackAudioWriter.test.js`

Expected: PASS with distinct MIC and PC chunks.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/AudioChunkWriter.js app/src/jarvis/main/MultiTrackAudioWriter.js app/test/jarvis/AudioChunkWriter.test.js app/test/jarvis/MultiTrackAudioWriter.test.js
git commit -m "feat(jarvis): write independent mic and system tracks"
```

### Task 4: Convert JarvisService into a Multi-Track Coordinator

**Files:**
- Create: `app/src/jarvis/shared/captureModes.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/src/jarvis/shared/contracts.js`
- Test: `app/test/jarvis/JarvisService.test.js`
- Test: `app/test/jarvis/contracts.test.js`

**Interfaces:**
- `startCapture({ sessionId, startedAt, captureMode, sources })`
- `appendPcm(sessionId, sourceType, pcmBuffer): boolean`
- `sourceInterrupted(sessionId, sourceType, { at, reason }): state`
- `sourceRestored(sessionId, sourceType, { at, deviceId, deviceLabel, strategy }): state`
- Preserve `appendMicPcm` as a compatibility wrapper during this phase.

- [ ] **Step 1: Write dual-source lifecycle tests**

```js
test("system loss degrades dual capture without closing mic", () => {
  const { service, repository } = fixture();
  service.startCapture({ sessionId: "s1", startedAt: 10, captureMode: "dual", sources: [
    { sourceType: "mic", deviceId: "mv7", deviceLabel: "Shure MV7", strategy: "web-audio" },
    { sourceType: "system", deviceId: null, deviceLabel: "Windows output", strategy: "wasapi-loopback" },
  ]});
  service.appendPcm("s1", "mic", Buffer.alloc(48000));
  service.sourceInterrupted("s1", "system", { at: 20, reason: "track-ended" });
  assert.equal(service.getState().status, "degraded");
  assert.equal(service.appendPcm("s1", "mic", Buffer.alloc(48000)), true);
  assert.equal(repository.listAudioGaps("s1").length, 1);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd app && node --test test/jarvis/JarvisService.test.js test/jarvis/contracts.test.js`

Expected: FAIL because `captureMode`, source states, and `appendPcm` are unsupported.

- [ ] **Step 3: Implement capture validation and public state**

```js
const CAPTURE_MODES = Object.freeze({ MIC: "mic", SYSTEM: "system", DUAL: "dual" });
const SOURCES_BY_MODE = Object.freeze({ mic: ["mic"], system: ["system"], dual: ["mic", "system"] });
function assertCaptureMode(value) {
  if (!Object.hasOwn(SOURCES_BY_MODE, value)) throw new TypeError("invalid capture mode");
  return value;
}
function assertSourceType(value) {
  if (value !== "mic" && value !== "system") throw new TypeError("invalid source type");
  return value;
}
module.exports = { CAPTURE_MODES, SOURCES_BY_MODE, assertCaptureMode, assertSourceType };
```

Store source states in `JarvisService.state.sources`; compute session status as `recording` when every requested source is active and `degraded` when at least one remains active and another is reconnecting. Close only the affected writer on interruption and create an `audio_gaps` row through the repository.

- [ ] **Step 4: Run service and IPC tests**

Run: `cd app && node --test test/jarvis/JarvisService.test.js test/jarvis/contracts.test.js test/jarvis/GracefulShutdownCoordinator.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/shared/captureModes.js app/src/jarvis/main/JarvisService.js app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/shared/contracts.js app/test/jarvis/JarvisService.test.js app/test/jarvis/contracts.test.js
git commit -m "feat(jarvis): coordinate dual-source capture"
```

### Task 5: Route System PCM into Jarvis Evidence Before Derived Processing

**Files:**
- Modify: `app/src/jarvis/main/meetingCaptureMode.js`
- Modify: `app/src/helpers/ipcHandlers.js:5821-5883`
- Test: `app/test/jarvis/meetingCaptureMode.test.js`
- Test: `app/test/jarvis/meetingPipelineIntegration.test.js`

**Interfaces:**
- Produces: `routeJarvisPcm({ sessionId, sourceType, pcmBuffer, appendPcm, afterPersist }): boolean`
- Invariant: raw input reaches `appendPcm` before AEC, echo suppression, diarization, or transcription transforms.

- [ ] **Step 1: Write ordering and source tests**

```js
test("persists exact system PCM before derived consumers", () => {
  const calls = [];
  const pcm = Buffer.from([1, 2, 3, 4]);
  routeJarvisPcm({
    sessionId: "s1", sourceType: "system", pcmBuffer: pcm,
    appendPcm: (_sessionId, source, input) => { calls.push(["persist", source, Buffer.from(input)]); return true; },
    afterPersist: (input, source) => calls.push(["derived", source, Buffer.from(input)]),
  });
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [["persist", "system"], ["derived", "system"]]);
  assert.deepEqual(calls[0][2], pcm);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/meetingCaptureMode.test.js test/jarvis/meetingPipelineIntegration.test.js`

Expected: FAIL because only mic-only routing persists Jarvis PCM.

- [ ] **Step 3: Implement source-neutral routing and use it in `sendMeetingAudio`**

```js
function routeJarvisPcm({ sessionId, sourceType, pcmBuffer, appendPcm, afterPersist }) {
  if (!sessionId) return afterPersist(pcmBuffer, sourceType);
  if (appendPcm(sessionId, sourceType, pcmBuffer) === false) return false;
  afterPersist(pcmBuffer, sourceType);
  return true;
}
```

In `ipcHandlers.js`, call `jarvisService.appendPcm(activeJarvisSessionId, source, outboundBuffer)` before the existing system echo detector or mic AEC branch. Preserve the exact buffer in evidence and pass derived copies to AEC/transcription.

- [ ] **Step 4: Run pipeline tests**

Run: `cd app && node --test test/jarvis/meetingCaptureMode.test.js test/jarvis/meetingPipelineIntegration.test.js`

Expected: PASS and static integration test proves both `mic` and `system` enter Jarvis evidence.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/meetingCaptureMode.js app/src/helpers/ipcHandlers.js app/test/jarvis/meetingCaptureMode.test.js app/test/jarvis/meetingPipelineIntegration.test.js
git commit -m "feat(jarvis): persist system audio evidence"
```

### Task 6: Add Explicit Capture Mode and Independent Source Status UI

**Files:**
- Create: `app/src/jarvis/renderer/JarvisCaptureModeSelector.tsx`
- Create: `app/src/jarvis/renderer/__tests__/JarvisCaptureModeSelector.test.tsx`
- Modify: `app/src/jarvis/renderer/jarvisStore.ts`
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts:188-203`
- Modify: `app/src/jarvis/renderer/RecordingControls.tsx`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/types/electron.ts`
- Test: `app/src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

**Interfaces:**
- Produces `JarvisCaptureMode = "mic" | "system" | "dual"`.
- Store fields: `captureMode`, `setCaptureMode`, `sourceStates.mic`, `sourceStates.system`.
- `recordingArgs(id)` sets `captureSystemAudio: captureMode !== "mic"` and `micOnly: captureMode === "mic"` through existing preparation.

- [ ] **Step 1: Write renderer tests**

```tsx
it("requires an explicit mode and exposes MIC and PC status independently", async () => {
  render(<JarvisCaptureModeSelector value="dual" onChange={onChange} disabled={false} />);
  expect(screen.getByRole("radio", { name: "麦克风和电脑声音" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "仅电脑声音" }));
  expect(onChange).toHaveBeenCalledWith("system");
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/JarvisCaptureModeSelector.test.tsx src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

Expected: FAIL because the selector and source status fields do not exist.

- [ ] **Step 3: Implement selector and wire start arguments**

```tsx
const MODES = [
  ["mic", "仅麦克风"],
  ["system", "仅电脑声音"],
  ["dual", "麦克风和电脑声音"],
] as const;

export default function JarvisCaptureModeSelector({ value, onChange, disabled }: Props) {
  return <fieldset disabled={disabled}>
    <legend>采集声音</legend>
    {MODES.map(([mode, label]) => <label key={mode}>
      <input type="radio" name="capture-mode" checked={value === mode} onChange={() => onChange(mode)} />
      {label}
    </label>)}
  </fieldset>;
}
```

Reject start if the selected initial sources are not both ready; show `Retry` and `Continue with available source` rather than silently changing the mode.

- [ ] **Step 4: Run renderer tests and typecheck**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/JarvisCaptureModeSelector.test.tsx src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/renderer/JarvisCaptureModeSelector.tsx app/src/jarvis/renderer/__tests__/JarvisCaptureModeSelector.test.tsx app/src/jarvis/renderer/jarvisStore.ts app/src/jarvis/renderer/useJarvisRecording.ts app/src/jarvis/renderer/RecordingControls.tsx app/src/jarvis/types.ts app/src/types/electron.ts app/src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx
git commit -m "feat(jarvis): select and display capture sources"
```

### Task 7: Tombstone Expired Audio and Backfill Legacy Mic Tracks

**Files:**
- Modify: `app/src/jarvis/main/RetentionCleaner.js`
- Create: `app/src/jarvis/main/LegacyRecordingBackfill.js`
- Test: `app/test/jarvis/RetentionCleaner.test.js`
- Test: `app/test/jarvis/LegacyRecordingBackfill.test.js`
- Modify: `app/main.js:409-433`

**Interfaces:**
- `backfillLegacyRecordings({ repository, recordingsRoot }): { linked, orphaned, jobsCreated }`
- Retention deletes bytes, then calls `tombstoneAudioChunk(id, deletedAt)`.

- [ ] **Step 1: Write retention and backfill tests**

```js
test("retention removes bytes but keeps timeline metadata", async () => {
  await cleaner.run(now);
  assert.equal(fs.existsSync(wavPath), false);
  const row = repository.getAudioChunk("c1");
  assert.equal(row.path, "");
  assert.equal(row.deleted_at, now);
  assert.equal(row.started_at, 10);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/RetentionCleaner.test.js test/jarvis/LegacyRecordingBackfill.test.js`

Expected: FAIL because the current cleaner deletes rows and no backfill service exists.

- [ ] **Step 3: Implement tombstones and conservative linking**

```js
function backfillLegacyRecordings({ repository, recordingsRoot }) {
  const result = { linked: 0, orphaned: [], jobsCreated: 0 };
  for (const entry of fs.readdirSync(recordingsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const session = repository.getSession(entry.name);
    if (!session) { result.orphaned.push(path.join(recordingsRoot, entry.name)); continue; }
    result.linked += repository.ensureLegacyMicTrack(entry.name);
    result.jobsCreated += repository.enqueuePendingChunkJobs(entry.name);
  }
  return result;
}
```

Do not delete or auto-link orphan folders whose directory name is not an existing session ID.

- [ ] **Step 4: Run retention, repository, and recovery tests**

Run: `cd app && node --test test/jarvis/RetentionCleaner.test.js test/jarvis/LegacyRecordingBackfill.test.js test/jarvis/JarvisRecovery.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/RetentionCleaner.js app/src/jarvis/main/LegacyRecordingBackfill.js app/main.js app/test/jarvis/RetentionCleaner.test.js app/test/jarvis/LegacyRecordingBackfill.test.js
git commit -m "feat(jarvis): retain audio evidence tombstones"
```

### Task 8: Phase-One Integration, Migration, and Hardware Gate

**Files:**
- Modify: `app/test/jarvis/meetingPipelineIntegration.test.js`
- Create: `app/test/jarvis/DualTrackRecovery.test.js`
- Create: `docs/testing/jarvis-dual-track-hardware-acceptance.md`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`

**Interfaces:**
- No new production interfaces; this task gates the phase.

- [ ] **Step 1: Add an end-to-end fake-source test**

```js
test("dual capture survives independent source failures and restart", async () => {
  const runtime = await createRuntime({ captureMode: "dual" });
  runtime.feed("mic", oneSecondPcm);
  runtime.feed("system", oneSecondPcm);
  runtime.interrupt("system", 2000);
  runtime.feed("mic", oneSecondPcm);
  await runtime.shutdownAbruptly();
  const recovered = await runtime.restart();
  assert.equal(recovered.session.status, "recovered");
  assert.deepEqual(recovered.tracks.map((track) => track.source_type).sort(), ["mic", "system"]);
  assert.equal(recovered.gaps.length, 1);
  assert.equal(recovered.jobs.length, recovered.chunks.length);
});
```

- [ ] **Step 2: Run the full Jarvis suite before final integration fixes**

Run: `cd app && npm run test:jarvis`

Expected: any remaining integration or localization failures are visible before release changes.

- [ ] **Step 3: Complete the hardware acceptance document**

```markdown
1. Select Shure MV7 and dual capture.
2. Play a browser video; confirm MIC and PC meters move independently.
3. Disconnect the mic twice; confirm PC continues and Sonar is never selected.
4. Change the Windows output device; confirm a PC gap and same-session recovery.
5. Record for two hours; confirm every chunk has a matching durable job.
6. Force-close and reopen; confirm session recovery and no orphaned committed chunk.
```

- [ ] **Step 4: Run all automated phase gates**

Run: `cd app && npm run test:jarvis && npm run typecheck && npm run lint && npm run i18n:check && npm run build:renderer`

Expected: every command exits 0.

- [ ] **Step 5: Run the Windows hardware gate and record observed devices/results in the acceptance document**

Run: `cd app && npm run dev`

Expected: Shure MV7 and Arctis Nova Pro pass initial capture; WASAPI Loopback captures system output; independent recovery behaves as specified.

- [ ] **Step 6: Commit**

```bash
git add app/test/jarvis/meetingPipelineIntegration.test.js app/test/jarvis/DualTrackRecovery.test.js docs/testing/jarvis-dual-track-hardware-acceptance.md app/src/locales/en/translation.json app/src/locales/zh-CN/translation.json
git commit -m "test(jarvis): verify dual-track capture foundation"
```

---

## Phase Acceptance Checklist

- [ ] The user can explicitly select microphone-only, system-only, or dual capture.
- [ ] Microphone and Windows system sound are stored as independent tracks in one session.
- [ ] Every committed WAV chunk has source, sequence, hash, retention, and durable job metadata.
- [ ] Loss of either source records a gap and does not stop the surviving source.
- [ ] Microphone recovery retries indefinitely, re-enumerates devices, excludes virtual devices, and falls back safely.
- [ ] Force-close and restart recover the session without orphaning committed audio.
- [ ] Seven-day cleanup tombstones audio while preserving durable metadata.
- [ ] Existing recordings migrate to microphone tracks without data loss.
- [ ] Automated checks and the Windows hardware acceptance document pass.
