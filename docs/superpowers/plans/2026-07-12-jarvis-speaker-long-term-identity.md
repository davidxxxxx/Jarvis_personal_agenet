# Jarvis Speaker and Long-Term Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably distinguish the owner from other speakers, keep session-local speaker clusters separate from confirmed long-term identities, and let the user correct, name, merge, or undo identity decisions with complete provenance.

**Architecture:** A durable, resource-governed diarization job creates session-scoped speaker clusters only from finalized audio and transcript timing. A conservative identity resolver compares quality-gated cluster embeddings with versioned voice profiles, but only high-confidence matches are linked automatically. Confirmed user corrections update durable identity links transactionally; the original cluster, score, model version, and correction history remain queryable.

**Tech Stack:** Electron, Node.js, better-sqlite3, existing Whisper/diarization and speaker-embedding helpers, React, Zustand, Node test runner, Vitest, Testing Library.

## Global Constraints

- Phase 2 (`2026-07-12-jarvis-complete-transcription-session-playback.md`) is a prerequisite.
- Never upload speaker embeddings or raw voice to MiniMax.
- Never identify a person solely from a display name supplied by the model.
- Do not update a voice centroid from an automatic match.
- Preserve unknown speakers as unknown.
- Do not compute speaker embeddings per second during live capture.
- Preview may show temporary session labels only; persistent identity work begins after final audio and final transcript are available.
- Speaker diarization/embedding is GPU-heavy work and must use the phase-two `HeavyJobGate`; it may not overlap Whisper inference.
- When resources are `busy`, `constrained`, or `unavailable`, speaker jobs remain durable and deferred without affecting capture or final transcript visibility.
- All schema changes must be idempotent and preserve existing sessions, chunks, transcripts, people, and the reserved self profile.

---

## File Structure

- Create `app/src/jarvis/main/SpeakerIdentityRepository.js`: durable profiles, samples, session clusters, links, and revisions.
- Create `app/src/jarvis/main/VoiceProfileStore.js` and modify `app/src/jarvis/main/VoiceEnrollmentService.js`: consented, quality-gated self enrollment.
- Create `app/src/jarvis/main/SessionDiarizationWorker.js`: final-evidence-only session clustering.
- Create `app/src/jarvis/main/SpeakerIdentityResolver.js`: conservative identity matching and suggestions.
- Create `app/src/jarvis/main/SpeakerCorrectionService.js`: rename, link, merge, reject, and undo transactions.
- Create `app/src/jarvis/main/SpeakerProcessingPolicy.js`: resource admission and final-evidence eligibility.
- Modify `app/src/helpers/liveSpeakerIdentifier.js`: remove it from Jarvis all-day capture and retain only explicitly scoped legacy use.
- Modify `app/src/jarvis/main/JarvisProcessingRuntime.js`: register deferred speaker jobs behind `HeavyJobGate`.
- Modify `app/src/jarvis/main/JarvisRepository.js` and `app/src/jarvis/main/JarvisMigrations.js`: identity persistence and job eligibility.
- Modify Jarvis renderer people/session views: temporary labels, identity suggestions, corrections, provenance, and deferred status.

### Task 1: Add durable cluster, profile-sample, and identity-link storage

**Files:**
- Create: `app/src/jarvis/main/SpeakerIdentityRepository.js`
- Modify: `app/src/jarvis/main/JarvisMigrations.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Test: `app/test/jarvis/SpeakerIdentityRepository.test.js`

- [ ] **Step 1: Write the failing migration and transaction tests**

Test these invariants:

```js
test('creates session clusters without assigning a person', () => {
  const cluster = identities.createCluster({
    sessionId: 's1',
    trackId: 't-mic',
    localLabel: 'speaker_1',
    modelId: 'wespeaker-v1',
    embedding: new Float32Array(512).fill(0.01),
    speechMs: 18_000,
    windowCount: 4,
  })
  assert.equal(cluster.personId, null)
})

