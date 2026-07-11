# Jarvis Evidence-Based Memory and Personal-Agent Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn complete transcripts and confirmed speaker context into durable, evidence-linked memories, topics, commitments, todos, daily reviews, and forward-looking suggestions without inventing facts or silently overwriting history.

**Architecture:** Durable analysis jobs consume immutable transcript and identity revisions. MiniMax receives pseudonymized text only and returns a strictly validated candidate analysis. A deterministic local merger owns persistence, versioning, deduplication, conflicts, and evidence links. Daily digests are versioned views over stored evidence; planning outputs remain suggestions until the user explicitly accepts them.

**Tech Stack:** Electron, Node.js, better-sqlite3, MiniMax text API, existing Jarvis repository and analysis client, React, Zustand, Node test runner, Vitest, Testing Library.

## Global Constraints

- Phases 1–3 are prerequisites.
- MiniMax may receive transcript text and pseudonymous speaker labels only—never raw audio, embeddings, device names, filesystem paths, API keys, or confirmed real names.
- Every factual output must point to persisted evidence.
- AI output is untrusted input and must pass structural and semantic validation.
- Cloud failure must not block capture, transcript viewing, playback, or manual memory access.
- Existing summaries, memories, topics, and todos must be preserved and imported idempotently.

---

### Task 1: Add revisioned analysis and memory lineage storage

**Files:**
- Modify: `app/src/jarvis/main/JarvisMigrations.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Create: `app/src/jarvis/main/MemoryRepository.js`
- Test: `app/test/jarvis/MemoryRepository.test.js`

- [ ] **Step 1: Write failing migration and lineage tests**

Prove that:

- the same analysis input revision can be applied once only;
- regenerating a digest creates a new revision and supersedes, rather than deletes, the previous one;
- every fact, commitment, todo, and event has at least one evidence reference;
- suggestions may exist without evidence only when explicitly typed `suggestion`;
- conflicting memories coexist with `conflict` state until resolved;
- deleting expired audio leaves transcript evidence links intact and marks audio unavailable.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:main -- test/jarvis/MemoryRepository.test.js`

Expected: FAIL because revision and lineage methods do not exist.

- [ ] **Step 3: Add idempotent schema extensions**

Add or migrate these fields/tables:

```sql
CREATE TABLE IF NOT EXISTS analysis_inputs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  transcript_revision TEXT NOT NULL,
  identity_revision TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN
    ('fact','event','decision','commitment','preference','relationship','suggestion')),
  canonical_key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  confidence REAL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','superseded','conflict','dismissed')),
  supersedes_id TEXT REFERENCES memory_items_v2(id) ON DELETE SET NULL,
  source_analysis_input_id TEXT REFERENCES analysis_inputs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_refs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  transcript_segment_id TEXT REFERENCES transcript_segments(id) ON DELETE SET NULL,
  track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  quote_text TEXT,
  audio_state TEXT NOT NULL DEFAULT 'available'
    CHECK(audio_state IN ('available','expired','missing')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_digests (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('partial','final','superseded')),
  content_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  supersedes_id TEXT REFERENCES daily_digests(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(local_date, revision)
);
```

Do not drop legacy `memories`, `memory_evidence`, `session_summaries`, `topics`, or `todos`. Add an import marker and copy them into the new lineage model once, keeping their original IDs in an `external_key` or migration mapping.

- [ ] **Step 4: Implement the repository contract**

```js
class MemoryRepository {
  createAnalysisInput(input) {}
  getAnalysisInputByHash(inputHash) {}
  applyCandidateAnalysis(input) {}
  listEvidence(entityType, entityId) {}
  supersedeMemory(input) {}
  recordConflict(input) {}
  resolveConflict(input) {}
  saveDigestRevision(input) {}
  getLatestDigest(localDate) {}
  importLegacyAnalysis() {}
}
```

