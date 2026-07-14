# Jarvis Evidence and Dual-Track Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a crash-recoverable, all-day evidence layer that records microphone and Windows system audio as independent tracks while minimizing retained silence and disk growth.

**Architecture:** Keep the existing OpenWhispr capture implementations, but make `JarvisService` the authoritative multi-track session coordinator. A capture lane always commits source-aware WAV evidence first; a speech gate with bounded pre/post-roll decides what is retained in normal all-day mode, while important-meeting mode retains continuous audio. Background FLAC conversion may replace a WAV only after lossless verification and an atomic database switch.

**Tech Stack:** Electron 41, Node.js 24, React 19, TypeScript 6, Zustand, better-sqlite3 12, Node test runner, Vitest, Windows WASAPI Loopback with Chromium Loopback fallback, local VAD, bundled FLAC encoder.

## Global Constraints

- Windows 10/11 x64 is the release platform.
- Capture modes are exactly `mic`, `system`, and `dual`.
- Retention modes are exactly `speech_triggered` and `continuous`; they are independent of capture source mode.
- Normal all-day capture defaults to `speech_triggered` with 2 seconds of pre-roll, 3 seconds of post-roll, and speech gaps of at most 3 seconds merged into one retained region.
- Important-meeting capture uses `continuous` retention until the user ends or changes the session.
- System audio is off until the user explicitly selects it for a recording.
- Microphone and system audio remain separate 24 kHz mono PCM tracks and separate WAV chunks.
- Each WAV chunk is at most 60 seconds and is atomically committed with SHA-256 metadata.
- WAV is the crash-safe first commit; FLAC may become authoritative only after decode, duration, sample-rate, channel-count, and decoded-PCM SHA-256 verification.
- VAD failure fails open to continuous retention and exposes a visible degraded state.
- Whisper, speaker embeddings, MiniMax, FLAC/FFmpeg conversion, and analytical database work never run synchronously in an audio callback.
- Low disk must stop new evidence safely before SQLite or the current committed chunk is corrupted.
- Runtime loss of one source cannot stop the other source.
- Automatic microphone recovery excludes Sonar, VoiceMeeter, Steam, and YY devices.
- Raw audio remains local and expires after 7 days; metadata tombstones remain.
- Audio age is measured from capture end time; backlog never extends the user-approved seven-day deadline.
- Expiring unprocessed audio is promoted for final transcription, but if it still cannot finish by expiry its bytes are deleted and its job becomes `audio_expired_before_processing`.
- The user may choose a data directory on a local fixed volume; migration must be resumable and checksum verified.
- Do not change MiniMax analysis, speaker identity, or memory merging in this plan.

---

## File Structure

- Create `app/src/jarvis/main/JarvisMigrations.js`: idempotent schema/version migrations.
- Create `app/src/jarvis/main/CaptureEvidenceStore.js`: focused CRUD for tracks, gaps, chunks, and processing jobs.
- Create `app/src/jarvis/main/MultiTrackAudioWriter.js`: owns one `AudioChunkWriter` per source.
- Create `app/src/jarvis/main/PcmRingBuffer.js`: bounded per-source PCM pre-roll buffer.
- Create `app/src/jarvis/main/SpeechTriggeredCaptureGate.js`: VAD state machine and retained-region decisions.
- Create `app/src/jarvis/main/AudioEvidenceReader.js`: format-independent verified PCM reader for downstream workers.
- Create `app/src/jarvis/main/FlacCompressionWorker.js`: lossless WAV-to-FLAC conversion and atomic evidence replacement.
- Create `app/src/jarvis/main/StorageGovernor.js`: free-space thresholds, safe-stop policy, and storage status.
- Create `app/src/jarvis/main/DataDirectoryMigrator.js`: resumable checksum-verified data-root migration.
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
- Create `app/src/jarvis/renderer/JarvisStorageSettings.tsx`: choose retention mode and data directory and show disk protection state.
- Modify `app/src/jarvis/renderer/JarvisShell.tsx`: mount storage and retention settings.
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