test('confirmLink is transactional and retains correction history', () => {
  identities.confirmLink({
    clusterId: 'c1', personId: 'p-zhang', actor: 'user', scope: 'persistent'
  })
  assert.equal(identities.getCluster('c1').personId, 'p-zhang')
  assert.equal(identities.listCorrections('c1').length, 1)
})
```

Also prove that running migrations twice succeeds and that deleting a person clears the confirmed link without deleting the underlying cluster evidence.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:main -- test/jarvis/SpeakerIdentityRepository.test.js`

Expected: FAIL because the tables and repository do not exist.

- [ ] **Step 3: Add the idempotent schema**

Add migrations for:

```sql
CREATE TABLE IF NOT EXISTS speaker_clusters (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL,
  local_label TEXT NOT NULL,
  model_id TEXT NOT NULL,
  embedding BLOB,
  speech_ms INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0,
  quality_score REAL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  link_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(link_state IN ('unknown','suggested','confirmed','rejected')),
  match_score REAL,
  match_margin REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, track_id, local_label)
);

CREATE TABLE IF NOT EXISTS voice_profile_samples (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  source_cluster_id TEXT REFERENCES speaker_clusters(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('enrollment','user_confirmed')),
  speech_ms INTEGER NOT NULL,
  window_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS speaker_identity_corrections (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES speaker_clusters(id) ON DELETE CASCADE,
  previous_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  next_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  previous_state TEXT NOT NULL,
  next_state TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('session','persistent')),
  actor TEXT NOT NULL CHECK(actor IN ('user','system')),
  created_at INTEGER NOT NULL
);
```

Store embeddings as explicit little-endian Float32 blobs. Implement `encodeEmbedding` and `decodeEmbedding` in `SpeakerIdentityRepository.js`; reject non-finite values and inconsistent dimensions.

- [ ] **Step 4: Implement the repository boundary**

Expose:

```js
class SpeakerIdentityRepository {
  createCluster(input) {}
  replaceClusterSegments(clusterId, transcriptSegmentIds) {}
  getCluster(clusterId) {}
  listSessionClusters(sessionId) {}
  listProfiles(modelId) {}
  addProfileSample(input) {}
  confirmLink(input) {}
  rejectSuggestion(input) {}
  undoLastCorrection(clusterId) {}
  mergePeople(input) {}
  listCorrections(clusterId) {}
}
```

`confirmLink` must use one SQLite transaction to record the previous state, update the link, and—only for `scope: 'persistent'`—add a `user_confirmed` profile sample when the quality gate has already passed. `undoLastCorrection` must restore the recorded previous state rather than guessing it.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/SpeakerIdentityRepository.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/JarvisMigrations.js app/src/jarvis/main/JarvisRepository.js app/src/jarvis/main/SpeakerIdentityRepository.js app/test/jarvis/SpeakerIdentityRepository.test.js
git commit -m "feat: persist speaker clusters and identity history"
```

---

### Task 2: Make self-voice enrollment versioned and quality-gated

**Files:**
- Create: `app/src/jarvis/main/VoiceProfileStore.js`
- Modify: `app/src/jarvis/main/VoiceEnrollmentService.js`
- Modify: `app/src/helpers/database.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Test: `app/test/jarvis/VoiceEnrollmentService.test.js`
- Test: `app/test/jarvis/VoiceProfileStore.test.js`

- [ ] **Step 1: Add failing tests for enrollment quality and compatibility**

Cover:

- fewer than three valid windows is rejected;
- less than 30 seconds of accepted speech is rejected;
- mutually inconsistent windows are rejected;
- an existing profile from another embedding model is never compared;
- successful enrollment persists individual samples and an aggregate profile for the reserved self person;
- restarting the app loads the same self profile without re-enrollment.

Use deterministic orthogonal and near-identical vectors; do not depend on real hardware in unit tests.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/VoiceEnrollmentService.test.js test/jarvis/VoiceProfileStore.test.js`

Expected: FAIL on missing profile store and quality decisions.

- [ ] **Step 3: Implement the profile store and enrollment contract**

Use this return type:

```js
/**
 * @typedef {Object} VoiceEnrollmentResult
 * @property {'accepted'|'insufficient_speech'|'inconsistent_samples'|'model_error'} status
 * @property {string} modelId
 * @property {number} acceptedSpeechMs
 * @property {number} windowCount
 * @property {number|null} selfConsistency
 */