`applyCandidateAnalysis` must be a single transaction. It must reject evidence that references another session, missing segment ranges, or a factual entity with zero evidence. The repository—not the model—assigns IDs, timestamps, revisions, and state transitions.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/MemoryRepository.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/JarvisMigrations.js app/src/jarvis/main/JarvisRepository.js app/src/jarvis/main/MemoryRepository.js app/test/jarvis/MemoryRepository.test.js
git commit -m "feat: add evidence based memory lineage"
```

---

### Task 2: Define and enforce the MiniMax analysis boundary

**Files:**
- Modify: `app/src/jarvis/main/JarvisAnalysisSchema.js`
- Modify: `app/src/jarvis/main/MiniMaxAnalysisClient.js`
- Create: `app/src/jarvis/main/AnalysisInputBuilder.js`
- Test: `app/test/jarvis/JarvisAnalysisSchema.test.js`
- Test: `app/test/jarvis/MiniMaxAnalysisClient.test.js`
- Test: `app/test/jarvis/AnalysisInputBuilder.test.js`

- [ ] **Step 1: Write failing privacy and schema tests**

Test that the input builder:

- replaces people with stable per-request labels such as `P1`, `P2`, and `SELF`;
- strips device names, absolute paths, API-key-shaped strings, and embedding fields;
- sends transcript text, segment IDs, timestamps, and pseudonymous speaker labels only;
- truncates by complete segments and records omitted ranges;
- never mutates stored transcript text.

Test that schema validation rejects:

- `todos` or any collection returned as an object/string instead of an array;
- unknown top-level keys;
- facts, decisions, commitments, or todos without evidence segment IDs;
- evidence IDs outside the submitted input;
- malformed confidence, dates, or enum values;
- model-generated IDs or state transitions.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/AnalysisInputBuilder.test.js test/jarvis/JarvisAnalysisSchema.test.js test/jarvis/MiniMaxAnalysisClient.test.js`

Expected: FAIL on the stricter contract.

- [ ] **Step 3: Implement a closed candidate schema**

Use a discriminated structure:

```js
const candidateAnalysisShape = {
  schemaVersion: 'jarvis-analysis-v2',
  sessionSummary: {
    title: 'string',
    summary: 'string',
    evidenceSegmentIds: ['segment-id'],
  },
  memories: [{
    kind: 'fact|event|decision|commitment|preference|relationship',
    title: 'string',
    body: 'string',
    confidence: 0.0,
    evidenceSegmentIds: ['segment-id'],
  }],
  topics: [{ name: 'string', summary: 'string', evidenceSegmentIds: ['segment-id'] }],
  todos: [{ title: 'string', ownerLabel: 'SELF|P1|null', dueText: null, evidenceSegmentIds: ['segment-id'] }],
  suggestions: [{ title: 'string', rationale: 'string', basedOnEvidenceSegmentIds: [] }],
}
```

The actual validator must reject extra keys recursively. `suggestions` are never persisted as todos automatically. `dueText` stays unparsed when ambiguous; the model cannot set a calendar date silently.

- [ ] **Step 4: Harden response extraction and errors**

`MiniMaxAnalysisClient` must extract one JSON object from either direct JSON or a fenced response, enforce a byte limit, validate it, and return typed failures:

```js
class AnalysisClientError extends Error {
  constructor(code, message, { retryable, cause } = {}) {}
}
// code: network | rate_limit | invalid_json | invalid_structure | budget_exceeded
```

