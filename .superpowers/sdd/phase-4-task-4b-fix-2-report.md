# Phase 4 Task 4B review fix round 2 report

## Outcome

Both remaining independent-review findings are fixed on base commit
`1f44aa93ffdd9e18dbd6092629779cce36398b17`.

- Schema target version is now 28. A real v27 -> v28 transaction verifies the required v27
  memory tables and columns, derives every memory's canonical-v1 slot from kind, canonicalized
  title, and sorted/deduplicated durable subject IDs, inserts only missing bridges, and aborts
  without changing `user_version` when an existing bridge disagrees.
- The canonical bridge backfill and conflict-integrity trigger installer are shared by the v27
  schema introduction and v28 repair. The v28 repair does not replay v27 DDL and deterministically
  restores the four corrected triggers even when an old trigger is missing.
- Conflict application now validates every relevant historical/open group member-by-member after
  planning but before clock or ID work. Empty, heterogeneous, or bridge-corrupt groups fail closed;
  exactly one homogeneous semantic open group is reusable, while unrelated legacy groups do not
  block another slot.
- `resolveMemoryConflict()` uses the same full-group validation before idempotency handling, clock
  sampling, or writes.
- The v28 member, resolution, supersession, and lifecycle triggers enforce the same homogeneous
  canonical identity at the schema boundary while preserving the valid raw-group to canonical
  member resolution flow.

## Changed files

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `app/test/jarvis/MemoryRepository.test.js`
- `app/test/jarvis/JarvisLineageMigration.test.js`
- `app/test/jarvis/AgentWorkloadMigration.test.js`
- `app/test/jarvis/AnalysisBudgetMigration.test.js`
- `.superpowers/sdd/phase-4-task-4b-fix-2-brief.md`
- `.superpowers/sdd/phase-4-task-4b-fix-2-report.md`

The latest-version expectation changes are limited to migration tests directly affected by the
v28 bump. `JarvisLineageMigration.test.js` only advances post-migration memory relation fixtures to
the v28 canonical bridge contract. No changes were made to `MemoryMerger.js`, runtime, worker,
IPC, renderer, network, budget behavior, audio, GPU, or key handling.

## TDD evidence

All commands ran from `app` with `TEMP`, `TMP`, npm cache, and Electron caches rooted at
`G:\Jarvis\.runtime-cache\phase4-task4b-fix2`.

### Initial RED

1. Real v28 migration behavior:

   ```powershell
   node --test --test-name-pattern="v28 (repairs|migration rolls back|reopen)" test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: 0/3 pass. The v27 fixture returned `{fromVersion:27,toVersion:27}`, the mismatched
   bridge raised no exception, and a fresh database migrated only to 27.

2. Heterogeneous conflict behavior:

   ```powershell
   node --test --test-name-pattern="(heterogeneous raw-key|v28 triggers reject heterogeneous)" test/jarvis/MemoryRepository.test.js
   ```

   Result: 0/3 pass. Candidate application and repository resolution raised no exception, and
   direct SQL member insertion was accepted instead of producing `memory conflict slot mismatch`.

3. Literal storage identity disagreement:

   ```powershell
   node --test --test-name-pattern="literal conflict slot" test/jarvis/MemoryRepository.test.js
   ```

   Result: 0/1 pass. The application reached SQLite and raised `SQLITE_CONSTRAINT_UNIQUE` instead
   of failing in repository preflight with `MEMORY_EXISTING_SNAPSHOT_CORRUPT`.

4. Review-edge REDs:

   ```powershell
   node --test --test-name-pattern="v28 repairs a base-style" test/jarvis/MemorySubjectMigration.test.js
   node --test --test-name-pattern="unrelated heterogeneous raw group" test/jarvis/MemoryRepository.test.js
   ```

   Results: 0/1 and 0/1. The missing old trigger blocked repair with
   `v28 repair requires v27 trigger memory_supersessions_validate_slot`; validating all groups
   globally made an unrelated heterogeneous travel group raise `MEMORY_CONFLICT_AMBIGUOUS`.

### Focused GREEN

1. Migration repair, rollback, and no-op:

   ```powershell
   node --test --test-name-pattern="v28 (repairs|migration rolls back|reopen)" test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: 3/3 pass.

2. Relevant-group application, literal mismatch, unrelated group, resolution, and schema guards:

   ```powershell
   node --test --test-name-pattern="(unrelated heterogeneous raw group|literal conflict slot|heterogeneous raw-key|v28 triggers reject heterogeneous)" test/jarvis/MemoryRepository.test.js
   ```

   Result: 5/5 pass.

