# Phase 4 Task 4B report

## Outcome

`MemoryRepository.applyCandidateAnalysis()` now obtains a deterministic `MemoryMerger` plan from a locally derived private snapshot and applies every sorted action in the same SQLite transaction as evidence writes and the semantic input CAS. `applyStoredAnalysisCandidate()` owns the outer `BEGIN IMMEDIATE` transaction and includes desired-head validation, raw-candidate integrity, planner application, semantic input CAS, and the stored-candidate `validated -> applied` CAS.

The raw canonical-JSON response hash remains in `analysis_response_candidates.candidate_hash`. The planner semantic hash is stored in `analysis_inputs.candidate_hash`. Returns expose `candidateHash` as the compatibility raw hash plus explicit `rawCandidateHash` and `semanticCandidateHash` where both exist.

Migration v27 adds immutable stable memory subjects, an approved canonical-v1 bridge for old stored keys, and a deterministic evidence-lineage trigger that permits same-session evidence from a later analysis input to attach to an existing occurrence. Source manifests, transcript/audio lineage, target existence, and cross-session isolation remain enforced.

## Changed files

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `app/test/jarvis/MemoryRepository.test.js`
- `app/test/jarvis/AgentWorkloadMigration.test.js`
- `app/test/jarvis/AnalysisBudgetMigration.test.js`
- `app/test/jarvis/JarvisLineageMigration.test.js`
- `app/test/jarvis/LongRunStatusSnapshot.test.js`
- `.superpowers/sdd/phase-4-task-4b-report.md`

`MemoryMerger.js`, `JarvisRepository.js`, network/key/main/IPC/renderer code, and unrelated production modules were not changed.

## TDD evidence

All commands below ran from `app` after setting:

```powershell
$cache='G:\Jarvis\.runtime-cache'
$env:TEMP="$cache\temp"
$env:TMP="$cache\temp"
$env:npm_config_cache="$cache\npm"
$env:ELECTRON_CACHE="$cache\electron"
```

### RED

1. `node --test test/jarvis/MemorySubjectMigration.test.js`
   - Initial result: 0/2; target remained v26 and migration returned `toVersion: 26`.
   - Bridge regression: missing `memory_item_canonical_slots`.
   - Historical stored-key-only trigger regression was reproduced by temporarily restoring the old predicate: mixed canonical-v1 relation failed with `SQLITE_CONSTRAINT_TRIGGER`.

2. `node --test --test-name-pattern="exact private snapshot" test/jarvis/MemoryRepository.test.js`
   - Result: planner snapshot/action integration absent.

3. `node --test --test-name-pattern="planner insert actions" test/jarvis/MemoryRepository.test.js`
   - Result: repository stored the old key rather than the planner canonical-v1 key; after the key fix, the bridge assertion was still missing.

4. Focused action tests in `MemoryRepository.test.js`
   - Future/future topic merge: no durable merge-suggestion row.
   - Suggestion lifecycle: `acceptSuggestion`/`dismissSuggestion` were not functions.
   - Contradictory memory values: both values remained active.
   - Strictly later todo evidence: only one todo existed.
   - Normalized-identical summary: old revision was superseded and a second revision was inserted.

5. `node --test --test-name-pattern="stored candidate (exact retry|disposition CAS failure)" test/jarvis/MemoryRepository.test.js`
   - Result: 0/2. Exact retry omitted explicit raw/semantic hashes; an injected zero-row candidate disposition CAS returned success instead of throwing.

6. `node --test test/jarvis/MemoryRepository.test.js`
   - Intermediate result: 53/56. The three failures were the intentional dual-hash return updates and canonical-v1 Unicode convergence expectation.

7. `node --test --test-name-pattern="event overlap exact" test/jarvis/MemoryRepository.test.js`
   - Result after valid capture-lineage fixture: `event-overlap: evidence lineage is invalid`. This exposed the old trigger's same-analysis-input restriction for planner `link_evidence` actions.

### GREEN

1. `node --test test/jarvis/MemorySubjectMigration.test.js`
   - 3/3 pass: fresh v27, v26 backfill/reopen/immutability/retention, and old/mixed canonical bridge relations.

2. `node --test --test-name-pattern="(exact private snapshot|planner insert actions|future topic references|suggestion accept and dismiss|appends topic and summary|normalized-identical session summary|contradictory memory values create|strictly later evidence creates)" test/jarvis/MemoryRepository.test.js`
   - 8/8 pass at the focused planner/action checkpoint.