```

`VoiceProfileStore.saveEnrollment` must replace only enrollment-origin samples for the same person/model inside one transaction. It must not delete user-confirmed samples. Keep the legacy `speaker_profiles` database readable during migration, import the reserved `SELF_VOICE_PROFILE_ID = -1` once, and record an import marker so later launches are no-ops.

Calculate self-consistency as the minimum cosine similarity from each accepted sample to the normalized centroid. Reject below a named constant with the model ID next to the threshold:

```js
const SELF_PROFILE_POLICY = Object.freeze({
  modelId: 'wespeaker-v1',
  minimumSpeechMs: 30_000,
  minimumWindows: 3,
  minimumSelfConsistency: 0.78,
})
```

- [ ] **Step 4: Surface specific enrollment outcomes through IPC**

Return structured errors rather than a generic exception. The renderer must be able to tell the user whether more speech, a quieter room, or a retry is needed.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/VoiceEnrollmentService.test.js test/jarvis/VoiceProfileStore.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/VoiceProfileStore.js app/src/jarvis/main/VoiceEnrollmentService.js app/src/helpers/database.js app/src/jarvis/main/registerJarvisIpc.js app/test/jarvis/VoiceEnrollmentService.test.js app/test/jarvis/VoiceProfileStore.test.js
git commit -m "feat: harden self voice enrollment"
```

---

### Task 3: Produce stable session-scoped diarization clusters

**Files:**
- Create: `app/src/jarvis/main/SessionDiarizationWorker.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/helpers/liveSpeakerIdentifier.js`
- Modify: `app/src/helpers/speakerEmbeddings.js`
- Test: `app/test/jarvis/SessionDiarizationWorker.test.js`

- [ ] **Step 1: Write failing deterministic worker tests**

Create fake finalized chunks with timed transcript segments and a fake diarizer. Verify:

- chunks from the same track are processed in capture-time order;
- the same local voice across adjacent chunks maps to one session cluster;
- mic and system tracks do not create duplicate clusters when their speech intervals are non-overlapping;
- overlapping identical audio is marked as a possible duplicate and is not silently used twice;
- retrying the same job replaces cluster/segment links idempotently;
- a failed chunk leaves the job retryable and does not partially confirm identities.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:main -- test/jarvis/SessionDiarizationWorker.test.js`

Expected: FAIL because the worker is missing.

- [ ] **Step 3: Implement a dependency-injected worker**

```js
class SessionDiarizationWorker {
  constructor({ repository, identities, diarizeAudio, embedWindows, clock }) {}

  async run({ sessionId, trackId, jobId }) {
    const chunks = this.repository.listFinalizedChunks(sessionId, trackId)
    // Diarize, align to transcript timestamps, merge adjacent local speakers,
    // create quality-scored embeddings, then replace durable cluster links.
  }
}
```

The worker must create clusters only after the track has a durable transcript or an explicit terminal `no_speech` result. It may reuse the existing diarization and embedding helpers, but move tunable constants into a model-specific policy object. It must not call MiniMax.

Register job type `diarize_track` in `JarvisProcessingRuntime`; enqueue it after every `transcribe_chunk` job for the track reaches a terminal result. The job key must be `diarize_track:<sessionId>:<trackId>:<transcriptRevision>` so transcript backfills create a new revision without duplicating the old result.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:main -- test/jarvis/SessionDiarizationWorker.test.js test/jarvis/ProcessingJobRunner.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/SessionDiarizationWorker.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/helpers/liveSpeakerIdentifier.js app/src/helpers/speakerEmbeddings.js app/test/jarvis/SessionDiarizationWorker.test.js app/test/jarvis/ProcessingJobRunner.test.js
git commit -m "feat: add durable session diarization"
```

---

### Task 4: Resolve clusters against long-term identities conservatively