3. Homogeneous mixed raw/canonical flow:

   ```powershell
   node --test --test-name-pattern="a migrated raw-key open conflict" test/jarvis/MemoryRepository.test.js
   ```

   Result: 1/1 pass through reuse, canonical member selection, raw-member supersession,
   lifecycle completion, and exact read-only retry.

4. Directly affected lineage and partial-schema migration fixtures:

   ```powershell
   node --test --test-name-pattern="(relation guards enforce|resolved conflict membership|conflicts, recurrences|separate OpenAI correction ledger)" test/jarvis/JarvisLineageMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js
   ```

   Result: 4/4 pass.

## Verification gates

1. Required eight-file Task 4B, Task 3, v25-v28, and status gate:

   ```powershell
   node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 196/196 pass, 0 fail, 0 skipped.

2. Direct latest migration suite:

   ```powershell
   node --test test/jarvis/JarvisMigrations.test.js
   ```

   Result: 17/17 pass, 0 fail, 0 skipped.

3. Combined migration/repository/worker/merger/status gate during integration:

   Result: 213/213 pass after correcting the directly affected v28 lineage fixtures.

4. Changed-file ESLint:

   ```powershell
   npx --no-install eslint src/jarvis/main/JarvisMigrations.js src/jarvis/main/MemoryRepository.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass. Node emitted only the existing module-type performance warning for
   `src/eslint.config.js`.

5. Changed-file Prettier:

   ```powershell
   npx --no-install prettier --check src/jarvis/main/JarvisMigrations.js src/jarvis/main/MemoryRepository.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass (`All matched files use Prettier code style!`).

6. `git diff --check`

   Result: pass; Git printed only LF-to-CRLF working-copy warnings.

## Self-review

### I1 - existing v27 databases receive the repair

- `TARGET_VERSION` is 28 and `fromVersion < 28` has an explicit repair step.
- The v28 step does not recreate v27 tables. It accepts component-style pre-v27 fixtures only
  when the entire memory schema is absent; a v27 database or partial v27 memory schema must have
  every required table and column.
- Backfill uses the same canonical tuple as the merger and repository, preserves old raw entity
  keys and group keys, inserts only missing rows, and checks both algorithm and key on existing
  rows before any trigger replacement.
- A mismatch throws inside the migration transaction, leaving the bridge, old trigger SQL, and
  `user_version = 27` unchanged.
- Trigger replacement uses `DROP TRIGGER IF EXISTS` followed by deterministic creation, so a
  missing old trigger is repaired. Reopen at 28 is a true no-op.

### I2 - heterogeneous raw groups fail closed

- Shared repository validation derives every selected group's member identities from actual
  kind/title/subject rows and verifies the immutable bridge. Empty or multi-slot groups raise
  `MEMORY_CONFLICT_AMBIGUOUS`; missing/mismatched bridges raise
  `MEMORY_EXISTING_SNAPSHOT_CORRUPT`.
- Application selects only relevant groups by literal slot or member bridge, validates each in
  full, rejects a literal group whose homogeneous semantics disagree, and performs this preflight
  before clock or ID work. Unrelated bad raw groups remain isolated.
- Resolution validates the selected group before resolved-idempotency handling, clock sampling,
  supersession writes, or lifecycle changes.
- The member trigger requires a bridged new member and either a valid first-member group binding
  or complete existing-member homogeneity. The resolution trigger requires a selected member and
  complete bridged homogeneity. The supersession trigger prefers bridge equality when both sides
  are mapped and uses raw equality only when at least one side is genuinely unmapped.
- Lifecycle authorization requires homogeneous bridged membership and no later semantic episode.
  The retained mixed-flow test proves the raw historical group remains resolvable.

### Prior Task 4B/fix-round-1 behavior

- Post-v27 legacy importer bridge creation remains unchanged and covered.
- One homogeneous raw-key open group is reused; resolved semantic history advances the next
  episode; multiple homogeneous open groups still fail closed.
- Strict semantic retry validation, dual-reference resolution, stored-candidate transaction/CAS,
  raw-vs-semantic hashes, planner ordering, and no-clock/no-ID retry behavior remain covered by the
  196-test gate.
- Analysis-stage status coverage and v25/v26 workload/budget contracts remain covered.

## Concerns

No in-scope correctness concern remains. The only diagnostic is the pre-existing ESLint
module-type warning; changing package module metadata is outside this review fix.
