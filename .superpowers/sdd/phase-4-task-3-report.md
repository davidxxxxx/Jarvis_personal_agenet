# Phase 4 Task 3 Report - Durable restart-safe analysis worker

## Outcome

Implemented an enqueue-only, durable analysis path with a single-request cloud dispatcher, restart-safe immutable candidate recovery, durable budget-attempt handling, desired-head CAS application, and runtime isolation from local processing. Production MiniMax transport remains disabled and no real key or network was used.

## Changed files

- `app/src/jarvis/main/AgentCloudDispatcher.js` (new)
- `app/src/jarvis/main/JarvisAnalysisWorker.js` (new)
- `app/src/jarvis/main/AnalysisScheduler.js`
- `app/src/jarvis/main/CaptureEvidenceStore.js`
- `app/src/jarvis/main/JarvisProcessingRuntime.js`
- `app/test/jarvis/AgentCloudDispatcher.test.js` (new)
- `app/test/jarvis/JarvisAnalysisWorker.test.js` (new)
- `app/test/jarvis/AnalysisScheduler.test.js`
- `app/test/jarvis/CaptureEvidenceStore.test.js`
- `app/test/jarvis/JarvisProcessingRuntime.test.js`
- `.superpowers/sdd/phase-4-task-3-report.md` (this report; force-added because `.superpowers/` is ignored)

`app/main.js` was deliberately not changed. The existing production-default `cloudTransportEnabled: false` gate remains fail-closed.

## Behavior delivered

- `AnalysisScheduler` now persists the exact redacted immutable input, advances the desired head, and enqueues only an exact durable `analyze_session` cloud job. Timers/scheduler calls do not invoke the client.
- `AgentCloudDispatcher` explicitly requires startup budget recovery wiring, recovers bounded reconciled candidates before claims, claims only one analysis job below the daily-digest priority, coalesces concurrent drains, and joins active work during shutdown.
- `JarvisAnalysisWorker` validates the claimed job and durable identities; loads input/head/candidate/attempt state; recovers candidates without network; evaluates immutable admission before and after reservation; releases pre-start stale/revoked work; starts exactly one request; durably accounts for ambiguous/known usage; reconciles before candidate persistence; and applies only through the existing desired-head CAS.
- `CaptureEvidenceStore` has one narrow recovery boundary for expired running `analyze_session` leases backed by an exact `validated` or `applied` candidate and a `reconciled` budget attempt. It changes only owner/lease, never increments the request attempt, and refuses live, ambiguous, digest, and unknown work.
- `JarvisProcessingRuntime` ticks cloud work independently of local work, catches cloud failures without blocking local processing, stops new cloud claims, and joins dispatcher work during shutdown.
- No transcript, audio, path, secret, device name, key, or candidate payload is placed in the durable job envelope or added to logs by this task.

## TDD RED/GREEN evidence

All focused commands used the G-drive cache environment shown in the verification section.

1. Narrow cloud candidate recovery boundary
   - RED: `node --test --test-name-pattern="cloud candidate lease" test/jarvis/CaptureEvidenceStore.test.js`
   - Result: 0 pass / 1 fail; expected missing `recoverExpiredCloudCandidateLease` method.
   - GREEN: `node --test --test-name-pattern="expired cloud analysis|cloud candidate lease" test/jarvis/CaptureEvidenceStore.test.js`
   - Result: 2 pass / 0 fail.
   - Second RED: `node --test --test-name-pattern="bounded cloud candidate recovery" test/jarvis/CaptureEvidenceStore.test.js`
   - Result: 0 pass / 1 fail; expected missing plural bounded recovery API.
   - GREEN: combined focused recovery run, 3 pass / 0 fail.

2. Candidate restart recovery
   - RED: `node --test test/jarvis/JarvisAnalysisWorker.test.js`
   - Result: 0 pass / 2 fail with `MODULE_NOT_FOUND` for the new worker.
   - GREEN: same command after the recovery slice, 2 pass / 0 fail with zero client calls.

3. Ordered worker success and pre-start gates
   - RED: `node --test test/jarvis/JarvisAnalysisWorker.test.js`
   - Result: 2 pass / 5 fail because `worker.execute` did not exist.
   - GREEN: same command, 7 pass / 0 fail.