Never log the API key or full transcript. Log request ID, input hash, byte count, duration, token/cost estimate, and error code.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/AnalysisInputBuilder.test.js test/jarvis/JarvisAnalysisSchema.test.js test/jarvis/MiniMaxAnalysisClient.test.js`

Expected: PASS, including regression coverage for `todos must be an array` and `invalid structure`.

```bash
git add app/src/jarvis/main/AnalysisInputBuilder.js app/src/jarvis/main/JarvisAnalysisSchema.js app/src/jarvis/main/MiniMaxAnalysisClient.js app/test/jarvis/AnalysisInputBuilder.test.js app/test/jarvis/JarvisAnalysisSchema.test.js app/test/jarvis/MiniMaxAnalysisClient.test.js
git commit -m "feat: enforce minimax analysis boundary"
```

---

### Task 3: Run analysis as durable, restart-safe jobs

**Files:**
- Create: `app/src/jarvis/main/JarvisAnalysisWorker.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/AnalysisScheduler.js`
- Modify: `app/main.js`
- Test: `app/test/jarvis/JarvisAnalysisWorker.test.js`
- Test: `app/test/jarvis/AnalysisScheduler.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

Prove:

- a ten-minute checkpoint creates `analyze_session:<sessionId>:<inputHash>` only when transcript revision changed;
- stopping a session enqueues final analysis after transcription, reconciliation, diarization, and identity jobs are terminal;
- app restart reclaims an interrupted analysis job;
- retryable network/rate-limit failures back off without losing the job;
- invalid structure is terminal for that input hash and visible in status;
- a later transcript revision creates a new analysis input and superseding output;
- capture and playback remain usable while analysis is offline.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AnalysisScheduler.test.js`

Expected: FAIL because analysis is currently in-memory or success-only.

- [ ] **Step 3: Implement the worker**

```js
class JarvisAnalysisWorker {
  constructor({ jobs, repository, memories, inputBuilder, client, budgetGuard, clock }) {}

  async run(job) {
    const input = this.inputBuilder.build(job.payload)
    const existing = this.memories.getAnalysisInputByHash(input.hash)
    if (existing?.applied) return { status: 'already_applied' }
    await this.budgetGuard.assertAllowed(input.estimatedCostUsd)
    const candidate = await this.client.analyze(input.request)
    return this.memories.applyCandidateAnalysis({ input, candidate })
  }
}
```

Replace `AnalysisScheduler` timers with enqueue-only behavior; `JarvisProcessingRuntime` owns execution. Preserve the existing ten-minute checkpoint and stop-triggered final summary semantics, but make them durable. Use exponential retry with bounded jitter for retryable cloud failures. Budget-exceeded remains pending/blocked with a user-visible reason and requires explicit budget change or manual retry.

- [ ] **Step 4: Wire startup and shutdown**

Construct one processing runtime in `main.js`, register all workers before recovery, and stop claiming new jobs during app shutdown while allowing the current SQLite transaction to finish. Do not hold raw audio buffers in the analysis worker.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AnalysisScheduler.test.js test/jarvis/ProcessingJobRunner.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/JarvisAnalysisWorker.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/jarvis/main/AnalysisScheduler.js app/main.js app/test/jarvis/JarvisAnalysisWorker.test.js app/test/jarvis/AnalysisScheduler.test.js app/test/jarvis/ProcessingJobRunner.test.js
git commit -m "feat: make jarvis analysis restart safe"
```

---

### Task 4: Merge candidate memories deterministically

**Files:**
- Create: `app/src/jarvis/main/MemoryMerger.js`
- Modify: `app/src/jarvis/main/MemoryRepository.js`
- Test: `app/test/jarvis/MemoryMerger.test.js`

- [ ] **Step 1: Write failing merge-rule tests**

Cover each rule independently:

- identical canonical topic keys merge occurrences while retaining every evidence link;
- similar but non-identical topics remain separate and receive a merge suggestion;
- repeated events with the same canonical key/time window deduplicate;
- a newer changed fact supersedes the old one and links both directions;
- contradictory facts enter conflict state rather than overwriting each other;
- completed todos are never reopened by repeated analysis;
- a suggestion never becomes a todo without user acceptance;
- applying the same candidate twice is a no-op.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/MemoryMerger.test.js`

Expected: FAIL because deterministic merge rules are absent.

- [ ] **Step 3: Implement pure planning plus transactional application**

```js
class MemoryMerger {
  plan({ existing, candidate, evidence }) {
    return {
      inserts: [],
      occurrenceLinks: [],
      supersessions: [],
      conflicts: [],
      mergeSuggestions: [],
      ignoredDuplicates: [],
    }
  }
}
```

Keep `plan` pure and unit-testable. Canonical keys come from local normalization of entity type, normalized title/name, related person IDs, and bounded date—not from an opaque model ID. Apply the resulting plan through one `MemoryRepository` transaction. If any evidence link is invalid, roll back the entire candidate analysis.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:main -- test/jarvis/MemoryMerger.test.js test/jarvis/MemoryRepository.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/MemoryMerger.js app/src/jarvis/main/MemoryRepository.js app/test/jarvis/MemoryMerger.test.js app/test/jarvis/MemoryRepository.test.js
git commit -m "feat: merge memories with deterministic lineage"
```

---

### Task 5: Generate versioned daily reviews and planning suggestions

**Files:**
- Create: `app/src/jarvis/main/DailyDigestService.js`
- Create: `app/src/jarvis/main/DailyDigestScheduler.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Test: `app/test/jarvis/DailyDigestService.test.js`
- Test: `app/test/jarvis/DailyDigestScheduler.test.js`

- [ ] **Step 1: Write failing date, revision, and safety tests**

Use a fake clock and explicit `Asia/Shanghai` timezone. Verify:

- crossing local midnight finalizes the previous local day once;
- an open session spanning midnight is split by evidence timestamps, not assigned wholly to stop date;
- incomplete processing produces a `partial` digest and later completion produces a superseding `final` revision;
- manual regeneration is idempotent for the same source hash;
- new evidence creates the next revision;
- future planning is labeled suggestion and never writes a calendar or todo automatically;
- an offline MiniMax client leaves a retryable job and the latest existing digest visible.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/DailyDigestService.test.js test/jarvis/DailyDigestScheduler.test.js`

Expected: FAIL because digest services do not exist.

- [ ] **Step 3: Implement deterministic digest inputs**

Build the source set locally from evidence timestamps and include:

```js
{
  localDate,
  timezone,
  sessions,
  peopleInteractions,
  topics,
  decisions,
  commitments,
  todosCreated,
  todosCompleted,
  unresolvedConflicts,
  transcriptCoverage,
}
```

Generate sections: `今天发生了什么`, `与谁交流`, `主题与决定`, `承诺与待办`, `值得记住`, `明日建议`, and `处理完整度`. Each non-suggestion item must retain its evidence IDs. Suggestions must include rationale and a user action to accept, dismiss, or convert to todo.

- [ ] **Step 4: Schedule and expose regeneration**

The scheduler enqueues `daily_digest:<localDate>:<sourceHash>` after midnight, on final processing completion, and on explicit manual regeneration. IPC exposes `getDailyDigest(localDate)` and `regenerateDailyDigest(localDate)`; regeneration returns the current job state immediately rather than blocking the renderer.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:main -- test/jarvis/DailyDigestService.test.js test/jarvis/DailyDigestScheduler.test.js`

Expected: PASS.

```bash
git add app/src/jarvis/main/DailyDigestService.js app/src/jarvis/main/DailyDigestScheduler.js app/src/jarvis/main/JarvisProcessingRuntime.js app/src/jarvis/main/registerJarvisIpc.js app/test/jarvis/DailyDigestService.test.js app/test/jarvis/DailyDigestScheduler.test.js
git commit -m "feat: add evidence based daily reviews"
```

---

### Task 6: Make evidence, revisions, and suggestions visible in the GUI

**Files:**
- Create: `app/src/jarvis/renderer/EvidenceLink.tsx`
- Create: `app/src/jarvis/renderer/DailyReviewView.tsx`
- Create: `app/src/jarvis/renderer/AnalysisStatus.tsx`
- Modify: `app/src/jarvis/renderer/TodayView.tsx`
- Modify: `app/src/jarvis/renderer/MemoryView.tsx`
- Modify: `app/src/jarvis/renderer/TopicsView.tsx`
- Modify: `app/src/jarvis/renderer/TodosView.tsx`
- Modify: `app/src/jarvis/renderer/PeopleView.tsx`
- Modify: `app/src/jarvis/renderer/jarvisStore.ts`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Test: `app/src/jarvis/renderer/EvidenceLink.test.tsx`
- Test: `app/src/jarvis/renderer/DailyReviewView.test.tsx`
- Test: `app/src/jarvis/renderer/MemoryView.test.tsx`
- Test: `app/src/jarvis/renderer/TodosView.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Prove that:

- clicking evidence opens the correct session and seeks the continuous player to `startMs`;
- expired audio shows transcript evidence with `音频已按保留策略删除`;
- superseded and conflicting memories are distinguishable and historical revisions are viewable;
- suggestions have accept/dismiss/convert controls and are not styled as confirmed todos;
- partial daily reviews show transcript and analysis completeness;
- cloud errors show retry state without hiding saved content;
- People, Topics, Todos, and Memory navigation entries render persisted data after restart.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:renderer -- src/jarvis/renderer/EvidenceLink.test.tsx src/jarvis/renderer/DailyReviewView.test.tsx src/jarvis/renderer/MemoryView.test.tsx src/jarvis/renderer/TodosView.test.tsx`

Expected: FAIL on missing components and state.

- [ ] **Step 3: Add typed evidence navigation**

```ts
export type EvidenceContext = {
  sessionId: string
  sessionTitle: string
  trackId: string | null
  sourceType: 'mic' | 'system' | null
  transcriptSegmentId: string | null
  startMs: number | null
  endMs: number | null
  quoteText: string | null
  audioState: 'available' | 'expired' | 'missing'
}
```

IPC `jarvis:evidence:get-context` validates the entity and evidence IDs, then returns only stored fields. `EvidenceLink` delegates navigation to the shared store, which selects the session and seeks the continuous player. It must not assemble a filesystem path in the renderer.

- [ ] **Step 4: Implement views and explicit state labels**

Add a Daily Review section to Today. Across Memory, Topics, Todos, and People, show evidence count, source session/date, status, revision, and conflicts where relevant. Keep Chinese primary labels and existing i18n conventions. Never imply that a suggestion or medium-confidence speaker match is confirmed.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:renderer -- src/jarvis/renderer/EvidenceLink.test.tsx src/jarvis/renderer/DailyReviewView.test.tsx src/jarvis/renderer/MemoryView.test.tsx src/jarvis/renderer/TodosView.test.tsx`

Expected: PASS.

```bash
git add app/src/jarvis/renderer/EvidenceLink.tsx app/src/jarvis/renderer/DailyReviewView.tsx app/src/jarvis/renderer/AnalysisStatus.tsx app/src/jarvis/renderer/TodayView.tsx app/src/jarvis/renderer/MemoryView.tsx app/src/jarvis/renderer/TopicsView.tsx app/src/jarvis/renderer/TodosView.tsx app/src/jarvis/renderer/PeopleView.tsx app/src/jarvis/renderer/jarvisStore.ts app/src/jarvis/types.ts app/src/jarvis/main/registerJarvisIpc.js app/src/jarvis/renderer/EvidenceLink.test.tsx app/src/jarvis/renderer/DailyReviewView.test.tsx app/src/jarvis/renderer/MemoryView.test.tsx app/src/jarvis/renderer/TodosView.test.tsx
git commit -m "feat: expose evidence based agent output"
```

---

### Task 7: Enforce privacy, budget, migration, and release acceptance

