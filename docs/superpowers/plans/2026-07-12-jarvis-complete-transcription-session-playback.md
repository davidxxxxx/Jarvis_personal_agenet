# Jarvis Complete Transcription and Session Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every committed MIC/PC audio chunk into a durable final transcript and synchronized session while remaining usable as an all-day, resource-aware background service.

**Architecture:** A leased job runner processes `transcribe_chunk` jobs from the evidence store, then a reconciler versions and merges provisional/final segments without destructive replacement. A resource governor protects the always-on capture lane, serializes GPU-heavy work, coalesces provisional previews, and defers final processing when another application needs the GPU. The UI reads one session timeline and exposes actual backend, backlog, and degraded states.

**Tech Stack:** Node.js 24, Electron 41, better-sqlite3, pinned OpenWhispr whisper.cpp CUDA server, NVIDIA/Windows GPU telemetry, existing OpenAI correction budget guard, React 19, Web Audio, Node test runner, Vitest.

## Global Constraints

- This plan starts only after the evidence and dual-track capture plan is merged.
- Audio chunks, not renderer transcript state, are the authoritative processing inputs.
- Every committed chunk has exactly one idempotent transcription job per input/model version.
- Real-time transcript is `provisional`; WAV-derived transcript is `final`.
- Old transcript revisions are retained.
- MIC/PC echo deduplication changes the derived transcript only, never raw audio.
- A session cannot be `ready` while any chunk job is pending, running, retrying, or invisibly lost.
- Local transcription continues when MiniMax or OpenAI correction is unavailable.
- Capture always outranks preview, final transcription, speaker processing, compression, analysis, and maintenance.
- Durable queue order is `retention_urgent`, `storage_recovery_compress`, `preview`, `final_transcription`, `speaker`, `analysis`, then `maintenance`; capture bypasses this queue.
- Resource states are exactly `available`, `busy`, `constrained`, and `unavailable`.
- At most one Jarvis GPU-heavy job may run at a time.
- When another application makes the GPU busy, preview slows or pauses and final work waits; committed audio remains safe.
- Normal provisional preview cadence is 15–30 seconds; queued previews coalesce to one newest pending request.
- CPU fallback is low priority and uses at most 4 threads.
- CUDA delivery is pinned to OpenWhispr/whisper.cpp `0.0.7`, asset `whisper-server-win32-x64-cuda.zip`, size `754998658`, SHA-256 `cdac6f0afb951b4213943297943a9865ae822a8669d623d1d6eb46a0dc0a38c6`.
- CUDA is considered active only after a self-test proves the CUDA backend and records the selected GPU UUID; otherwise the install is quarantined and CPU fallback is used.
- A sleep/wake cycle may resume the same listening run when the app stayed alive; a crash or full restart must not silently reopen the microphone.

---

## File Structure

- Create `app/src/jarvis/main/ProcessingJobRunner.js`: leased durable job execution.
- Create `app/src/jarvis/main/JarvisTranscriptionWorker.js`: reads WAV and calls the local transcription adapter.
- Create `app/src/jarvis/main/TranscriptReconciler.js`: versions provisional/final segments and removes overlaps.
- Create `app/src/jarvis/main/DualTrackTranscriptDeduper.js`: marks echo duplicates across MIC/PC.
- Create `app/src/jarvis/main/JarvisProcessingRuntime.js`: registers workers and resumes jobs.
- Create `app/src/jarvis/main/WhisperCudaManifest.js`: immutable CUDA release metadata.
- Create `app/src/jarvis/main/CudaWhisperVerifier.js`: backend/GPU identity self-test and quarantine decision.
- Create `app/src/jarvis/main/ResourceGovernor.js`: system resource state and admission policy.
- Create `app/src/jarvis/main/HeavyJobGate.js`: one-permit GPU-heavy job lease.
- Create `app/src/jarvis/main/PreviewTranscriptionScheduler.js`: bounded/coalescing provisional work.
- Create `app/src/jarvis/main/JarvisPowerLifecycle.js`: suspend, wake, crash-recovery, and midnight boundaries.
- Create `app/scripts/jarvis-cuda-self-test.js`: explicit local CUDA verification command.
- Create `app/src/jarvis/renderer/ContinuousSessionPlayer.tsx`: continuous source-aware player.
- Create `app/src/jarvis/renderer/ProcessingStatus.tsx`: per-stage progress and errors.
- Modify `app/src/jarvis/main/JarvisRepository.js`: transcript versions, job leases, ready calculation.
- Modify `app/src/helpers/ipcHandlers.js`: inject existing Whisper manager through an adapter.
- Modify `app/src/helpers/whisperCudaManager.js`: pinned, verified, atomic CUDA install and rollback.
- Modify `app/src/helpers/whisperServer.js`: expose actual backend and selected GPU UUID.
- Modify `app/src/utils/gpuDetection.js`: normalized utilization, memory pressure, and NVIDIA identity.
- Modify `app/package.json`: CUDA self-test and all-day resource-soak scripts.
- Modify `app/src/jarvis/main/registerJarvisIpc.js`: timeline/chunk streaming/retry IPC.
- Modify `app/src/jarvis/renderer/MemoryView.tsx`: replace per-chunk buttons with timeline/player.
- Modify `app/src/jarvis/renderer/useJarvisRecording.ts`: persist provisional segments without deleting final ones.
- Modify `app/main.js`: start and stop processing runtime.

### Task 1: Implement Durable Job Leasing