Update `AudioChunkWriter._emit` to include `trackId`, `sourceType`, and a monotonically increasing `sequenceNumber` initialized to zero. Each writer must write `chunk.wav.tmp`, complete the header, flush and fsync, compute the PCM SHA-256, rename to `chunk.wav`, and only then invoke `onChunk` for the SQLite transaction.

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

test("expiry does not extend retention for unfinished transcription", async () => {
  await cleaner.run(now);
  assert.equal(repository.getJob("j1").state, "audio_expired_before_processing");
  assert.equal(fs.existsSync(wavPath), false);
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

Do not delete or auto-link orphan folders whose directory name is not an existing session ID. Before expiry, promote unfinished final-transcription jobs to `retention_urgent`; at expiry, delete WAV or FLAC bytes regardless of backlog, tombstone the chunk, and terminate unfinished audio-dependent jobs as `audio_expired_before_processing`.

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

### Task 9: Add Speech-Triggered Retention with Bounded Context

**Files:**
- Create: `app/src/jarvis/main/PcmRingBuffer.js`
- Create: `app/src/jarvis/main/SpeechTriggeredCaptureGate.js`
- Modify: `app/src/jarvis/main/JarvisMigrations.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/src/jarvis/shared/captureModes.js`
- Modify: `app/src/jarvis/renderer/RecordingControls.tsx`
- Modify: `app/main.js`
- Test: `app/test/jarvis/SpeechTriggeredCaptureGate.test.js`
- Test: `app/test/jarvis/SpeechTriggeredCaptureIntegration.test.js`

**Interfaces:**
- Consumes: `JarvisService.acceptPcm(sourceType, pcm, capturedAt)` and the source-aware writer from Tasks 3–5.
- Produces: `PcmRingBuffer({ capacityFrames, bytesPerFrame })`, `SpeechTriggeredCaptureGate.accept({ sourceType, pcm, capturedAt, speechProbability })`, and durable gaps containing `reason = 'silence_suppressed' | 'vad_degraded'`, `average_level`, and `peak_level`.

- [ ] **Step 1: Write failing ring-buffer and gate tests**

```js
test('retains two seconds before speech and three seconds after it', () => {
  const gate = makeGate({ sampleRate: 24_000, preRollMs: 2_000, postRollMs: 3_000, mergeGapMs: 3_000 })
  feed(gate, { silenceMs: 5_000, speechMs: 1_000, silenceMsAfter: 4_000 })
  assert.deepEqual(gate.retainedRanges(), [{ startMs: 3_000, endMs: 9_000 }])
})

test('fails open when VAD becomes unavailable', () => {
  const gate = makeGate()
  gate.reportVadFailure(new Error('model unavailable'))
  assert.equal(gate.mode, 'continuous_fallback')
  assert.equal(gate.accept(frame()).retain, true)
  assert.equal(gate.status().degradedReason, 'vad_unavailable')
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd app && node --test test/jarvis/SpeechTriggeredCaptureGate.test.js test/jarvis/SpeechTriggeredCaptureIntegration.test.js`

Expected: FAIL because `PcmRingBuffer` and `SpeechTriggeredCaptureGate` do not exist.

- [ ] **Step 3: Implement the bounded state machine and durable gap contract**

```js
export const RETENTION_MODES = Object.freeze(['speech_triggered', 'continuous'])
export const DEFAULT_SPEECH_POLICY = Object.freeze({
  preRollMs: 2_000,
  postRollMs: 3_000,
  mergeGapMs: 3_000,
})

export class SpeechTriggeredCaptureGate {
  accept({ sourceType, pcm, capturedAt, speechProbability }) {
    // Return only bounded write/gap decisions; JarvisService performs persistence.
    return { sourceType, pcmToWrite: Buffer.alloc(0), gapsToCommit: [], state: 'armed' }
  }
  reportVadFailure(error) {
    this.mode = 'continuous_fallback'
    this.degradedReason = 'vad_unavailable'
  }
}
```

Implement the real method so the pre-roll buffer never exceeds `sampleRate * 2` seconds per source, gaps of `<= 3_000 ms` merge, and longer suppressed spans create timeline gap rows with average/peak level without writing silence. VAD runs single-threaded and never shares the speaker-embedding model.

- [ ] **Step 4: Integrate capture policy without changing source selection**

Persist `sessions.retention_mode`, `sessions.capture_policy_json`, and the gap fields. `JarvisService.start({ captureMode, retentionMode })` must default `retentionMode` to `speech_triggered`; switching to `continuous` flushes buffered PCM in timestamp order and never merges MIC with PC. After a VAD failure, reload it in the background; on a successful health test return from visible `continuous_fallback` to `speech_triggered`. Keep VAD indexing active but non-cropping in important-meeting mode, and show different main-window/taskbar states for `正在监听` versus `重要会议`.

- [ ] **Step 5: Run focused and regression tests**

Run: `cd app && node --test test/jarvis/SpeechTriggeredCaptureGate.test.js test/jarvis/SpeechTriggeredCaptureIntegration.test.js && npm run test:jarvis`

Expected: all tests pass; fixtures prove bounded memory, the exact 2/3/3-second policy, continuous meeting retention, and fail-open VAD behavior.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/PcmRingBuffer.js app/src/jarvis/main/SpeechTriggeredCaptureGate.js app/src/jarvis/main/JarvisMigrations.js app/src/jarvis/main/CaptureEvidenceStore.js app/src/jarvis/main/JarvisService.js app/src/jarvis/shared/captureModes.js app/src/jarvis/renderer/RecordingControls.tsx app/main.js app/test/jarvis/SpeechTriggeredCaptureGate.test.js app/test/jarvis/SpeechTriggeredCaptureIntegration.test.js
git commit -m "feat(jarvis): add speech triggered evidence retention"
```

### Task 10: Convert Committed WAV Evidence to Verified FLAC

**Files:**
- Create: `app/src/jarvis/main/AudioEvidenceReader.js`
- Create: `app/src/jarvis/main/FlacCompressionWorker.js`
- Modify: `app/src/jarvis/main/JarvisMigrations.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Test: `app/test/jarvis/FlacCompressionWorker.test.js`

**Interfaces:**
- Consumes: committed chunk `{ id, path, format, pcm_sha256, duration_ms, sample_rate, channels }` and durable `processing_jobs`.
- Produces: `AudioEvidenceReader.readVerifiedPcm(chunk)`, `AudioEvidenceReader.withVerifiedWav(chunk, fn)`, `AudioEvidenceReader.readPlayableWav(chunk)`, job type `compress_chunk`, and `FlacCompressionWorker.run(job)` with atomic `wav -> flac` replacement.

- [ ] **Step 1: Write failing lossless-conversion tests**

```js
test('switches authority only after decoded PCM verification', async () => {
  const result = await worker.run(jobFor('speech.wav'))
  assert.equal(result.chunk.format, 'flac')
  assert.equal(result.chunk.pcm_sha256, fixturePcmSha256)
  assert.equal(await exists('speech.wav'), false)
})

test('keeps WAV authoritative when FLAC verification fails', async () => {
  encoder.decodeHash = 'different'
  await assert.rejects(worker.run(jobFor('speech.wav')), /pcm_hash_mismatch/)
  assert.equal(store.getChunk('c1').format, 'wav')
  assert.equal(await exists('speech.wav'), true)
})
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd app && node --test test/jarvis/FlacCompressionWorker.test.js`

Expected: FAIL because the reader and worker do not exist.

- [ ] **Step 3: Implement format-independent reading and the verification transaction**

```js
export class AudioEvidenceReader {
  async readVerifiedPcm(chunk) {
    const pcm = await this.decoder.decode(chunk.path, chunk.format)
    if (sha256(pcm.bytes) !== chunk.pcm_sha256) throw new Error('pcm_hash_mismatch')
    return pcm
  }
  async withVerifiedWav(chunk, consume) {
    const pcm = await this.readVerifiedPcm(chunk)
    const temporaryWav = await this.temporaryWav.write(pcm)
    try { return await consume(temporaryWav.path) }
    finally { await temporaryWav.remove() }
  }
}
```

Write FLAC to `<final>.partial`, decode it, compare duration within one sample plus exact rate/channels/PCM hash, rename it atomically, update `audio_chunks.path/format/file_sha256` in one transaction, then delete the WAV. On any failure, remove only the partial FLAC and leave the WAV row unchanged.

- [ ] **Step 4: Register idempotent compression jobs**

After a WAV commit, enqueue one `compress_chunk` job keyed by `chunk_id + encoder_version`. A completed job is a no-op on replay; a running transcription lease may keep reading the old path through `AudioEvidenceReader` until the atomic transaction finishes. Startup recovery removes invalid `.tmp/.partial` files, completes or rolls back a valid WAV/FLAC double-file state using hashes and the authoritative row, and never guesses from the extension alone.

- [ ] **Step 5: Run focused and regression tests**

Run: `cd app && node --test test/jarvis/FlacCompressionWorker.test.js && npm run test:jarvis`

Expected: all tests pass, including crash points before rename, after rename, and before WAV deletion.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/AudioEvidenceReader.js app/src/jarvis/main/FlacCompressionWorker.js app/src/jarvis/main/JarvisMigrations.js app/src/jarvis/main/CaptureEvidenceStore.js app/src/jarvis/main/JarvisService.js app/test/jarvis/FlacCompressionWorker.test.js
git commit -m "feat(jarvis): compress evidence to verified flac"
```

### Task 11: Protect Disk Space and Support Safe Data-Directory Migration

**Files:**
- Create: `app/src/jarvis/main/StorageGovernor.js`
- Create: `app/src/jarvis/main/DataDirectoryMigrator.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Create: `app/src/jarvis/renderer/JarvisStorageSettings.tsx`
- Modify: `app/src/jarvis/renderer/JarvisShell.tsx`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/types/electron.ts`
- Test: `app/test/jarvis/StorageGovernor.test.js`
- Test: `app/test/jarvis/DataDirectoryMigrator.test.js`

**Interfaces:**
- Produces: `StorageGovernor.evaluate({ freeBytes, pendingWriteBytes }): 'ok' | 'warning' | 'stop'`, `DataDirectoryMigrator.migrate({ from, to, signal })`, IPC `jarvis:storage:status` and `jarvis:storage:migrate`.

- [ ] **Step 1: Write failing disk and migration tests**

```js
test('warns at 20 GiB and stops at 5 GiB on a large volume', () => {
  const GIB = 1024 ** 3
  assert.equal(governor.evaluate({ volumeBytes: 200 * GIB, freeBytes: 19 * GIB }), 'warning')
  assert.equal(governor.evaluate({ volumeBytes: 200 * GIB, freeBytes: 4 * GIB }), 'stop')
})

test('resumes a copied-file migration and switches root only after verification', async () => {
  await assert.rejects(migrator.migrate({ from, to, failAfterFiles: 2 }))
  const result = await migrator.migrate({ from, to })
  assert.equal(result.switched, true)
  assert.deepEqual(await hashTree(to), await hashTree(from))
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd app && node --test test/jarvis/StorageGovernor.test.js test/jarvis/DataDirectoryMigrator.test.js`

Expected: FAIL because both services are missing.

- [ ] **Step 3: Implement explicit thresholds and safe-stop semantics**

Use `warning = max(20 GiB, 10% of volume)` and `stop = max(5 GiB, 3% of volume)`. Maintain a preallocated 512 MiB emergency reserve; at `stop`, release that reserve, close and commit the current writable chunk if possible, persist `capture_stopped_low_disk`, stop accepting PCM, and leave the session recoverable. Never acknowledge a save when SQLite commit failed; move the completed file into the recovery directory for startup reconciliation.

- [ ] **Step 4: Implement resumable migration and status IPC**

Default to `<Electron userData>/jarvis`. Move recordings, CUDA components, Whisper models, and temporary files as one configured data root. Copy into a migration staging directory, persist a manifest of relative path/size/SHA-256, fsync and verify every file, close the database, atomically update the configured root, reopen it, then offer deletion of the old root only after a successful reopen. Reject network/removable targets in this phase.

- [ ] **Step 5: Add the settings UI contract**

Render free space, actual bytes written/compressed in the latest 24 hours, projected daily growth, remaining recordable days, `ok/warning/stopped` state, current data root, migration progress, and the exact recovery action. Never start migration while capture is active and never promise a fixed FLAC compression ratio.

- [ ] **Step 6: Run verification and commit**

Run: `cd app && node --test test/jarvis/StorageGovernor.test.js test/jarvis/DataDirectoryMigrator.test.js && npm run typecheck && npm run build:renderer`

Expected: all commands exit 0.

```bash
git add app/src/jarvis/main/StorageGovernor.js app/src/jarvis/main/DataDirectoryMigrator.js app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/renderer/JarvisStorageSettings.tsx app/src/jarvis/renderer/JarvisShell.tsx app/src/jarvis/types.ts app/src/types/electron.ts app/test/jarvis/StorageGovernor.test.js app/test/jarvis/DataDirectoryMigrator.test.js
git commit -m "feat(jarvis): govern evidence storage safely"
```

### Task 12: Gate the All-Day Capture Lane

**Files:**
- Create: `app/test/jarvis/AllDayCaptureSoak.test.js`
- Modify: `docs/testing/jarvis-dual-track-hardware-acceptance.md`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: all phase-one capture, speech-gate, compression, retention, and storage services.
- Produces: `npm run test:jarvis:capture-soak` and recorded Windows hardware evidence.

- [ ] **Step 1: Add a deterministic 3-hour simulated soak**

```js
test('3 hour capture keeps queues and handles bounded', async () => {
  const result = await simulateCapture({ hours: 3, speechDutyCycle: 0.18, sourceFailures: 12 })
  assert.ok(result.maxRingBufferBytes <= result.expectedRingBufferBytes)
  assert.equal(result.orphanedChunks, 0)
  assert.equal(result.unboundedQueue, false)
  assert.equal(result.corruptChunks, 0)
})
```

- [ ] **Step 2: Run it before wiring the script**

Run: `cd app && node --test test/jarvis/AllDayCaptureSoak.test.js`

Expected: PASS only when the capture lane remains bounded and every retained region is durable.

- [ ] **Step 3: Add the phase command and manual scenarios**

Add `"test:jarvis:capture-soak": "node --test test/jarvis/AllDayCaptureSoak.test.js"`. Extend hardware acceptance with speech-triggered quiet periods, important-meeting continuous mode, VAD fail-open, low-disk safe stop, interrupted FLAC conversion, migration restart, and seven-day tombstoning.

- [ ] **Step 4: Run the full phase gate**

Run: `cd app && npm run test:jarvis && npm run test:jarvis:capture-soak && npm run typecheck && npm run lint && npm run i18n:check && npm run build:renderer`

Expected: every command exits 0; the simulated soak reports bounded buffers/queues/handles, and the manual document contains observed Windows results.

- [ ] **Step 5: Commit**

```bash
git add app/test/jarvis/AllDayCaptureSoak.test.js docs/testing/jarvis-dual-track-hardware-acceptance.md app/package.json
git commit -m "test(jarvis): gate all day capture durability"
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
- [ ] Processing backlog never extends seven-day audio retention; expired unfinished work becomes visibly `audio_expired_before_processing`.
- [ ] Existing recordings migrate to microphone tracks without data loss.
- [ ] Speech-triggered retention keeps exactly 2 seconds of pre-roll and 3 seconds of post-roll and merges gaps of at most 3 seconds.
- [ ] Important-meeting mode records continuously, and VAD failure visibly fails open to continuous capture.
- [ ] WAV remains authoritative until FLAC passes lossless verification and an atomic database switch.
- [ ] Low disk stops capture safely; a chosen local data directory migrates resumably with checksums.
- [ ] A deterministic 3-hour capture soak shows bounded buffers, queues, handles, and logs with no corrupt or orphaned evidence.
- [ ] Automated checks and the Windows hardware acceptance document pass.
