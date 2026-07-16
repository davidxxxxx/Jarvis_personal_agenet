# Jarvis Versioned Daily Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce restart-safe, evidence-backed daily reviews whose partial and final revisions are deterministic, budget-governed, and retrievable without ever turning model suggestions into automatic user actions.

**Architecture:** A v29 migration adds immutable daily-digest input and response-candidate records and lets digest jobs exist without a fake session owner. `MemoryRepository` builds one canonical local-day snapshot from evidence timestamps in a half-open IANA-timezone interval. A dedicated digest worker validates MiniMax output, persists paid responses before applying them, and atomically saves a revision plus evidence lineage. `AgentCloudDispatcher` remains the single cloud lane and routes priority-70 session analysis before priority-80 daily digests. A scheduler converges midnight, processing-complete, startup, and manual triggers on the same source hash and job.

**Tech Stack:** Node.js 24, Electron 41, CommonJS, `better-sqlite3`, `node:test`, `Intl.DateTimeFormat` with canonical IANA timezones, existing MiniMax and budget-guard infrastructure.

## Global Constraints

- Write caches, temporary files, installers, and generated artifacts only under `G:\Jarvis`; every command must set `TEMP`, `TMP`, `npm_config_cache`, `ELECTRON_CACHE`, and `ELECTRON_BUILDER_CACHE` to the existing `G:\Jarvis\.runtime-cache` directories.
- Use test-driven development: add a focused failing test, observe the intended failure, implement the smallest complete behavior, and rerun the focused plus named regression suite.
- Never persist or send credentials, audio/device paths, raw speaker embeddings, confirmed local identity names, speaker/device identity metadata, or unrelated transcript history in a digest payload. Transcript free text remains necessary evidence and is deterministically scrubbed against the current local-day speaker/cluster/device vocabulary, the small confirmed-people dictionary, and generic credential/path patterns. This boundary does not claim that arbitrary unknown names in natural-language text are detected.
- Future privacy hardening depends on a local-only NER implementation plus an evaluation gate before any unknown-name-detection claim; Task 5A must not substitute an unmeasured heuristic for that dependency.
- Treat `[startsAt, endsAt)` as the only day-membership rule. Evidence exactly at local midnight belongs only to the new day.
- `partial` and `final` are source properties, not renderer guesses. Retry counters, lease timestamps, and queue timing must not alter `sourceHash`.
- Every factual digest item must reference evidence segment IDs from its immutable input. Suggestions must be explicitly typed and may only expose accept, dismiss, or convert-to-todo actions; this phase never creates a todo, calendar event, message, or external side effect.
- A paid/validated provider response must be durably stored before it is applied. Crash recovery must reuse it without a second cloud request.
- Offline or retryable provider errors leave the latest active digest visible and a retryable job durable. Ambiguous post-send usage follows the existing `usage_unknown` safety policy and is not blindly resent.
- Public IPC returns only allowlisted digest content, evidence links, completeness/revision metadata, and job status. It must not expose prompts, source payloads, watermarks, hashes, candidates, leases, or budget internals.

---

## Task 5A: Durable daily-digest inputs, jobs, and local-day boundaries

**Files:**

