# Jarvis Complete Transcription and Session Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every committed MIC/PC audio chunk into a durable final transcript and present all chunks as one synchronized session.

**Architecture:** A leased job runner processes `transcribe_chunk` jobs from the evidence store, then a reconciler versions and merges provisional/final segments without destructive replacement. The UI reads one session timeline and streams source-aware chunks through a continuous player.

**Tech Stack:** Node.js 24, Electron 41, better-sqlite3, existing Whisper manager, existing OpenAI correction budget guard, React 19, Web Audio, Node test runner, Vitest.

## Global Constraints

- This plan starts only after the evidence and dual-track capture plan is merged.
- Audio chunks, not renderer transcript state, are the authoritative processing inputs.
- Every committed chunk has exactly one idempotent transcription job per input/model version.
- Real-time transcript is `provisional`; WAV-derived transcript is `final`.
- Old transcript revisions are retained.
- MIC/PC echo deduplication changes the derived transcript only, never raw audio.
- A session cannot be `ready` while any chunk job is pending, running, retrying, or invisibly lost.
- Local transcription continues when MiniMax or OpenAI correction is unavailable.

---

## File Structure

- Create `app/src/jarvis/main/ProcessingJobRunner.js`: leased durable job execution.
- Create `app/src/jarvis/main/JarvisTranscriptionWorker.js`: reads WAV and calls the local transcription adapter.
- Create `app/src/jarvis/main/TranscriptReconciler.js`: versions provisional/final segments and removes overlaps.
- Create `app/src/jarvis/main/DualTrackTranscriptDeduper.js`: marks echo duplicates across MIC/PC.
- Create `app/src/jarvis/main/JarvisProcessingRuntime.js`: registers workers and resumes jobs.
- Create `app/src/jarvis/renderer/ContinuousSessionPlayer.tsx`: continuous source-aware player.
- Create `app/src/jarvis/renderer/ProcessingStatus.tsx`: per-stage progress and errors.
- Modify `app/src/jarvis/main/JarvisRepository.js`: transcript versions, job leases, ready calculation.
- Modify `app/src/helpers/ipcHandlers.js`: inject existing Whisper manager through an adapter.
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

### Task 2: Transcribe Committed WAV Chunks

**Files:**
- Create: `app/src/jarvis/main/JarvisTranscriptionWorker.js`
- Modify: `app/src/helpers/ipcHandlers.js`
- Test: `app/test/jarvis/JarvisTranscriptionWorker.test.js`

**Interfaces:**
- `new JarvisTranscriptionWorker({ repository, transcribeWav, modelVersion, now })`
- `worker.handle(job): Promise<void>`
- Adapter: `transcribeWav({ path, language: null, initialPrompt }): Promise<{ text, confidence?, noSpeech? }>`.

- [ ] **Step 1: Write success, no-speech, and missing-file tests**

```js
test("stores a final source-aware segment", async () => {
  const worker = new JarvisTranscriptionWorker({ repository, modelVersion: "large-v3-turbo", now: () => 50,
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
  constructor({ repository, transcribeWav, modelVersion, now = Date.now }) {
    Object.assign(this, { repository, transcribeWav, modelVersion, now });
  }
  async handle(job) {
    const chunk = this.repository.getAudioChunk(job.chunk_id);
    if (!chunk || !chunk.path) { const error = new Error("audio unavailable"); error.code = "AUDIO_UNAVAILABLE"; throw error; }
    const result = await this.transcribeWav({ path: chunk.path, language: null, initialPrompt: this.repository.getTranscriptPrompt(chunk.session_id) });
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
git add app/src/jarvis/main/JarvisTranscriptionWorker.js app/src/helpers/ipcHandlers.js app/test/jarvis/JarvisTranscriptionWorker.test.js
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
- `readAudioChunk` remains source-aware.
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
  const bytes = await readChunk(playable[index].id);
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

## Phase Acceptance Checklist

- [ ] Every committed chunk reaches a visible terminal transcription state.
- [ ] Provisional real-time text is never mistaken for the final WAV-derived transcript.
- [ ] Final transcript revisions preserve earlier text and evidence lineage.
- [ ] MIC/PC echo is deduplicated only in the derived timeline; raw tracks remain intact.
- [ ] App restart resumes leased jobs without duplicate final segments.
- [ ] Session readiness accurately reflects every chunk and processing job.
- [ ] The GUI presents one continuous session player with source selection and transcript seeking.
- [ ] Existing audio is backfilled or visibly blocked with a specific reason.
- [ ] Bilingual quality, automated checks, and transcript completeness gates pass.