4. Paid-attempt ambiguity, invalid response, CAS, and lease loss
   - RED: `node --test test/jarvis/JarvisAnalysisWorker.test.js`
   - Result: 7 pass / 4 fail: timeout escaped without `usage_unknown`, invalid known-usage response did not reconcile, superseded CAS status was rejected, and lease-loss protection was absent.
   - GREEN: same command, 11 pass / 0 fail.

5. Authoritative zero usage and no silent resend
   - RED: `node --test --test-name-pattern="authoritative zero|reconciled usage" test/jarvis/JarvisAnalysisWorker.test.js`
   - Result: 0 pass / 2 fail: zero usage became ambiguous and an ordinary reconciled attempt could resend.
   - GREEN: same command, 2 pass / 0 fail; the full worker file later passed 13/13.

6. One-request dispatcher and shutdown
   - RED: `node --test test/jarvis/AgentCloudDispatcher.test.js`
   - Result: 0 pass / 3 fail with `MODULE_NOT_FOUND` for the new dispatcher.
   - GREEN: same command, 3 pass / 0 fail.
   - Self-review RED: `node --test --test-name-pattern="requires explicit incomplete-budget" test/jarvis/AgentCloudDispatcher.test.js`
   - Result: 0 pass / 1 fail, `Missing expected exception`; startup recovery was incorrectly optional.
   - GREEN: full dispatcher file, 4 pass / 0 fail after making recovery wiring mandatory.

7. Local/cloud runtime isolation and shutdown join
   - RED: `node --test --test-name-pattern="local processing remains disjoint" test/jarvis/JarvisProcessingRuntime.test.js`
   - Result after correcting the test's local-run count assumption: 0 pass / 1 fail because `cloudDrains` remained 0.
   - GREEN: same command, 1 pass / 0 fail.

8. Enqueue-only scheduler semantics
   - RED: `node --test --test-name-pattern="checkpoint and stop triggers" test/jarvis/AnalysisScheduler.test.js`
   - Result: 0 pass / 1 fail because the old direct execution path read `getAnalysisInputForCloud`; the test required no transport payload read.
   - GREEN: same command, 1 pass / 0 fail; full scheduler file passed 6/6.

The first runtime RED attempt exposed a faulty test expectation and could wait on the test's unresolved cloud promise. The test was corrected before making the production change; the stable behavioral RED above is the evidence used for implementation.

## Final verification

Environment for every final command:

```powershell
$env:TEMP='G:\Jarvis\.runtime-cache\temp'
$env:TMP=$env:TEMP
$env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'
$env:ELECTRON_CACHE='G:\Jarvis\.runtime-cache\electron'
$env:ELECTRON_BUILDER_CACHE='G:\Jarvis\.runtime-cache\electron-builder'
```

Related main-process combination:

```powershell
node --test test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/AnalysisScheduler.test.js test/jarvis/JarvisProcessingRuntime.test.js test/jarvis/AgentWorkloadPolicy.test.js test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/AnalysisBudgetService.test.js test/jarvis/AnalysisInputBuilder.test.js test/jarvis/AnalysisProductionWiring.test.js test/jarvis/MemoryRepository.test.js test/jarvis/MiniMaxAnalysisClient.test.js test/jarvis/ProcessingJobRunner.test.js
```

- Result: 276 tests, 276 pass, 0 fail, 0 skipped, 0 cancelled.

Static checks on all ten changed JS/test files:

```powershell
npx eslint src/jarvis/main/AgentCloudDispatcher.js src/jarvis/main/JarvisAnalysisWorker.js src/jarvis/main/AnalysisScheduler.js src/jarvis/main/CaptureEvidenceStore.js src/jarvis/main/JarvisProcessingRuntime.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AnalysisScheduler.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisProcessingRuntime.test.js
npx prettier --check src/jarvis/main/AgentCloudDispatcher.js src/jarvis/main/JarvisAnalysisWorker.js src/jarvis/main/AnalysisScheduler.js src/jarvis/main/CaptureEvidenceStore.js src/jarvis/main/JarvisProcessingRuntime.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AnalysisScheduler.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisProcessingRuntime.test.js
git diff --check
```

- ESLint: exit 0, no errors or warnings. Node emitted only its existing typeless-package performance notice for `src/eslint.config.js`.
- Prettier: all matched files use Prettier style.
- `git diff --check`: exit 0. Git emitted only line-ending conversion notices from the existing Windows checkout configuration.

## Self-review

