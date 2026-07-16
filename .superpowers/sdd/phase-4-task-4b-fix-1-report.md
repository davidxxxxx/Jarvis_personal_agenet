# Phase 4 Task 4B review fix round 1 report

## Outcome

All review findings I1-I4 and M1 are fixed on base commit
`592f30594bbf8f26b4205d3f322b20e972fb2b44`.

- Post-v27 legacy memory imports now create an immutable canonical-v1 slot bridge in the
  import transaction, using the exact canonical helper and durable stored subjects.
- Conflict application finds every group with the same semantic canonical-v1 identity,
  reuses exactly one open raw-key group, advances episodes across raw/canonical storage,
  and fails closed on multiple semantic open groups. The v27 member, resolution, and
  terminal-lifecycle triggers all accept the same verified mixed raw/canonical episode.
- Direct semantic retries validate the complete closed candidate schema and evidence/owner
  scope before any idempotency result, planner call, clock sample, ID allocation, or write.
- Memory action references validate each supplied ID and canonical key independently and
  require dual references to resolve to the same memory.
- Runtime-status coverage again uses a valid cloud `analyze_session` fixture and reports the
  `analysis` stage without weakening the v26 triggers.

## Changed files

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/test/jarvis/MemoryRepository.test.js`
- `app/test/jarvis/LongRunStatusSnapshot.test.js`
- `.superpowers/sdd/phase-4-task-4b-fix-1-brief.md`
- `.superpowers/sdd/phase-4-task-4b-fix-1-report.md`

No changes were made to `MemoryMerger.js`, network, worker/runtime behavior, IPC, renderer,
or unrelated production modules.

## TDD evidence

All commands ran from `app` with `TEMP`, `TMP`, npm cache, and Electron cache rooted under
`G:\Jarvis\.runtime-cache`.

### RED

This resumed task inherited the following recorded RED checkpoint from the pre-fix base.
The four production/test files already contained the corresponding partial uncommitted fixes
when work resumed, so these failures were preserved as prior evidence rather than recreated by
reverting the worktree.

1. `node --test --test-name-pattern="post-v27 legacy memory imports" test/jarvis/MemoryRepository.test.js`
   - The imported memory had no `memory_item_canonical_slots` row; the later mixed relation
     failed with `memory conflict slot mismatch`.
2. `node --test --test-name-pattern="(a migrated raw-key open conflict|a resolved raw-key conflict|multiple semantic open conflict groups)" test/jarvis/MemoryRepository.test.js`
   - Raw-key open groups were duplicated, a new canonical group reset its episode instead of
     following semantic history, and multiple semantic open groups were not rejected.
3. `node --test --test-name-pattern="semantic retry rejects" test/jarvis/MemoryRepository.test.js`
   - Malformed and out-of-scope semantic retries could return idempotent status before strict
     validation.
4. `node --test --test-name-pattern="stored candidate rolls back when a memory action has an unknown canonical key" test/jarvis/MemoryRepository.test.js`
   - A valid `memoryId` masked an invalid supplied canonical key and the stored candidate
     committed.
5. `node --test --test-name-pattern="repository aggregates active work" test/jarvis/LongRunStatusSnapshot.test.js`
   - The restored `analyze_session` row was rejected without a valid immutable input and
     desired head.

On resume, the raw-key open-group test was extended through actual conflict resolution. It
selects the newly inserted canonical-v1 hybrid member and asserts both old raw-key members are
superseded, the selected member is active, both supersession relations are complete, and an
exact retry is read-only. This coverage passed against the inherited trigger fix and closes the
previous member-only test gap.

### GREEN

1. Focused review set:

   ```powershell
   node --test --test-name-pattern="(stored candidate rolls back when a memory action has an unknown canonical key|post-v27 legacy memory imports|semantic retry rejects|reordered semantic retry|a migrated raw-key open conflict|a resolved raw-key conflict|multiple semantic open conflict groups|repository aggregates active work)" test/jarvis/MemoryRepository.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 9/9 pass.

2. Required Task 4B, Task 3, and v25/v26/v27 migration gate:

   ```powershell
   node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 188/188 pass, 0 fail, 0 skipped.

3. Changed-file ESLint:

   ```powershell
   npx --no-install eslint src/jarvis/main/JarvisMigrations.js src/jarvis/main/MemoryRepository.js test/jarvis/LongRunStatusSnapshot.test.js test/jarvis/MemoryRepository.test.js
   ```

   Result: pass. Node emitted only the existing module-type performance warning for
   `src/eslint.config.js`.

4. Changed-file Prettier:

   ```powershell
   npx --no-install prettier --check src/jarvis/main/JarvisMigrations.js src/jarvis/main/MemoryRepository.js test/jarvis/LongRunStatusSnapshot.test.js test/jarvis/MemoryRepository.test.js
   ```

   Result: pass (`All matched files use Prettier code style!`).

5. `git diff --check`
   - Result: pass; Git printed only LF-to-CRLF working-copy warnings.

## Self-review by finding

- **I1:** The importer computes canonical-v1 from the stored kind/title and durable subject
  IDs, inserts the bridge only when it creates the target, and performs the import and bridge
  write in the same transaction. An already-mapped target remains read-only and consumes no
  ID or clock.
- **I2:** Semantic group discovery includes literal canonical groups and member bridge rows.
  More than one open group aborts the transaction; no open group uses the maximum episode over
  all semantic rows. The expanded raw-key test exercises the member, resolution, supersession,
  and both terminal lifecycle transitions through the repository, then proves exact retry
  idempotency.
- **I3:** Strict candidate validation occurs before the `candidate_hash` idempotency branch.
  The invalid paths perform reads only, while a valid semantic reorder remains read-only and
  invokes no planner, clock, or ID allocation.
- **I4:** A supplied ID must exist, a supplied canonical key must resolve, and dual references
  must agree. The stored-candidate regression proves candidate disposition, semantic input CAS,
  entities, occurrences, evidence, and summary writes all roll back.
- **M1:** The runtime fixture seeds matching `analysis_inputs` and `analysis_desired_heads` rows
  before inserting a cloud `analyze_session` job with priority 70 and matching hashes/model.
  The expected stage remains `analysis`; no cloud-contract trigger was weakened.
- Scope review found no changes outside the six authorized files listed above.

## Concerns

No new in-scope correctness concern remains. The only static-check diagnostic is the existing
Node module-type warning; changing package module metadata is outside this review fix.