3. `node --test --test-name-pattern="stored candidate (exact retry|disposition CAS failure)" test/jarvis/MemoryRepository.test.js`
   - 2/2 pass. Exact retry invokes no planner/clock/ID; disposition CAS miss rolls back input hash, candidate state, and entities.

4. `node --test --test-name-pattern="(every injected planner action-class|two SQLite connections)" test/jarvis/MemoryRepository.test.js`
   - 2/2 pass. All seven action arrays roll back the stored-candidate transaction on injected failure. Under real two-connection contention, the second `BEGIN IMMEDIATE` receives `SQLITE_BUSY`, observes zero uncommitted rows, then returns `already_applied` after the first commit.

5. `node --test --test-name-pattern="event overlap exact" test/jarvis/MemoryRepository.test.js`
   - 1/1 pass. Overlap and the inclusive 30-minute gap link evidence to the existing occurrence; +1 ms creates a second occurrence. Same-session cross-input evidence passes; cross-session and manifest mismatch inserts fail.

6. `node --test test/jarvis/JarvisLineageMigration.test.js test/jarvis/LongRunStatusSnapshot.test.js`
   - 27/27 pass after preserving raw-key fallback and converging the lineage/runtime fixtures with current contracts.

7. Final Task 4B/Task 3 set:

```powershell
node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/LongRunStatusSnapshot.test.js
```

Result: 181/181 pass.

## Static and broad verification

- Focused ESLint over every changed JS file: pass.
- Full repository ESLint (`eslint . && cd src && eslint .`, run as the first two stages of `npm run format:check`): pass, with only the existing module-type warning.
- Focused Prettier check over every changed JS file: pass.
- `git diff --check`: pass; only Windows LF-to-CRLF working-copy warnings.
- Full `npm run format:check`: fails only at the existing renderer/source Prettier baseline (433 unrelated files). No baseline files were reformatted.
- `node --test "test/jarvis/*.test.js"`: 1,439 pass, 3 fail, 3 skip. The failures are outside Task 4B files/contracts:
  - `DualTrackRecovery.test.js`: Windows temp-directory cleanup `ENOTEMPTY` race.
  - `ExistingRecordingBackfill.test.js`: unrelated legacy transcription count expectation (`1 !== 2`).
  - `PackagingSafety.test.js`: unrelated malformed ONNX unpacked-alias fixture expectation.

## Self-review

- Planner runs before the single `appliedAt` sample and before action ID allocation.
- Standalone direct apply uses `BEGIN IMMEDIATE`; stored-candidate apply reuses the already-open outer transaction instead of opening a nested transaction.
- Stable already-applied and stale/corrupt desired-head paths return before planner/clock/ID work as required.
- New memory subjects and canonical bridge rows are written in the memory insert transaction before occurrence/evidence visibility.
- v27 canonical bridge joins are `LEFT JOIN`: preserved raw stored-key equality works without a bridge row, while mixed canonical-v1 equality is accepted only when the required mapped bridge rows exist.
- The v27 evidence trigger is deterministic checked-in SQL, not a runtime rewrite of `sqlite_master`. Only memory/topic/todo/suggestion occurrence ownership is widened to same-session; summary and digest rules remain unchanged.
- Terminal suggestion reappearance is a no-op. Todo lifecycle follows the reviewed planner contract, so later `dueText` alone does not create a repository-local revision; recurrence is produced only for strictly later evidence.
- Removed an unused suggestion future-ID map. Hoisted memory-subject/conflict statements and occurrence sets out of action loops. No lint suppression was added.
- Dynamic occurrence-table selection is limited to a closed local allowlist before interpolation.

## Concerns and follow-up debt

- `applyCandidateAnalysis()` is still a large transactional action engine. Its single-method form keeps the ordering/transaction proof visible for this task, but a later behavior-preserving refactor should extract session-summary application and each action family into private helpers receiving an explicit transaction context. That refactor should keep the current action-class rollback and ID-order tests unchanged.
- The canonical-slot bridge is intentional migration compatibility debt: old stored keys remain immutable while planner identity is canonical-v1. Future schema cleanup must not bulk-rekey old rows without a separate reviewed migration.