**Files:**
- Create: `app/src/jarvis/main/SpeakerIdentityResolver.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Test: `app/test/jarvis/SpeakerIdentityResolver.test.js`

- [ ] **Step 1: Write failing policy tests**

Use fixed vectors to prove all boundaries:

```js
assert.deepEqual(resolve({ speechMs: 11_999, windowCount: 4 }), {
  state: 'unknown', reason: 'insufficient_speech'
})
assert.equal(resolve(highConfidenceFixture).state, 'confirmed')
assert.equal(resolve(mediumConfidenceFixture).state, 'suggested')
assert.equal(resolve(ambiguousFixture).reason, 'insufficient_margin')
assert.equal(resolve(modelMismatchFixture).reason, 'model_mismatch')
```

Also prove that a rejected suggestion is not re-suggested for the same cluster/revision and automatic confirmation does not add a profile sample.

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:main -- test/jarvis/SpeakerIdentityResolver.test.js`

Expected: FAIL because the resolver is missing.

- [ ] **Step 3: Implement explicit model policy and outcomes**

```js
const IDENTITY_POLICY = Object.freeze({
  modelId: 'wespeaker-v1',
  minimumSpeechMs: 12_000,
  minimumWindows: 3,
  autoConfirmSimilarity: 0.82,
  suggestSimilarity: 0.72,
  minimumMargin: 0.05,
})

/** @returns {{state:'confirmed'|'suggested'|'unknown', personId:string|null,
 * score:number|null, margin:number|null, reason:string}} */
function resolveIdentity(cluster, profiles, rejectedPersonIds = new Set()) {}
```

Normalize embeddings once, compare only profiles with the exact same `modelId`, rank the top two people rather than samples, and require both score and margin for automatic confirmation. If the top person is self, apply the same or stricter policy—never a looser one. Persist the score, margin, reason, and policy version.

Register `resolve_identities:<sessionId>:<diarizationRevision>` after all track diarization jobs for the session are terminal.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:main -- test/jarvis/SpeakerIdentityResolver.test.js test/jarvis/SessionDiarizationWorker.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/SpeakerIdentityResolver.js app/src/jarvis/main/JarvisProcessingRuntime.js app/test/jarvis/SpeakerIdentityResolver.test.js
git commit -m "feat: resolve speaker identities conservatively"
```

---

### Task 5: Add correction, naming, merge, and undo workflows

**Files:**
- Create: `app/src/jarvis/main/SpeakerCorrectionService.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/jarvis/renderer/SpeakerChip.tsx`
- Modify: `app/src/jarvis/renderer/PeopleView.tsx`
- Modify: `app/src/jarvis/renderer/jarvisStore.ts`
- Test: `app/test/jarvis/SpeakerCorrectionService.test.js`
- Test: `app/src/jarvis/renderer/SpeakerChip.test.tsx`
- Test: `app/src/jarvis/renderer/PeopleView.test.tsx`

- [ ] **Step 1: Write failing service and UI tests**

Cover these user paths:

- rename `说话人 2` to a new person `张三` for this session only;
- link the cluster to existing `张三` persistently;
- accept or reject a suggested match;
- undo the most recent correction;
- merge duplicate people after a confirmation dialog;
- keep the transcript label stable when a person is deleted;
- show `我`, confirmed person name, `疑似张三`, or `未知说话人` distinctly.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/SpeakerCorrectionService.test.js && npm run test:renderer -- src/jarvis/renderer/SpeakerChip.test.tsx src/jarvis/renderer/PeopleView.test.tsx`

Expected: FAIL on missing service/actions.

- [ ] **Step 3: Implement typed IPC and transactions**

Add IPC commands:

```ts
type ConfirmSpeakerInput = {
  clusterId: string
  personId?: string
  newPersonName?: string
  scope: 'session' | 'persistent'
}

type SpeakerCorrectionApi = {
  confirm(input: ConfirmSpeakerInput): Promise<SpeakerClusterView>
  reject(clusterId: string, personId: string): Promise<SpeakerClusterView>
  undo(clusterId: string): Promise<SpeakerClusterView>
  mergePeople(sourcePersonId: string, targetPersonId: string): Promise<PersonView>
}
```

Validate that exactly one of `personId` and `newPersonName` is supplied. Normalize names for duplicate detection but retain the user-entered display form. A persistent confirmation may create a profile sample only when the cluster passes the quality gate; session-only corrections never change long-term voice data.

