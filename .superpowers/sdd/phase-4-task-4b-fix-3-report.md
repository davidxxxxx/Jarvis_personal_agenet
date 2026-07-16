# Phase 4 Task 4B review fix round 3 report

## Outcome

Both remaining independent-review findings are fixed on base commit
`9cd6ae001585a84980c689b34475ba01abafa3f2`.

- The v28 repair now validates the complete v27 column dependency contract before canonical
  bridge backfill, trigger replacement, or `user_version` advancement. A v27 database missing
  `memory_conflict_groups.selected_member_id` fails closed and rolls the transaction back at
  version 27 with the partial table and old triggers unchanged.
- `memory_item_subjects` now rejects INSERT once that memory has a canonical bridge. The same
  reviewed trigger definition is installed for fresh schema creation and is dropped/recreated
  deterministically by the v27 -> v28 repair, replacing a missing or hostile old definition.
- The legitimate construction order remains memory row -> all durable subjects -> canonical
  bridge. Existing bridges are neither recomputed nor overwritten.
- The direct-SQL bypass cannot begin: adding a subject to either bridged memory aborts before
  conflict membership, resolution, supersession, or lifecycle writes.

## Changed files

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `.superpowers/sdd/phase-4-task-4b-fix-3-report.md`

No repository, merger, runtime, worker, IPC, renderer, network, budget, audio, GPU, or key code
was changed.

## TDD evidence

All commands ran from `app` with TEMP, TMP, npm, and Electron caches rooted at
`G:\Jarvis\.runtime-cache\phase4-task4b-fix3`.

### Exact RED

```powershell
node --test --test-name-pattern="(missing selected_member_id|subject INSERT after canonical bridge)" test/jarvis/MemorySubjectMigration.test.js
```

Result: 0/2 pass, 2 fail. Both failures were `Missing expected exception` at their respective
`assert.throws` calls:

1. the incomplete v27 schema advanced instead of rejecting the missing `selected_member_id`;
2. a subject INSERT after canonical bridge creation succeeded instead of raising the stable
   immutable-subject error.

Production code was unchanged for this RED run.

### Minimal focused GREEN

The same exact command passed 2/2 after completing the required-column map and installing the
shared subject INSERT freeze trigger.

### Expanded focused GREEN

```powershell
node --test --test-name-pattern="(missing selected_member_id|subject INSERT after canonical bridge|permits subject-before-bridge|direct-SQL conflict bypass|repairs a base-style|preserves legacy groups)" test/jarvis/MemorySubjectMigration.test.js
```

Result: 6/6 pass. This covers exact stale-trigger replacement on v27 -> v28, rollback on the
partial v27 contract, fresh bridge freeze, subject-before-bridge construction, the direct-SQL
bypass boundary, and the existing homogeneous mixed raw/canonical migration flow.

## Verification gates

1. Direct migration/repository gate:

   ```powershell
   node --test test/jarvis/MemorySubjectMigration.test.js test/jarvis/MemoryRepository.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/JarvisMigrations.test.js
   ```

   Result: 123/123 pass, 0 fail, 0 skipped.

2. Prior required eight-file Task 4B gate:

   ```powershell
   node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 200/200 pass, 0 fail, 0 skipped.

3. Final fresh nine-file union (the prior gate plus `JarvisMigrations.test.js`):

   ```powershell
   node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 217/217 pass, 0 fail, 0 skipped.

4. Changed-file ESLint:

   ```powershell
   npx --no-install eslint src/jarvis/main/JarvisMigrations.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass. Node emitted only the existing module-type performance warning for
   `src/eslint.config.js`.

5. Changed-file Prettier:

   ```powershell
   npx --no-install prettier --check src/jarvis/main/JarvisMigrations.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass (`All matched files use Prettier code style!`).

6. `git diff --check`

   Result: pass; Git printed only LF-to-CRLF working-copy warnings.

## Self-review

### I1 - incomplete v27 column contracts fail closed

- Validation occurs before `backfillMemoryItemCanonicalSlots()` and before
  `installMemoryConflictIntegrityTriggers()`, so no bridge insert or trigger drop can precede the
  complete contract check.
- Required columns cover every brief-listed dependency on `memory_items_v2`,
  `memory_item_subjects`, `memory_item_canonical_slots`, `memory_conflict_groups`,
  `memory_conflict_members`, and `memory_supersessions`.
- The selected-member regression fixture physically rebuilds the v27 conflict-group table
  without `selected_member_id`. It proves the error, version 27 rollback, unchanged partial table,
  and byte-for-byte preservation of all four old integrity trigger definitions.
- The fix-round-2 exception remains only for pre-v27 component fixtures where the complete memory
  schema is wholly absent. A database reporting `user_version = 27` cannot take that path.

### I2 - subjects freeze after canonical bridge creation

- The trigger is `BEFORE INSERT ON memory_item_subjects` and checks only for an existing bridge
  belonging to `NEW.memory_item_id`; it therefore allows every subject row before the bridge and
  rejects every later subject addition with `memory item subject is immutable`.
- One shared SQL definition is used by fresh schema creation and v28 repair. The repair drops the
  named trigger first, so a missing or hostile old definition is replaced deterministically.
- UPDATE/DELETE immutability and session/source deletion behavior are unchanged.
- The direct-SQL regression snapshots subjects, bridges, conflict relations, supersessions, and
  lifecycles and proves the first hostile INSERT aborts before any downstream write.

### Prior Task 4B and fix-round behavior

- v27 -> v28 canonical bridge backfill, strict existing-bridge mismatch rollback, and v28 reopen
  no-op behavior remain covered.
- The homogeneous historical raw-group -> canonical member -> resolved lifecycle/supersession
  path remains covered by both the migration focused gate and the repository eight-file gate.
- Heterogeneous raw groups, multiple semantic open groups, repository preflight, terminal
  resolution, strict semantic retry, planner ordering, candidate CAS, lineage, workload, budget,
  merger, worker, and status behavior remain covered by the 200-test gate.

## Concerns

No in-scope correctness concern remains. The only diagnostic is the pre-existing ESLint
module-type warning; package metadata changes are outside this review fix.