**Files:**
- Create: `app/src/jarvis/main/ProcessingJobRunner.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Test: `app/test/jarvis/ProcessingJobRunner.test.js`

**Interfaces:**
- `runner.register(jobType, async (job) => result)`
- `runner.runOnce(at): Promise<number>`
- `runner.recoverExpiredLeases(at): number`
- Store methods: `claimJobs({ owner, at, leaseMs, limit })`, `completeJob`, `retryJob`, `blockJob`.

- [ ] **Step 1: Write lease-expiry and idempotency tests**

```js
test("reclaims an expired job and completes it once", async () => {
  const calls = [];
  const runner = new ProcessingJobRunner({ store, owner: "worker-b", now: () => 2000, leaseMs: 100 });
  runner.register("transcribe_chunk", async (job) => calls.push(job.id));
  store.forceLease("j1", { owner: "dead-worker", expiresAt: 1500 });
  assert.equal(await runner.runOnce(2000), 1);
  assert.deepEqual(calls, ["j1"]);
  assert.equal(store.getJob("j1").state, "completed");
  assert.equal(await runner.runOnce(2001), 0);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/ProcessingJobRunner.test.js`

Expected: FAIL because the runner and leasing methods do not exist.

- [ ] **Step 3: Implement a one-job-at-a-time leased runner**

```js
class ProcessingJobRunner {
  constructor({ store, owner, now = Date.now, leaseMs = 60_000 }) {
    this.store = store; this.owner = owner; this.now = now; this.leaseMs = leaseMs; this.handlers = new Map();
  }
  register(type, handler) { this.handlers.set(type, handler); }
  async runOnce(at = this.now()) {
    this.store.recoverExpiredLeases(at);
    const jobs = this.store.claimJobs({ owner: this.owner, at, leaseMs: this.leaseMs, limit: 1 });
    if (!jobs.length) return 0;
    const job = jobs[0];
    const handler = this.handlers.get(job.job_type);
    if (!handler) { this.store.blockJob(job.id, "HANDLER_MISSING", at); return 1; }
    try { await handler(job); this.store.completeJob(job.id, this.now()); }
    catch (error) { this.store.retryJob(job.id, error.code || "JOB_FAILED", this.now()); }
    return 1;
  }
}
module.exports = ProcessingJobRunner;
```

- [ ] **Step 4: Run job tests**

Run: `cd app && node --test test/jarvis/ProcessingJobRunner.test.js test/jarvis/CaptureEvidenceStore.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/ProcessingJobRunner.js app/src/jarvis/main/CaptureEvidenceStore.js app/test/jarvis/ProcessingJobRunner.test.js app/test/jarvis/CaptureEvidenceStore.test.js
git commit -m "feat(jarvis): run durable processing jobs"
```

### Task 2: Transcribe Committed WAV or FLAC Chunks

**Files:**
- Create: `app/src/jarvis/main/JarvisTranscriptionWorker.js`
- Modify: `app/src/jarvis/main/AudioEvidenceReader.js`
- Modify: `app/src/helpers/ipcHandlers.js`
- Test: `app/test/jarvis/JarvisTranscriptionWorker.test.js`

**Interfaces:**
- `new JarvisTranscriptionWorker({ repository, audioEvidenceReader, transcribeWav, modelVersion, now })`
- `worker.handle(job): Promise<void>`
- Adapter: `transcribeWav({ path, language: null, initialPrompt }): Promise<{ text, confidence?, noSpeech? }>`.

- [ ] **Step 1: Write success, no-speech, and missing-file tests**

```js
test("stores a final source-aware segment", async () => {
  const worker = new JarvisTranscriptionWorker({ repository, audioEvidenceReader, modelVersion: "large-v3-turbo", now: () => 50,
    transcribeWav: async () => ({ text: "今天 review 一下 roadmap", confidence: 0.91 }) });
  await worker.handle(chunkJob("system"));
  const segment = repository.listTranscriptSegments("s1")[0];
  assert.equal(segment.result_kind, "final");
  assert.equal(segment.source_type, "system");
  assert.equal(segment.model_version, "large-v3-turbo");
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/JarvisTranscriptionWorker.test.js`

Expected: FAIL because the worker does not exist.

- [ ] **Step 3: Implement the worker**

```js
class JarvisTranscriptionWorker {
  constructor({ repository, audioEvidenceReader, transcribeWav, modelVersion, now = Date.now }) {
    Object.assign(this, { repository, audioEvidenceReader, transcribeWav, modelVersion, now });
  }
  async handle(job) {
    const chunk = this.repository.getAudioChunk(job.chunk_id);
    if (!chunk || !chunk.path) { const error = new Error("audio unavailable"); error.code = "AUDIO_UNAVAILABLE"; throw error; }
    const result = await this.audioEvidenceReader.withVerifiedWav(chunk, (path) => this.transcribeWav({
      path, language: null, initialPrompt: this.repository.getTranscriptPrompt(chunk.session_id),
    }));
    this.repository.commitChunkTranscript({ chunk, result, modelVersion: this.modelVersion, completedAt: this.now() });
  }
}
module.exports = JarvisTranscriptionWorker;
```

The `ipcHandlers.js` adapter calls the existing `whisperManager.transcribeLocalWhisper` with the configured Jarvis model and bilingual prompt; it does not duplicate model startup code.

- [ ] **Step 4: Run worker and quality tests**

Run: `cd app && node --test test/jarvis/JarvisTranscriptionWorker.test.js test/jarvis/transcriptionQuality.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/JarvisTranscriptionWorker.js app/src/jarvis/main/AudioEvidenceReader.js app/src/helpers/ipcHandlers.js app/test/jarvis/JarvisTranscriptionWorker.test.js
git commit -m "feat(jarvis): backfill transcripts from wav chunks"
```

### Task 3: Reconcile Provisional and Final Transcript Versions

**Files:**
- Create: `app/src/jarvis/main/TranscriptReconciler.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts`
- Test: `app/test/jarvis/TranscriptReconciler.test.js`
- Test: `app/src/jarvis/renderer/__tests__/recordingController.test.ts`

**Interfaces:**
- `reconcileSession(sessionId): { inserted, superseded, unchanged }`
- Transcript fields: `version`, `result_kind`, `source_type`, `track_id`, `supersedes_segment_id`.

- [ ] **Step 1: Write overlap and last-tail tests**

```js
test("final chunk transcript supersedes overlapping provisional text without deleting history", () => {
  repository.insertProvisional(provisional({ id: "p1", startedAt: 0, endedAt: 60, text: "周五交付" }));
  repository.insertFinal(final({ id: "f1", startedAt: 0, endedAt: 60, text: "周五交付测试版本" }));
  const result = reconciler.reconcileSession("s1");
  assert.equal(result.superseded, 1);
  assert.equal(repository.getVisibleTranscript("s1")[0].id, "f1");
  assert.equal(repository.getTranscriptSegment("p1").superseded_by, "f1");
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/TranscriptReconciler.test.js`

Expected: FAIL because versioned transcript APIs do not exist.

- [ ] **Step 3: Implement deterministic time-window reconciliation**

```js
class TranscriptReconciler {
  constructor({ repository }) { this.repository = repository; }
  reconcileSession(sessionId) {
    return this.repository.reconcileTranscriptTransaction(sessionId, ({ provisional, final }) => {
      const overlaps = provisional.filter((p) => p.track_id === final.track_id && p.started_at < final.ended_at && final.started_at < p.ended_at);
      return { visible: final, supersede: overlaps.map((row) => row.id) };
    });
  }
}
module.exports = TranscriptReconciler;
```

Renderer snapshot sync must update only provisional rows; it must never delete final rows absent from the current renderer snapshot.

- [ ] **Step 4: Run main and renderer tests**

Run: `cd app && node --test test/jarvis/TranscriptReconciler.test.js test/jarvis/JarvisRepository.test.js && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/recordingController.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/TranscriptReconciler.js app/src/jarvis/main/JarvisRepository.js app/src/jarvis/renderer/useJarvisRecording.ts app/test/jarvis/TranscriptReconciler.test.js app/src/jarvis/renderer/__tests__/recordingController.test.ts
git commit -m "feat(jarvis): reconcile transcript revisions safely"
```

### Task 4: Deduplicate MIC Bleed Against System Audio

**Files:**
- Create: `app/src/jarvis/main/DualTrackTranscriptDeduper.js`
- Test: `app/test/jarvis/DualTrackTranscriptDeduper.test.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`

**Interfaces:**
- `dedupe(sessionId): { duplicatesMarked }`
- A duplicate is source `mic`, overlaps a `system` segment, passes normalized text similarity, and has echo evidence; it is hidden from unified transcript but retained.

- [ ] **Step 1: Write positive and negative dedupe tests**

```js
test("marks echo duplicate but preserves both source rows", () => {
  seedSegment({ id: "sys", sourceType: "system", startedAt: 100, endedAt: 120, text: "周五交付", echoScore: 1 });
  seedSegment({ id: "mic", sourceType: "mic", startedAt: 101, endedAt: 121, text: "周五交付", echoScore: 0.92 });
  assert.deepEqual(deduper.dedupe("s1"), { duplicatesMarked: 1 });
  assert.equal(repository.listAllTranscriptSegments("s1").length, 2);
  assert.deepEqual(repository.getVisibleTranscript("s1").map((row) => row.id), ["sys"]);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/DualTrackTranscriptDeduper.test.js`

Expected: FAIL because dedupe metadata and service do not exist.

- [ ] **Step 3: Implement conservative dedupe**

```js
function normalizedSimilarity(a, b) {
  const left = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const right = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return left === right ? 1 : longestCommonSubsequenceRatio(left, right);
}
function isDuplicate(mic, system) {
  return mic.started_at < system.ended_at && system.started_at < mic.ended_at &&
    mic.echo_score >= 0.8 && normalizedSimilarity(mic.text, system.text) >= 0.85;
}
```

Only mark duplicates when every predicate passes; otherwise retain both in the unified transcript.

- [ ] **Step 4: Run dedupe tests**

Run: `cd app && node --test test/jarvis/DualTrackTranscriptDeduper.test.js test/jarvis/transcriptionQuality.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/DualTrackTranscriptDeduper.js app/src/jarvis/main/JarvisRepository.js app/test/jarvis/DualTrackTranscriptDeduper.test.js
git commit -m "feat(jarvis): deduplicate dual-track echo transcripts"
```

### Task 5: Wire Restartable Processing Runtime and Session Readiness

**Files:**
- Create: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/main.js`
- Modify: `app/src/jarvis/main/GracefulShutdownCoordinator.js`
- Test: `app/test/jarvis/JarvisProcessingRuntime.test.js`
- Test: `app/test/jarvis/GracefulShutdownCoordinator.test.js`

**Interfaces:**
- `runtime.start()`, `runtime.drainOnce()`, `runtime.stop()`.
- Session becomes `ready` only after required jobs complete and final transcript coverage reaches the last chunk end.

- [ ] **Step 1: Write restart and ready-state tests**

```js
test("restart resumes pending chunks before marking ready", async () => {
  const first = runtimeFixture();
  await first.runtime.start();
  await first.runtime.stop();
  const second = runtimeFixture({ db: first.db });
  await second.runtime.drainOnce();
  assert.equal(second.repository.getSession("s1").processing_state, "ready");
  assert.equal(second.repository.listPendingJobs("s1").length, 0);
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && node --test test/jarvis/JarvisProcessingRuntime.test.js`

Expected: FAIL because runtime orchestration does not exist.

- [ ] **Step 3: Implement bounded polling with immediate startup recovery**

```js
class JarvisProcessingRuntime {
  async start() { this.running = true; this.repository.recoverExpiredJobLeases(this.now()); return this.drainOnce(); }
  async drainOnce() {
    let count = 0;
    while (this.running && await this.runner.runOnce()) count += 1;
    for (const session of this.repository.listProcessingSessions()) this.repository.refreshSessionReadiness(session.id);
    return count;
  }
  async stop() { this.running = false; await this.inFlight; }
}
```

- [ ] **Step 4: Run runtime and shutdown tests**

Run: `cd app && node --test test/jarvis/JarvisProcessingRuntime.test.js test/jarvis/GracefulShutdownCoordinator.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/main/JarvisProcessingRuntime.js app/main.js app/src/jarvis/main/GracefulShutdownCoordinator.js app/test/jarvis/JarvisProcessingRuntime.test.js app/test/jarvis/GracefulShutdownCoordinator.test.js
git commit -m "feat(jarvis): resume transcript processing after restart"
```

### Task 6: Add Processing Status and Continuous Session Player

**Files:**
- Create: `app/src/jarvis/renderer/ProcessingStatus.tsx`
- Create: `app/src/jarvis/renderer/ContinuousSessionPlayer.tsx`
- Create: `app/src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx`
- Create: `app/src/jarvis/renderer/__tests__/ContinuousSessionPlayer.test.tsx`
- Modify: `app/src/jarvis/renderer/MemoryView.tsx`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/src/jarvis/types.ts`

**Interfaces:**
- `getSessionTimeline(sessionId)` returns tracks, gaps, ordered chunks, visible segments, and processing counts.
- `readAudioChunk` remains source-aware and returns verified playable WAV bytes through `AudioEvidenceReader.readPlayableWav`, regardless of stored WAV/FLAC format.
- Player modes: `mix`, `mic`, `system`.

- [ ] **Step 1: Write timeline and playback queue tests**

```tsx
it("plays successive chunks as one session", async () => {
  render(<ContinuousSessionPlayer timeline={timelineWithTwoMicChunks} readChunk={readChunk} />);
  await user.click(screen.getByRole("button", { name: "连续播放" }));
  fireEvent.ended(createdAudio[0]);
  expect(readChunk).toHaveBeenNthCalledWith(2, "chunk-2");
  expect(screen.queryByText("60 秒音频")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Verify failure**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/ContinuousSessionPlayer.test.tsx src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx`

Expected: FAIL because both components are absent.

- [ ] **Step 3: Implement source filtering and queue advancement**

```tsx
const playable = timeline.chunks.filter((chunk) => !chunk.deleted_at && (mode === "mix" || chunk.source_type === mode));
const playAt = async (index: number) => {
  const bytes = await readChunk(playable[index].id); // verified WAV bytes from main process
  if (!bytes) return playAt(index + 1);
  const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
  audio.onended = () => void playAt(index + 1);
  await audio.play();
};
```

Render gaps and source lanes from timestamps; clicking a transcript segment starts the matching chunk at its offset.

- [ ] **Step 4: Run renderer tests and typecheck**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/ContinuousSessionPlayer.test.tsx src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/jarvis/renderer/ProcessingStatus.tsx app/src/jarvis/renderer/ContinuousSessionPlayer.tsx app/src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx app/src/jarvis/renderer/__tests__/ContinuousSessionPlayer.test.tsx app/src/jarvis/renderer/MemoryView.tsx app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/types.ts
git commit -m "feat(jarvis): show continuous processed sessions"
```

### Task 7: Backfill Existing Audio and Gate Transcript Completeness

**Files:**
- Create: `app/test/jarvis/ExistingRecordingBackfill.test.js`
- Create: `docs/testing/jarvis-transcription-completeness-acceptance.md`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`

**Interfaces:**
- No new production interfaces; gates phase two.

- [ ] **Step 1: Add a copied-database backfill test**

```js
test("every existing on-disk chunk reaches a terminal visible state", async () => {
  const migrated = await migrateFixtureCopy(realisticLegacyFixture);
  await migrated.runtime.drainOnce();
  const rows = migrated.repository.listAudioChunksWithJobs();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => ["completed", "blocked"].includes(row.job_state)));
  assert.equal(rows.filter((row) => row.job_state === "blocked" && !row.error_code).length, 0);
});
```

- [ ] **Step 2: Run the full suite and capture failures**

Run: `cd app && npm run test:jarvis`

Expected: all phase-one and phase-two automated tests pass.

- [ ] **Step 3: Record bilingual evaluation commands and thresholds**

```markdown
- Run the fixed near-field bilingual fixture set through the selected local model.
- Compute Chinese CER <= 15%.
- Compute English WER <= 20%.
- Compute custom-name and glossary recall >= 90%.
- List noisy fixtures separately; do not merge them into the near-field score.
```

- [ ] **Step 4: Run all phase gates**

Run: `cd app && npm run test:jarvis && npm run typecheck && npm run lint && npm run i18n:check && npm run build:renderer`

Expected: every command exits 0; no session marked `ready` has unfinished chunk jobs.

- [ ] **Step 5: Commit**

```bash
git add app/test/jarvis/ExistingRecordingBackfill.test.js docs/testing/jarvis-transcription-completeness-acceptance.md app/src/locales/en/translation.json app/src/locales/zh-CN/translation.json
git commit -m "test(jarvis): gate complete transcript recovery"
```

---

### Task 8: Pin, Install, and Prove the CUDA Whisper Runtime

**Files:**
- Create: `app/src/jarvis/main/WhisperCudaManifest.js`
- Create: `app/src/jarvis/main/CudaWhisperVerifier.js`
- Create: `app/scripts/jarvis-cuda-self-test.js`
- Modify: `app/src/helpers/whisperCudaManager.js`
- Modify: `app/src/helpers/whisperServer.js`
- Modify: `app/main.js`
- Modify: `app/package.json`
- Test: `app/test/jarvis/WhisperCudaManifest.test.js`
- Test: `app/test/jarvis/CudaWhisperVerifier.test.js`

**Interfaces:**
- Produces: `WHISPER_CUDA_MANIFEST`, `installPinnedCudaRuntime({ consent, signal })`, and `CudaWhisperVerifier.verify({ runtimeDir, fixturePath }): Promise<{ ok, backend, gpuUuid, reason }>`.

- [ ] **Step 1: Write failing manifest, atomic-install, and backend-proof tests**

```js
test('pins the approved CUDA asset byte-for-byte', () => {
  assert.deepEqual(WHISPER_CUDA_MANIFEST, {
    repository: 'OpenWhispr/whisper.cpp', tag: '0.0.7',
    asset: 'whisper-server-win32-x64-cuda.zip', size: 754_998_658,
    sha256: 'cdac6f0afb951b4213943297943a9865ae822a8669d623d1d6eb46a0dc0a38c6',
  })
})

test('rejects a process that answers but reports CPU', async () => {
  const result = await verifier.verify({ server: fakeServer({ backend: 'cpu', gpuUuid: null }) })
  assert.deepEqual(result, { ok: false, backend: 'cpu', gpuUuid: null, reason: 'cuda_not_active' })
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd app && node --test test/jarvis/WhisperCudaManifest.test.js test/jarvis/CudaWhisperVerifier.test.js`

Expected: FAIL because the manifest and verifier do not exist.

- [ ] **Step 3: Implement pinned download and atomic version directories**

```js
export const WHISPER_CUDA_MANIFEST = Object.freeze({
  repository: 'OpenWhispr/whisper.cpp', tag: '0.0.7',
  asset: 'whisper-server-win32-x64-cuda.zip', size: 754_998_658,
  sha256: 'cdac6f0afb951b4213943297943a9865ae822a8669d623d1d6eb46a0dc0a38c6',
})
```

On first supported NVIDIA detection, show one install prompt containing the approximately 755 MB download size; a refusal is persisted and never prompted again unless the user chooses Install in Jarvis settings. Before download, check archive size + extracted-size estimate + safety margin on the selected data volume. Download only after consent into `cuda/0.0.7.partial`, verify exact size and SHA-256, extract into staging, require the server and all companion DLLs, self-test, rename to `cuda/0.0.7`, then atomically replace the `current.json` pointer. Never execute from the download directory or overwrite the last verified version.

- [ ] **Step 4: Prove real CUDA inference and quarantine failures**

Start with the user-selected GPU UUID, run a short bundled speech fixture, require server logs to report the CUDA backend and target UUID, require healthy HTTP/text output, and confirm the NVIDIA process or VRAM telemetry. Persist component version, GPU UUID, driver, model, peak VRAM, verification time, and outcome. Hash/DLL failures quarantine immediately; launch/OOM/driver failures use distinct codes and quarantine after 3 consecutive failures in the same app boot. Retain the previous verified pointer and return a CPU fallback state with Retry, Roll Back, and Remove actions.

- [ ] **Step 5: Run tests and the explicit local self-test**

Add the package entry:

```json
{
  "scripts": {
    "jarvis:cuda:self-test": "node scripts/jarvis-cuda-self-test.js"
  }
}
```

Run: `cd app && node --test test/jarvis/WhisperCudaManifest.test.js test/jarvis/CudaWhisperVerifier.test.js && npm run jarvis:cuda:self-test`

Expected: automated tests pass; on an NVIDIA machine the command prints `backend=cuda` and a GPU UUID, otherwise it exits with a documented CPU fallback result rather than enabling CUDA falsely.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/WhisperCudaManifest.js app/src/jarvis/main/CudaWhisperVerifier.js app/scripts/jarvis-cuda-self-test.js app/src/helpers/whisperCudaManager.js app/src/helpers/whisperServer.js app/main.js app/test/jarvis/WhisperCudaManifest.test.js app/test/jarvis/CudaWhisperVerifier.test.js app/package.json
git commit -m "feat(jarvis): install and verify pinned cuda whisper"
```

### Task 9: Govern CPU/GPU Pressure and Serialize Heavy Work

**Files:**
- Create: `app/src/jarvis/main/ResourceGovernor.js`
- Create: `app/src/jarvis/main/HeavyJobGate.js`
- Modify: `app/src/utils/gpuDetection.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/ProcessingJobRunner.js`
- Test: `app/test/jarvis/ResourceGovernor.test.js`
- Test: `app/test/jarvis/HeavyJobGate.test.js`

**Interfaces:**
- Produces: `ResourceGovernor.sample(): ResourceSnapshot`, `ResourceGovernor.admit(kind, snapshot = this.latestSnapshot): Admission`, and `HeavyJobGate.run(kind, fn)`.
- `ResourceSnapshot.state` is `available | busy | constrained | unavailable`; `Admission.action` is `run_cuda | run_cpu | defer | pause_preview`.

- [ ] **Step 1: Write failing policy and serialization tests**

```js
test('yields final GPU work to an external workload within 15 seconds', () => {
  const admission = governor.admit('final_transcription', sample({ gpuUtil: 92, externalGpuBusy: true }))
  assert.deepEqual(admission, { action: 'defer', reason: 'external_gpu_busy' })
})

test('prioritizes expiring evidence and disk recovery before preview', () => {
  assert.deepEqual(orderJobs(['analysis', 'preview', 'retention_urgent', 'storage_recovery_compress']),
    ['retention_urgent', 'storage_recovery_compress', 'preview', 'analysis'])
})

test('never overlaps two heavy Jarvis jobs', async () => {
  await Promise.all([gate.run('whisper', trackedJob), gate.run('speaker', trackedJob)])
  assert.equal(maxConcurrent, 1)
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd app && node --test test/jarvis/ResourceGovernor.test.js test/jarvis/HeavyJobGate.test.js`

Expected: FAIL because the resource policy and gate are missing.

- [ ] **Step 3: Implement deterministic admission**

```js
export const RESOURCE_STATES = Object.freeze(['available', 'busy', 'constrained', 'unavailable'])
export const JOB_PRIORITY = Object.freeze({
  retention_urgent: 0, storage_recovery_compress: 10, preview: 20,
  final_transcription: 30, speaker: 40, analysis: 50, maintenance: 60,
})
```

Use normalized GPU utilization, dedicated/available VRAM, CPU load, AC/battery saver state, and CUDA health. Require `available VRAM >= measured model peak + safety margin` before launch and use hysteresis so one sample cannot flap states. Treat missing telemetry as `constrained`, not `available`. Let an already-started inference finish instead of killing it mid-model. If GPU constraints last over 60 seconds, stop the idle Whisper server to release VRAM. On battery saver, admit only capture/evidence commit and storage-critical compression. CPU fallback spawns Whisper with low process priority and `--threads 4` maximum; it provides 60–90 second preview only when CUDA is unavailable and the user has kept preview enabled, while ordinary final backlog may wait for CUDA.

- [ ] **Step 4: Integrate durable deferral instead of failure**

When admission is `defer`, release the job lease with `next_attempt_at` and `blocked_reason`, without incrementing permanent failure count. Capture and evidence reads bypass the heavy-job gate. A chunk approaching the seven-day deadline becomes `retention_urgent`; disk-pressure FLAC work becomes `storage_recovery_compress`. Compression may run only when it does not contend with an admitted transcription or speaker job. Every job records its stable key, input hashes/revisions, model/parameter version, priority, state, attempts, retry time, error code, lease owner/expiry, and actual execution device (`cuda`, `cpu`, or `cloud`).

- [ ] **Step 5: Run focused and runtime regression tests**

Run: `cd app && node --test test/jarvis/ResourceGovernor.test.js test/jarvis/HeavyJobGate.test.js test/jarvis/ProcessingJobRunner.test.js`

Expected: all tests pass; heavy concurrency is 1, external GPU use causes deferral in at most one 15-second sample interval, and CPU flags never exceed 4 threads.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/ResourceGovernor.js app/src/jarvis/main/HeavyJobGate.js app/src/utils/gpuDetection.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/jarvis/main/ProcessingJobRunner.js app/test/jarvis/ResourceGovernor.test.js app/test/jarvis/HeavyJobGate.test.js
git commit -m "feat(jarvis): govern transcription resources"
```

### Task 10: Coalesce Provisional Preview Without Delaying Final Work

**Files:**
- Create: `app/src/jarvis/main/PreviewTranscriptionScheduler.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/TranscriptReconciler.js`
- Modify: `app/src/jarvis/renderer/ProcessingStatus.tsx`
- Test: `app/test/jarvis/PreviewTranscriptionScheduler.test.js`

**Interfaces:**
- Produces: `PreviewTranscriptionScheduler.request({ sessionId, trackId, throughMs })`, `tick(resourceSnapshot)`, and status `{ cadenceMs, pending, pausedReason }`.

- [ ] **Step 1: Write failing cadence and coalescing tests**

```js
test('keeps only the newest pending preview', () => {
  scheduler.request({ sessionId: 's1', trackId: 'mic', throughMs: 15_000 })
  scheduler.request({ sessionId: 's1', trackId: 'mic', throughMs: 30_000 })
  assert.deepEqual(scheduler.pending(), [{ sessionId: 's1', trackId: 'mic', throughMs: 30_000 }])
})

test('pauses preview but preserves final durable jobs while GPU is busy', () => {
  scheduler.tick({ state: 'busy' })
  assert.equal(scheduler.status().pausedReason, 'gpu_busy')
  assert.equal(finalJobs.count(), 1)
})
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd app && node --test test/jarvis/PreviewTranscriptionScheduler.test.js`

Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement bounded preview state**

Use a map keyed by `sessionId + trackId`, one running request and one newest pending request per key, 15-second minimum and 30-second maximum normal cadence. Under `busy`, pause; under `constrained`, use 45–90 seconds. Bound prompt/audio context to the newest 120 seconds and persist output only as `provisional`.

- [ ] **Step 4: Integrate status without changing final readiness**

Preview failures and pauses must not mark final jobs failed and must not prevent a session becoming ready after all final jobs complete. Show `实时预览已降频`, `实时预览已暂停，录音继续`, or the normal cadence in `ProcessingStatus`.

- [ ] **Step 5: Run focused and transcript reconciliation tests**

Run: `cd app && node --test test/jarvis/PreviewTranscriptionScheduler.test.js test/jarvis/TranscriptReconciler.test.js`

Expected: all tests pass; p95 simulated available-GPU preview latency is at most 30 seconds and queue depth stays bounded.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/PreviewTranscriptionScheduler.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/jarvis/main/TranscriptReconciler.js app/src/jarvis/renderer/ProcessingStatus.tsx app/test/jarvis/PreviewTranscriptionScheduler.test.js
git commit -m "feat(jarvis): coalesce resource aware previews"
```

### Task 11: Handle Suspend, Wake, Crash, and Midnight Boundaries

**Files:**
- Create: `app/src/jarvis/main/JarvisPowerLifecycle.js`
- Modify: `app/src/jarvis/main/JarvisService.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Modify: `app/main.js`
- Test: `app/test/jarvis/JarvisPowerLifecycle.test.js`

**Interfaces:**
- Produces: `JarvisPowerLifecycle.onSuspend()`, `onResume()`, `onLocalDateChange(now)`, and `recoverAfterLaunch()`.

- [ ] **Step 1: Write failing lifecycle tests**

```js
test('suspend closes chunks and wake resumes the same live run', async () => {
  await lifecycle.onSuspend()
  assert.equal(store.lastGap().reason, 'system_suspend')
  await lifecycle.onResume()
  assert.equal(service.currentRunId, originalRunId)
})

test('cold launch exposes interruption but does not reopen the microphone', async () => {
  const result = await lifecycle.recoverAfterLaunch()
  assert.equal(result.interruptedSessionId, 's1')
  assert.equal(microphone.openCalls, 0)
})
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd app && node --test test/jarvis/JarvisPowerLifecycle.test.js`

Expected: FAIL because lifecycle coordination is missing.

- [ ] **Step 3: Implement explicit transitions**

On suspend: commit current chunks, persist `system_suspend`, pause schedulers, release CUDA processes, and keep an in-memory resume token. On wake with that token: re-enumerate devices and resume the same run. On cold launch: recover evidence/jobs and display an interrupted session, but require a manual Start click before opening any capture device.

- [ ] **Step 4: Rotate at the local midnight boundary**

When the local date changes during active listening, close the daily session, create the next daily session with the same capture/retention choices, preserve the visible listening state, and record a cross-session continuation link. Make this idempotent across DST and duplicate timer callbacks.

- [ ] **Step 5: Run lifecycle and recovery regressions**

Run: `cd app && node --test test/jarvis/JarvisPowerLifecycle.test.js test/jarvis/DualTrackRecovery.test.js test/jarvis/ProcessingJobRunner.test.js`

Expected: all tests pass; suspend/resume stays in one run, cold launch does not reopen devices, and midnight produces exactly one new local-day session.

- [ ] **Step 6: Commit**

```bash
git add app/src/jarvis/main/JarvisPowerLifecycle.js app/src/jarvis/main/JarvisService.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/jarvis/main/CaptureEvidenceStore.js app/main.js app/test/jarvis/JarvisPowerLifecycle.test.js
git commit -m "feat(jarvis): preserve safe all day lifecycle"
```

### Task 12: Expose Honest Runtime Status and Bound Long-Run UI Work

**Files:**
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/src/jarvis/renderer/ProcessingStatus.tsx`
- Modify: `app/src/jarvis/renderer/MemoryView.tsx`
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/types/electron.ts`
- Test: `app/src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx`
- Test: `app/test/jarvis/LongRunStatusSnapshot.test.js`

**Interfaces:**
- Produces: `jarvis:runtime:status` returning capture state, actual backend, CUDA GPU UUID, resource state/reason, queue counts, backlog minutes, oldest job age, preview cadence, disk state, and next recovery action.

- [ ] **Step 1: Write failing status and render-frequency tests**

```ts
it('shows that recording continues while GPU work waits', () => {
  render(<ProcessingStatus status={busyStatus} />)
  expect(screen.getByText('录音继续，GPU 任务等待中')).toBeVisible()
  expect(screen.getByText('积压 18 分钟')).toBeVisible()
})
```

The Node test must simulate a hidden renderer and assert meter/status emissions are at most 2 Hz while transcript persistence remains incremental by segment.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx && node --test test/jarvis/LongRunStatusSnapshot.test.js`

Expected: FAIL because the unified status contract and hidden-window throttling are absent.

- [ ] **Step 3: Implement the snapshot and bounded update policy**

Visible meters may render at their existing interactive rate; hidden/unfocused windows receive 1–2 Hz status only and stop nonessential animation/polling. Never resend a whole session transcript after each segment; append/update by stable segment ID. Schedule SQLite WAL checkpoints, cleanup, and index maintenance away from the capture callback. Rotate logs by size/day with a bounded retained count, register Jarvis-owned Whisper/ONNX/FFmpeg sidecar PIDs, clean them on normal exit, and remove verified orphan sidecars/temporary files/expired leases at startup.

- [ ] **Step 4: Render actionable status**

Show the distinct primary states `正在监听`, `正在保存语音`, `重要会议`, `GPU预览处理中`, `GPU忙，已让路`, `后台处理中`, `正在恢复麦克风`, `已暂停`, and `需要处理`. Also show `CUDA/CPU`, verified GPU identity, `available/busy/constrained/unavailable`, pending counts by stage, provisional/final coverage, backlog duration, oldest item, preview delay, disk state/remaining days, and explicit actions such as `等待 GPU`, `检查 CUDA`, `释放磁盘`, or `重试任务`.

- [ ] **Step 5: Run type/UI/runtime checks and commit**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx && node --test test/jarvis/LongRunStatusSnapshot.test.js && npm run typecheck && npm run build:renderer`

Expected: every command exits 0.

```bash
git add app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/renderer/ProcessingStatus.tsx app/src/jarvis/renderer/MemoryView.tsx app/src/jarvis/renderer/useJarvisRecording.ts app/src/jarvis/types.ts app/src/types/electron.ts app/src/jarvis/renderer/__tests__/ProcessingStatus.test.tsx app/test/jarvis/LongRunStatusSnapshot.test.js
git commit -m "feat(jarvis): expose bounded runtime status"
```

### Task 13: Gate All-Day Resource and Transcript Reliability

**Files:**
- Create: `app/test/jarvis/AllDayResourceSoak.test.js`
- Create: `docs/testing/jarvis-all-day-resource-acceptance.md`
- Modify: `app/package.json`

**Interfaces:**
- Produces: `npm run test:jarvis:resource-soak` plus a recorded reference-machine report.

- [ ] **Step 1: Add deterministic workload and fault simulation**

```js
test('3 hours remain bounded and preserve every final job', async () => {
  const result = await simulateAllDay({ hours: 3, externalGpuBusyWindows: 2, sleeps: 1, cudaCrashes: 1 })
  assert.equal(result.lostFinalJobs, 0)
  assert.ok(result.maxHeavyConcurrency <= 1)
  assert.ok(result.maxCpuFallbackThreads <= 4)
  assert.equal(result.unboundedGrowth, false)
})
```

- [ ] **Step 2: Run the simulation and verify the gate**

Run: `cd app && node --test test/jarvis/AllDayResourceSoak.test.js`

Expected: PASS with no lost jobs and bounded memory, handles, queues, UI emissions, sidecars, and logs.

- [ ] **Step 3: Define the reference-machine measurements**

Record with Windows Performance Recorder or equivalent: 10 minutes of silent listening averages CPU `<= 3%` and starts no Whisper inference; capture + VAD averages CPU `<= 5%`; available-GPU provisional p95 `<= 30 seconds`; external GPU load is detected and yielded to within `15 seconds`; CPU fallback threads `<= 4`; no unbounded growth over 24 hours.

- [ ] **Step 4: Run the full phase gate**

Run: `cd app && npm run test:jarvis && npm run test:jarvis:resource-soak && npm run typecheck && npm run lint && npm run i18n:check && npm run build:renderer`

Expected: every command exits 0 and the acceptance report includes measured values, machine/GPU identity, model, power plan, and pass/fail for every threshold.

- [ ] **Step 5: Commit**

```bash
git add app/test/jarvis/AllDayResourceSoak.test.js docs/testing/jarvis-all-day-resource-acceptance.md app/package.json
git commit -m "test(jarvis): gate all day resource governance"
```

---

## Phase Acceptance Checklist

- [ ] Every committed chunk reaches a visible terminal transcription state.
- [ ] Provisional real-time text is never mistaken for the final WAV-derived transcript.
- [ ] Final transcript revisions preserve earlier text and evidence lineage.
- [ ] MIC/PC echo is deduplicated only in the derived timeline; raw tracks remain intact.
- [ ] App restart resumes leased jobs without duplicate final segments.
- [ ] Session readiness accurately reflects every chunk and processing job.
- [ ] Queue priority matches the approved retention/disk/preview/final/speaker/analysis order, and every job records input versions, lease, retry, error, and actual execution device.
- [ ] The GUI presents one continuous session player with source selection and transcript seeking.
- [ ] Existing audio is backfilled or visibly blocked with a specific reason.
- [ ] The pinned CUDA archive is verified before execution, installed atomically, and enabled only after a real CUDA/GPU-UUID self-test.
- [ ] GPU-heavy Jarvis work is serialized and yields to external GPU use within 15 seconds without stopping capture.
- [ ] CPU fallback is low priority and never exceeds four threads.
- [ ] Provisional preview normally arrives within 15–30 seconds, coalesces stale work, and can pause without losing final jobs.
- [ ] Suspend/wake resumes the same live run; cold launch never silently reopens capture; local midnight creates exactly one linked daily session.
- [ ] Runtime status exposes actual backend, GPU identity, resource reason, backlog duration, oldest job, disk state, and recovery action.
- [ ] The 3-hour simulated soak and reference-machine CPU/latency/resource thresholds pass with bounded queues, handles, logs, and sidecars.
- [ ] Bilingual quality, automated checks, and transcript completeness gates pass.