- [ ] **Step 4: Implement the correction UI**

`SpeakerChip` opens a small action menu with existing people search, new-person creation, session/persistent scope, reject, and undo. `PeopleView` shows confirmed samples and recent appearances, plus a guarded merge action. Never display raw embeddings.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/SpeakerCorrectionService.test.js && npm run test:renderer -- src/jarvis/renderer/SpeakerChip.test.tsx src/jarvis/renderer/PeopleView.test.tsx`

Expected: PASS.

```bash
git add app/src/jarvis/main/SpeakerCorrectionService.js app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/types.ts app/src/jarvis/renderer/SpeakerChip.tsx app/src/jarvis/renderer/PeopleView.tsx app/src/jarvis/renderer/jarvisStore.ts app/test/jarvis/SpeakerCorrectionService.test.js app/src/jarvis/renderer/SpeakerChip.test.tsx app/src/jarvis/renderer/PeopleView.test.tsx
git commit -m "feat: add speaker identity correction workflow"
```

---

### Task 6: Add an identity evaluation gate and end-to-end verification

**Files:**
- Create: `app/test/fixtures/speaker-eval/manifest.json`
- Create: `app/test/jarvis/SpeakerIdentityEvaluation.test.js`
- Modify: `app/test/jarvis/SpeakerProfileIdentity.test.js`
- Create: `docs/TESTING.md`

- [ ] **Step 1: Define a consented local evaluation manifest**

The manifest contains metadata only; audio fixtures stay gitignored:

```json
{
  "modelId": "wespeaker-v1",
  "cases": [
    {"id":"owner-alone","expectedSpeakers":["self"]},
    {"id":"owner-and-one-known","expectedSpeakers":["self","person-a"]},
    {"id":"owner-and-two-unknown","expectedSpeakerCount":3}
  ]
}
```

The test must skip with an explicit path hint when consented local fixtures are absent; it must never download voice data.

- [ ] **Step 2: Implement metric computation and hard gates**

Report:

- diarization speaker-count accuracy;
- self-match precision and recall;
- confirmed-known-person precision and recall;
- unknown false-positive rate;
- number of suggestions requiring correction.

Release gates:

- self automatic-match precision `>= 0.95`;
- known-person automatic-match precision `>= 0.95`;
- unknown false-positive rate `<= 0.05`;
- no automatic match below policy score or margin.

Precision gates take priority over recall: failure to recognize is acceptable; confidently naming the wrong person is not.

- [ ] **Step 3: Run the complete phase verification**

Run:

```bash
cd app
npm run test:jarvis
npm run typecheck
npm run lint
```

Expected: all automated tests pass; the local identity evaluation either passes all thresholds or reports a documented skip because private fixtures are absent.

- [ ] **Step 4: Commit the evaluation gate**

```bash
git add app/test/fixtures/speaker-eval/manifest.json app/test/jarvis/SpeakerIdentityEvaluation.test.js app/test/jarvis/SpeakerProfileIdentity.test.js docs/TESTING.md
git commit -m "test: gate long term speaker identity quality"
```

---

### Task 7: Defer Speaker Work and Remove Per-Second Live Embeddings

**Files:**
- Create: `app/src/jarvis/main/SpeakerProcessingPolicy.js`
- Modify: `app/src/jarvis/main/SessionDiarizationWorker.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/helpers/liveSpeakerIdentifier.js`
- Modify: `app/src/jarvis/renderer/ProcessingStatus.tsx`
- Test: `app/test/jarvis/SpeakerProcessingPolicy.test.js`
- Test: `app/test/jarvis/NoLiveSpeakerEmbedding.test.js`

**Interfaces:**
- Consumes: `ResourceGovernor.admit('speaker')`, `HeavyJobGate.run('speaker', fn)`, final transcript revision IDs, and `AudioEvidenceReader.readVerifiedPcm(chunk)` from phases 1–2.
- Produces: `SpeakerProcessingPolicy.evaluate(session): { eligible, reason }` and durable speaker-job deferral reasons.

- [ ] **Step 1: Write failing eligibility and no-live-embedding tests**

```js
test('requires final transcript and committed final audio', () => {
  assert.deepEqual(policy.evaluate(session({ transcriptState: 'provisional' })), {
    eligible: false, reason: 'final_transcript_pending',
  })
  assert.deepEqual(policy.evaluate(session({ transcriptState: 'final', audioState: 'committed' })), {
    eligible: true, reason: null,
  })
})