- Modify: `app/src/jarvis/main/JarvisMigrations.js` (this repository keeps numbered schema upgrades in the central migration module rather than a `migrations/` directory)
- Modify: `app/src/jarvis/main/ZonedCalendar.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Modify: `app/src/jarvis/main/MemoryRepository.js`
- Test: `app/test/jarvis/JarvisMigrations.test.js`
- Test: `app/test/jarvis/ZonedCalendar.test.js`
- Test: `app/test/jarvis/CaptureEvidenceStore.test.js`
- Test: `app/test/jarvis/DailyDigestInput.test.js`

- [ ] **Step 1: Add failing timezone-boundary tests**

Add `localDateAt({ at, timezone })` and `resolveLocalDate({ localDate, timezone })` contract tests. Cover `Asia/Shanghai`, a DST spring-forward day, a DST fall-back day, invalid calendar dates, non-canonical timezone aliases, and exact-midnight half-open membership.

Run:

```powershell
npm run test:main -- test/jarvis/ZonedCalendar.test.js
```

Expected: FAIL because the two public helpers do not exist.

- [ ] **Step 2: Implement canonical local-date resolution**

Reuse the existing bounded instant search in `ZonedCalendar.js`; do not introduce host-local `Date` parsing. `resolveLocalDate` returns exactly `{ localDate, timezone, startsAt, endsAt }`, with safe-integer UTC millisecond bounds and `endsAt > startsAt`.

- [ ] **Step 3: Add hostile v29 migration tests before the migration**

Build fixtures from v28 and from adversarial schemas containing extra indexes, same-name triggers, partial v29 objects, and valid existing processing rows. Assert:

- `daily_digest_inputs` is immutable and stores `id`, `local_date`, `timezone`, `source_hash`, `contract_version`, `completeness`, `input_watermark_json`, `cloud_payload_json`, `input_bytes`, `model_version`, and `created_at`;
- `daily_digest_response_candidates` stores one validated candidate per job with candidate bytes/hash, budget attempt, state, and disposition time;
- `processing_jobs.session_id` is nullable only for `generate_daily_digest`;
- digest jobs require `digest_input_id`, forbid analysis identity fields, use lane `cloud` and priority `80`, and do not depend on a session row;
- analysis jobs continue requiring `session_id`, `analysis_input_id`, and `desired_head_hash` at priority `70`;
- all other job kinds continue requiring a session and forbid both cloud input IDs;
- digest input and candidate foreign keys use `ON DELETE RESTRICT` where paid/reproducible history must survive;
- existing rows, indexes, triggers, constraints, and foreign-key integrity survive upgrade;
- any migration failure restores schema version 28 and the exact pre-upgrade schema/data.

Run:

```powershell
npm run test:main -- test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js
```

Expected: FAIL because v29 and digest job identity do not exist.

- [ ] **Step 4: Implement v29 as an all-or-nothing table rebuild**

Use the established migration transaction and schema-conflict lifecycle from v28. Preserve every supported v28 job column. Recreate owned indexes/triggers only after the replacement table is fully validated. Reject or safely replace colliding owned object names; do not drop unrelated objects. Add database-level insert/update guards for all three job families.

- [ ] **Step 5: Add failing deterministic-input tests**

In `DailyDigestInput.test.js`, seed multiple sessions including an open session spanning midnight. Assert:

- membership comes from evidence/segment timestamps, not session start/stop date;
- exact-midnight evidence occurs only in the next input;
- stable ordering makes insertion order irrelevant;
- the canonical source contains fixed sections `sessions`, `peopleInteractions`, `topics`, `decisions`, `commitments`, `todosCreated`, `todosCompleted`, `unresolvedConflicts`, and `transcriptCoverage`;
- `inputWatermark` includes stable evidence/version/readiness facts but excludes retry count, lease owner, lease expiry, and next-attempt time;
- explicit pending upstream work makes the input `partial`; no pending upstream work makes it `final`;
- pseudonymous subject IDs are allowed; confirmed local identity names, current-day speaker/cluster/device labels and IDs, audio paths, embeddings, and generic credential/path patterns are rejected from `cloudPayload`. Arbitrary unknown names inside evidence text are outside this phase's enforceable claim;
- same canonical bytes reuse the same input/source hash; new evidence produces a new immutable input;
- a restart can load the exact input bytes without rebuilding from mutable tables.

Expected: FAIL because no daily-digest input builder exists.

- [ ] **Step 6: Implement immutable source creation and digest job APIs**

Add repository/store methods with exact object contracts:

```js
memoryRepository.createDailyDigestInput({ localDate, timezone, modelVersion })
memoryRepository.getDailyDigestInput(inputId)
memoryRepository.getDailyDigestInputBySourceHash(sourceHash)
store.enqueueDailyDigestJob({ digestInputId, inputHash, inputVersion, modelVersion })
store.wakeDailyDigestJob({ digestInputId, at })
store.getDailyDigestJobByInput(digestInputId)
```

Create the snapshot in one database read transaction. Serialize through the project canonical JSON helper and calculate `source_hash` from contract version, local date, timezone, completeness, watermark, and payload. Enqueue with `session_id = NULL`, priority 80, lane cloud, and a uniqueness identity based on the digest input rather than a session. Empty days return an explicit `{ status: "empty" }` result and do not spend cloud budget.

- [ ] **Step 7: Verify 5A and commit**

Run:

```powershell
npm run test:main -- test/jarvis/ZonedCalendar.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/DailyDigestInput.test.js test/jarvis/MemoryRepository.test.js
npm run lint
```

Expected: PASS with no foreign-key check rows and no C-drive cache writes.

Commit:

```powershell
git add app/src/jarvis/main app/test/jarvis docs/superpowers/plans/2026-07-17-jarvis-daily-digest-task5.md
git commit -m "feat: persist deterministic daily digest inputs"
```

Request fresh spec and code-quality review before 5B. Resolve every critical, important, and medium finding and rerun the 5A suite.

---

## Task 5B: Hardened digest generation, candidate recovery, and evidence-backed revisions

**Files:**

- Create: `app/src/jarvis/main/DailyDigestSchema.js`
- Create: `app/src/jarvis/main/MiniMaxDailyDigestClient.js`
- Create: `app/src/jarvis/main/DailyDigestService.js`
- Modify: `app/src/jarvis/main/MemoryRepository.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`
- Test: `app/test/jarvis/DailyDigestSchema.test.js`
- Test: `app/test/jarvis/MiniMaxDailyDigestClient.test.js`
- Test: `app/test/jarvis/DailyDigestService.test.js`
- Test: `app/test/jarvis/MemoryRepository.test.js`

- [ ] **Step 1: Lock the output schema with failing tests**

The validated output has this exact stable shape:

```js
{
  schemaVersion: "jarvis-daily-digest-v1",
  sections: {
    today: [{ text, evidenceSegmentIds }],
    interactions: [{ subjectRef, text, evidenceSegmentIds }],
    topicsAndDecisions: [{ text, evidenceSegmentIds }],
    commitmentsAndTodos: [{ text, evidenceSegmentIds }],
    worthRemembering: [{ text, evidenceSegmentIds }],
    tomorrowSuggestions: [{ text, rationale, evidenceSegmentIds, allowedActions }]
  },
  processing: {
    completeness,
    missingStages,
    transcriptCoverage
  }
}
```

Reject unknown keys, duplicate IDs, IDs outside the immutable input, empty evidence for factual items, unknown subject references, oversized strings/arrays/payloads, model-controlled entity IDs/timestamps, unsupported actions, mismatched completeness, and any automatic-action instruction. `allowedActions` is exactly a nonempty subset of `accept`, `dismiss`, and `convert_to_todo`.

Run the new schema test and observe failure before implementation.

- [ ] **Step 2: Add failing MiniMax transport tests**

Mirror the existing official-host, redirect, timeout, byte-limit, credential-redaction, one-request, and authoritative-usage cases from `MiniMaxAnalysisClient`, but keep the digest prompt and response validator operation-specific. Assert that logs never contain the subscription key, request body, transcript text, names, or evidence content.

- [ ] **Step 3: Implement the dedicated digest client**

Share a narrow internal HTTP transport only if existing analysis-client behavior remains byte-for-byte compatible; otherwise keep an independent client. The client accepts only a validated persisted `cloudPayload`, sends one request to an allowlisted MiniMax HTTPS origin, and returns `{ result, usage, requestBytes, responseBytes }`. It never reads renderer input or environment credentials at module load time.

- [ ] **Step 4: Add failing revision and crash-recovery tests**

Assert:

- same source hash is idempotent and does not increment revision;
- new source creates the next revision and supersedes the prior active row;
- a `final` revision supersedes `partial`, while later `partial` cannot replace active `final` for the same day;
- revision content and the union of its evidence segment IDs save in one transaction;
- a failed evidence insert leaves the prior active digest unchanged;
- public snapshots expose evidence links but hide source hash, watermark, input/candidate IDs, leases, and budget attempts;
- a validated candidate is persisted before apply; simulated crash after candidate persistence replays it with zero network calls;
- the same paid candidate cannot be applied to a different input/job;
- offline/authoritative-zero-usage errors remain retryable with bounded backoff and leave the existing digest visible;
- ambiguous post-send usage becomes `usage_unknown`/blocked and is not automatically resent;
- invalid model output reconciles authoritative usage, blocks the job, and does not alter active memory.

- [ ] **Step 5: Implement atomic digest persistence**

Extend `saveDigestRevision` with exact `evidenceSegmentIds`. Validate the entire set before inserting. In one immediate transaction, insert/reuse the digest revision, upsert `evidence_refs` for `entity_type = 'daily_digest'`, update supersession/lifecycle, and verify same-source replay has the identical evidence set and content. Add candidate APIs:

```js
memoryRepository.persistValidatedDailyDigestCandidate({
  jobId,
  digestInputId,
  budgetAttemptId,
  candidate
})
memoryRepository.listRecoverableDailyDigestCandidates()
memoryRepository.applyValidatedDailyDigestCandidate({ candidateId, leaseOwner })
```

Applying a candidate validates job lease, digest input identity, candidate hash/bytes, budget reconciliation, and evidence membership before changing active digest state.

- [ ] **Step 6: Implement `DailyDigestService` as a cloud worker**

Expose:

```js
service.prepare({ localDate })
service.execute(claimedJob)
service.recoverCandidate(candidate)
service.getLatest({ localDate })
service.regenerate({ localDate })
```

Use the same durable budget transition discipline as `JarvisAnalysisWorker`, with operation `daily_digest`. Re-check input and admission immediately before `markStarted`. Record execution device `cloud`. Store a validated response candidate before applying and completing the job. Regeneration reuses/wakes the existing source job; it does not create a duplicate request.

- [ ] **Step 7: Verify 5B and commit**

Run:

```powershell
npm run test:main -- test/jarvis/DailyDigestSchema.test.js test/jarvis/MiniMaxDailyDigestClient.test.js test/jarvis/DailyDigestService.test.js test/jarvis/MemoryRepository.test.js test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/JarvisAnalysisWorker.test.js
npm run lint
```

Commit:

```powershell
git add app/src/jarvis/main app/test/jarvis
git commit -m "feat: generate evidence backed daily digests"
```

Request fresh spec and code-quality review before 5C. Resolve every critical, important, and medium finding and rerun the 5A+5B union suite.

---

## Task 5C: Trigger convergence, shared cloud routing, runtime lifecycle, and private IPC

**Files:**

- Create: `app/src/jarvis/main/DailyDigestScheduler.js`
- Modify: `app/src/jarvis/main/AgentCloudDispatcher.js`
- Modify: `app/src/jarvis/main/JarvisProcessingRuntime.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/src/jarvis/shared/contracts.js`
- Modify: `app/preload.js`
- Modify: `app/main.js`
- Test: `app/test/jarvis/DailyDigestScheduler.test.js`
- Test: `app/test/jarvis/AgentCloudDispatcher.test.js`
- Test: `app/test/jarvis/JarvisProcessingRuntime.test.js`
- Test: `app/test/jarvis/registerJarvisIpc.test.js`
- Test: the preload contract test discovered by `rg "jarvis:analysis:run|contextBridge" app/test`

- [ ] **Step 1: Add failing scheduler convergence tests**

With a fake clock/timezone provider, assert:

- startup prepares the immediately previous local day once;
- crossing local midnight prepares the prior day once, including after a suspended process skips multiple ticks;
- a final-processing completion prepares a new source and superseding final revision only when its stable source changed;
- manual regeneration and concurrent midnight/final-ready triggers converge on one input/job;
- restart does not duplicate completed or retryable jobs;
- an offline job is woken for manual retry but the call returns immediately;
- renderer callers cannot choose a timezone;
- empty days do not enqueue a cloud request.

- [ ] **Step 2: Implement `DailyDigestScheduler`**

Use trusted `timezoneProvider()` and `now()`. Expose `start()`, `tick()`, `onSessionReady(sessionId)`, `getDailyDigest(localDate)`, `regenerate(localDate)`, and `stop()`. Persist all durable work through `DailyDigestService`; in-memory date markers are only an optimization and never the idempotency boundary.

- [ ] **Step 3: Add failing shared-dispatcher tests**

Assert one cloud job is in flight at a time; priority-70 session analysis precedes priority-80 digest; job type routes only to its registered worker; digest candidate/prestart lease recovery works on startup; unknown cloud job types are safely blocked; worker errors do not let a second cloud job overlap; stop waits for current execution and prevents further claims.

- [ ] **Step 4: Convert `AgentCloudDispatcher` to an exact worker registry**

Accept workers keyed by `analyze_session` and `generate_daily_digest`. Claim cloud jobs through priority 80 (`priorityBefore: 81`) and let the database ordering decide priority. Route `execute` and candidate recovery by exact job type. Preserve all current analysis-only tests and behavior.

- [ ] **Step 5: Add failing runtime lifecycle tests**

Verify startup recovery and cloud tick happen after local foundations initialize; `_drain` invokes the shared cloud lane without overlap; successful `refreshSessionReadiness` notifies the digest scheduler; local date ticks run while capture continues; stop halts the scheduler and joins dispatcher work. Repeated start/stop and partial initialization failure must not leak timers, claims, or listeners.

- [ ] **Step 6: Wire runtime and production composition**

Construct the digest repository/service/client/worker/scheduler and the shared dispatcher in `app/main.js` with the existing trusted MiniMax secret provider and budget guard. Keep the current resource/admission policy injectable; do not bypass it. `JarvisProcessingRuntime` owns scheduler/dispatcher lifecycle exactly once. Production starts with both registered cloud workers, but any missing credential or denied budget yields durable retry/deferred status instead of crashing capture.

- [ ] **Step 7: Add failing IPC and preload tests**

Add exact channels:

```js
getDailyDigest: "jarvis:memory:daily-digest"
regenerateDailyDigest: "jarvis:analysis:daily-digest:regenerate"
```

`getDailyDigest(localDate)` returns the active public digest plus allowlisted status. `regenerateDailyDigest(localDate)` enqueues/wakes and immediately returns `{ state, retryable, errorCode, nextRetryAt, attemptCount }`. Reject extra keys, malformed/impossible dates, caller timezone, hashes, payloads, and arbitrary job options. Confirm IPC registration/removal symmetry and that preload exposes only the two narrow methods.

- [ ] **Step 8: Implement private IPC and production-safe errors**

Validate dates through `ZonedCalendar`, derive timezone in main, and map internal failures to stable public codes. Do not pass stack traces, provider responses, prompt text, internal IDs, or secrets to the renderer.

- [ ] **Step 9: Verify 5C and the complete Task 5 union**

Run focused tests first, then:

```powershell
npm run test:main -- test/jarvis/ZonedCalendar.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/DailyDigestInput.test.js test/jarvis/DailyDigestSchema.test.js test/jarvis/MiniMaxDailyDigestClient.test.js test/jarvis/DailyDigestService.test.js test/jarvis/DailyDigestScheduler.test.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/JarvisProcessingRuntime.test.js test/jarvis/registerJarvisIpc.test.js test/jarvis/MemoryRepository.test.js test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/JarvisAnalysisWorker.test.js
npm test
npm run lint
npm run typecheck
```

Run the repository's packaged-main smoke test with all caches on G. Confirm the app starts with no native-binding error and that digest setup does not start recording or cloud work without a trigger.

Commit:

```powershell
git add app/src/jarvis app/preload.js app/main.js app/test/jarvis
git commit -m "feat: schedule and expose versioned daily digests"
```

Request final fresh spec and code-quality review for all Task 5 commits. Resolve every critical, important, and medium finding. Finish only after the full union suite and repository-wide static checks are freshly green and the worktree contains no accidental generated files.