**Files:**
- Create: `app/src/jarvis/main/AnalysisBudgetGuard.js`
- Create: `app/test/jarvis/AnalysisBudgetGuard.test.js`
- Create: `app/test/jarvis/AnalysisPrivacyBoundary.test.js`
- Create: `app/test/jarvis/LegacyAnalysisMigration.test.js`
- Modify: `app/src/jarvis/main/MiniMaxAnalysisClient.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Write failing budget, privacy, and migration tests**

Budget tests must verify configurable monthly hard limits of `$5` and `$10`, persisted usage across restart, reservation before a request, reconciliation after actual usage, and refusal without deleting pending work. Privacy tests inspect the exact HTTP payload and logs. Migration tests use a copied fixture database with legacy sessions, summaries, memories, topics, and todos and assert stable counts plus idempotence.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:main -- test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/AnalysisPrivacyBoundary.test.js test/jarvis/LegacyAnalysisMigration.test.js`

Expected: FAIL on missing durable budget accounting and migration coverage.

- [ ] **Step 3: Implement the hard budget guard**

```js
class AnalysisBudgetGuard {
  getStatus(month) {}
  setMonthlyLimitUsd(limit) {}
  reserve({ requestId, estimatedUsd }) {}
  reconcile({ requestId, actualUsd }) {}
  release(requestId) {}
}
```

Accept only limits from `$0` through `$10`; default to `$5`. Reservation and reconciliation are SQLite transactions. Concurrent workers must not exceed the limit. Expose status and limit changes through settings IPC, but never expose or log the subscription key.

- [ ] **Step 4: Add release-level verification**

Run:

```bash
cd app
npm run test:jarvis
npm run typecheck
npm run lint
npm run i18n:check
npm run build:renderer
npm run build:win:unsigned
```

Expected: all commands exit `0`; unsigned Windows package launches against a copied user-data directory, displays migrated history, records without MiniMax access, and shows analysis as retryable/offline rather than crashing.

Perform a manual acceptance session with consent:

1. Record at least 15 minutes with microphone and system sound.
2. Confirm complete transcript coverage and continuous playback.
3. Verify self/unknown speaker labels, then correct one identity.
4. Stop and wait for final analysis.
5. Open every summary, memory, topic, and todo evidence link.
6. Restart the app and confirm all items and revisions remain.
7. Advance a copied test profile past seven days and verify only audio expires.

- [ ] **Step 5: Commit the release gates**

```bash
git add app/src/jarvis/main/AnalysisBudgetGuard.js app/src/jarvis/main/MiniMaxAnalysisClient.js app/src/jarvis/main/registerJarvisIpc.js app/test/jarvis/AnalysisBudgetGuard.test.js app/test/jarvis/AnalysisPrivacyBoundary.test.js app/test/jarvis/LegacyAnalysisMigration.test.js docs/TESTING.md
git commit -m "test: gate jarvis privacy budget and migration"
```

---

## Phase Acceptance Checklist

- [ ] Every factual memory, topic, decision, commitment, todo, and summary line has stored evidence.
- [ ] MiniMax receives pseudonymized transcript text only; raw audio, embeddings, paths, device names, real names, and secrets stay local.
- [ ] Invalid or unexpected MiniMax structures cannot reach the database.
- [ ] Analysis jobs survive restart, retry safely, and never block recording or playback.
- [ ] Repeated analysis is idempotent; changed inputs create revisions and lineage.
- [ ] Similar memories are suggested for merging; conflicting facts are not silently overwritten.
- [ ] Daily reviews respect local-day boundaries, processing completeness, and revision history.
- [ ] Future plans remain suggestions until explicitly accepted.
- [ ] People, Topics, Todos, Memory, and Daily Review display persisted data after restart.
- [ ] The `$5` default and `$10` maximum monthly cloud budget are enforced durably.
- [ ] Legacy analysis data imports once without data loss.
- [ ] Full Jarvis tests, typecheck, lint, i18n, renderer build, Windows package build, and manual acceptance pass.