test('accepting live PCM never invokes the embedding extractor', async () => {
  await jarvis.acceptPcm('mic', oneHourOfFrames())
  assert.equal(embeddingExtractor.calls.length, 0)
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd app && node --test test/jarvis/SpeakerProcessingPolicy.test.js test/jarvis/NoLiveSpeakerEmbedding.test.js`

Expected: FAIL because no final-evidence policy exists and the legacy live path can still invoke embeddings.

- [ ] **Step 3: Implement explicit final-evidence admission**

```js
export class SpeakerProcessingPolicy {
  evaluate(session) {
    if (session.audioState !== 'committed') return { eligible: false, reason: 'final_audio_pending' }
    if (session.transcriptState !== 'final') return { eligible: false, reason: 'final_transcript_pending' }
    return { eligible: true, reason: null }
  }
}
```

Require immutable input revision IDs in the speaker job key. Never read renderer preview buffers or provisional segments in `SessionDiarizationWorker`.

- [ ] **Step 4: Route all speaker inference through the heavy-job gate**

Call `ResourceGovernor.admit('speaker')`; on `defer` or `pause_preview`, release the durable lease with a retry time and visible reason. On admission, run diarization and embedding inside `HeavyJobGate.run('speaker', ...)`. Remove Jarvis capture subscriptions from `liveSpeakerIdentifier`; keep any non-Jarvis legacy export inert unless called explicitly.

- [ ] **Step 5: Expose deferred state without inventing identity**

While speaker work waits, render session-local labels such as `说话人 1（待确认）` and `声纹分析等待 GPU`; never substitute `我` or a persisted person name before the identity resolver creates an evidence-backed link.

- [ ] **Step 6: Run focused, integration, and evaluation tests**

Run: `cd app && node --test test/jarvis/SpeakerProcessingPolicy.test.js test/jarvis/NoLiveSpeakerEmbedding.test.js test/jarvis/SessionDiarizationWorker.test.js test/jarvis/SpeakerProfileIdentity.test.js`

Expected: all tests pass; live PCM produces zero embedding calls, speaker/Whisper maximum heavy concurrency is 1, and deferred work later completes against the same immutable revisions.

- [ ] **Step 7: Commit**

```bash
git add app/src/jarvis/main/SpeakerProcessingPolicy.js app/src/jarvis/main/SessionDiarizationWorker.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/helpers/liveSpeakerIdentifier.js app/src/jarvis/renderer/ProcessingStatus.tsx app/test/jarvis/SpeakerProcessingPolicy.test.js app/test/jarvis/NoLiveSpeakerEmbedding.test.js
git commit -m "perf(jarvis): defer speaker identity processing"
```

---

## Phase Acceptance Checklist

- [ ] Self enrollment survives restart and records its embedding model version.
- [ ] Session diarization produces stable local clusters before assigning names.
- [ ] Unknown and ambiguous speakers remain unknown or suggested, never silently confirmed.
- [ ] Automatic matches require at least 12 seconds, three windows, score, and margin gates.
- [ ] A user can rename, link, reject, merge, and undo identities.
- [ ] Persistent identity learning occurs only after explicit confirmation and a quality pass.
- [ ] Every identity decision retains score, margin, model version, evidence cluster, and correction history.
- [ ] Raw audio and embeddings never leave the local identity pipeline.
- [ ] Live capture performs no per-second speaker embedding or persistent identity assignment.
- [ ] Speaker processing consumes only committed final audio and final transcript revisions.
- [ ] Whisper and speaker inference never overlap; resource pressure defers speaker jobs durably without blocking capture or transcript viewing.
- [ ] Deferred sessions show temporary, explicitly unconfirmed labels until evidence-backed identity resolution completes.
- [ ] Full Jarvis tests, typecheck, lint, and consented evaluation gates pass.