- Verified `markStarted` is immediately adjacent to the single client invocation and `execution_device='cloud'` is recorded only afterward.
- Verified every pre-send stale/admission branch releases the reservation, while budget denial defers without deleting work.
- Verified every started ambiguous branch becomes `usage_unknown`; known nonzero invalid usage reconciles and blocks; only the durable authoritative-zero marker allows another attempt.
- Verified reconciliation precedes immutable candidate persistence, preserving the v26 database trigger, and application uses only the existing lease-checked desired-head CAS.
- Verified a lost lease after transport can reconcile and persist a recoverable candidate but cannot apply visible memory.
- Verified candidate recovery is bounded, zero-network, exact-identity, and does not broaden generic local lease recovery.
- Verified cloud claim priority excludes daily digest and the production wiring test still proves MiniMax transport is unreachable by default.
- Verified no renderer, IPC, daily digest, MemoryMerger, key, or network behavior changed.

## Concerns and intentional limits

- Production transport is intentionally not composed or enabled in this task. The worker/dispatcher are dependency-injected and covered only with fake clients.
- Expired `started` or `usage_unknown` cloud work without a persisted candidate is deliberately not reclaimed or resent. This is the fail-closed ambiguity contract; it requires explicit external/manual disposition rather than risking duplicate paid work.
- The authorized recovery API handles only `validated` and `applied` candidates. Daily digest and unknown cloud types remain outside this task.

## Independent review fix pass

Fix scope: independent review `Critical 0 / Important 5 / Minor 1`, based on parent commit `c3237627`. The fix is committed as the single commit with subject `fix(jarvis): close durable analysis recovery gaps`; the report is part of that commit.

### Fix files

- `app/src/jarvis/main/AgentCloudDispatcher.js`
- `app/src/jarvis/main/AnalysisBudgetRepository.js`
- `app/src/jarvis/main/CaptureEvidenceStore.js`
- `app/src/jarvis/main/JarvisAnalysisWorker.js`
- `app/test/jarvis/AgentCloudDispatcher.test.js`
- `app/test/jarvis/AnalysisBudgetRepository.test.js`
- `app/test/jarvis/CaptureEvidenceStore.test.js`
- `app/test/jarvis/JarvisAnalysisWorker.test.js`
- `.superpowers/sdd/phase-4-task-3-report.md`

No scheduler, runtime, renderer, IPC, daily-digest, MemoryMerger, key, network, or production transport file changed in the fix pass.

### Fix RED/GREEN evidence

All commands used the same G-drive cache environment documented above.

1. Exhaustive prior-attempt and durable reserve/start transitions

   ```powershell
   node --test --test-name-pattern="prior started|prior reserved|fresh exact" test/jarvis/JarvisAnalysisWorker.test.js
   ```

   - RED: 10 tests, 0 pass / 10 fail. A prior `started` attempt executed again, a prior `reserved` attempt was not released, and seven replayed/wrong reserve-or-start dispositions still reached the client.
   - GREEN: 10 tests, 10 pass / 0 fail. `started` is durably marked `usage_unknown`, `reserved` is durably released, and only a new exact attempt number/request ID with non-replayed `reserved -> started` transitions can invoke the client.

2. Ledger-owned authoritative zero usage

   ```powershell
   node --test --test-name-pattern="authoritative reconciliation facts|authoritative zero usage|job reasons never" test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/JarvisAnalysisWorker.test.js
   ```

   - RED: 3 tests, 0 pass / 3 fail. Dispositions returned undefined actual facts; persisted zero usage could not retry without a job reason; nonzero/unknown usage could retry when a stale job reason claimed zero.
   - GREEN: 3 tests, 3 pass / 0 fail. Dispositions expose `actualInputTokens`, `actualOutputTokens`, and `actualMicrousd`; retry requires all three persisted values to be strictly zero. `blocked_reason` is not an accounting authority.

3. Unbypassable startup recovery gate

   ```powershell
   node --test --test-name-pattern="every drain remains gated" test/jarvis/AgentCloudDispatcher.test.js
   ```

   - RED: 1 test, 0 pass / 1 fail. After recovery failed once, a later drain skipped the second recovery call and proceeded to candidate/claim work.
   - GREEN: 1 test, 1 pass / 0 fail. Every drain awaits a dispatcher-owned recovery-ready promise; failure leaves the gate closed and a later explicit drain retries recovery.

4. Safe expired pre-start recovery

   ```powershell
   node --test --test-name-pattern="pre-start recovery|safely recovered pre-start" test/jarvis/CaptureEvidenceStore.test.js test/jarvis/AgentCloudDispatcher.test.js
   ```

   - Initial test setup correction: the first attempt hit immutable-candidate/budget database triggers before the missing behavior. Fixtures were rebuilt through valid repository transitions so RED tested production behavior rather than an invalid fixture.
   - RED: 3 top-level tests, 0 pass / 3 fail. Dispatcher did not execute recovered pre-start work and both SQLite tests reported `recoverExpiredCloudPrestartLeases is not a function`.
   - GREEN: 10 checks, 10 pass / 0 fail. Recovery accepts only no attempt, released, or reconciled strict-zero latest attempts; it refuses started, usage-unknown, reconciled nonzero, reconciled unknown/corrupt, any candidate, daily digest, and unknown cloud work.

5. Durable lease-checked superseded state

   ```powershell
   node --test --test-name-pattern="stale job before reserve|reservation when the desired head|head change after paid|analysis supersede is lease" test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/CaptureEvidenceStore.test.js
   ```

   - RED: 4 tests, 0 pass / 4 fail. The store transition did not exist and all three stale/CAS paths completed the job as success.
   - GREEN: 4 tests, 4 pass / 0 fail. All three paths use a lease-checked `supersedeAnalysisJob` transition that records `state='superseded'`, `completed_at`, and `ANALYSIS_SUPERSEDED`, clears retry/lease state, and preserves any already-recorded execution device.

6. Fixed Task 3 input contract version

   ```powershell
   node --test --test-name-pattern="fixed input contract version" test/jarvis/JarvisAnalysisWorker.test.js
   ```

   - RED: 1 test, 0 pass / 1 fail with `Missing expected rejection`; `input_version=2` reached execution.
   - GREEN: 1 test, 1 pass / 0 fail; only `input_version === 1` is accepted before durable reads.

### Fix verification

Covering files:

```powershell
node --test test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/CaptureEvidenceStore.test.js
```

- First covering run: 127 tests, 126 pass / 1 fail. The only failure was a pre-existing dispatcher concurrency test that assumed one microtask was enough for startup. It was changed to await the real worker-start signal introduced by the recovery gate.
- Final covering run: 127 tests, 127 pass / 0 fail.

Fresh full related main-process combination after formatting:

```powershell
node --test test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/AnalysisScheduler.test.js test/jarvis/JarvisProcessingRuntime.test.js test/jarvis/AgentWorkloadPolicy.test.js test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/AnalysisBudgetService.test.js test/jarvis/AnalysisInputBuilder.test.js test/jarvis/AnalysisProductionWiring.test.js test/jarvis/MemoryRepository.test.js test/jarvis/MiniMaxAnalysisClient.test.js test/jarvis/ProcessingJobRunner.test.js
```

- Result: 300 tests, 300 pass, 0 fail, 0 skipped, 0 cancelled.

Static commands:

```powershell
npx eslint src/jarvis/main/AgentCloudDispatcher.js src/jarvis/main/AnalysisBudgetRepository.js src/jarvis/main/CaptureEvidenceStore.js src/jarvis/main/JarvisAnalysisWorker.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisAnalysisWorker.test.js
npx prettier --check src/jarvis/main/AgentCloudDispatcher.js src/jarvis/main/AnalysisBudgetRepository.js src/jarvis/main/CaptureEvidenceStore.js src/jarvis/main/JarvisAnalysisWorker.js test/jarvis/AgentCloudDispatcher.test.js test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisAnalysisWorker.test.js
git diff --check
```

- ESLint: exit 0, no findings; only the existing Node typeless-package performance notice.
- Prettier: all matched files use Prettier style.
- `git diff --check`: exit 0; only the Windows checkout line-ending notices were emitted.

### Fix self-review

- Attempt state is exhaustively fail-closed: no attempt, released, or reconciled ledger strict-zero may advance; reserved is first released; started/usage-unknown cannot resend; malformed/replayed durable transitions cannot reach the client.
- The safe expired-job SQL repeats the exact candidate/attempt eligibility predicate in both discovery and update inside one transaction. Reassignment preserves `running` and `attempt_count`; the dispatcher processes at most one recovered paid job before any new claim.
- Candidate recovery remains separate and first. Generic local lease recovery remains cloud-blind.
- Supersession is terminal and auditable rather than reported as successful completion. Paid CAS supersession retains the previously recorded `execution_device='cloud'`.
- Production MiniMax remains unreachable by default. Every client in tests is injected and fake; no real key or network was used.
