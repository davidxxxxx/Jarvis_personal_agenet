# Phase 4 Task 4B review fix round 4 report

## Outcome

The remaining independent-review finding is fixed on base commit
`06c3f12a29eefed454b11adea6f5ad5ae056af5c`.

- The v27 -> v28 repair now drops only `memory_item_subjects_immutable_insert` after the complete
  required table/column contract is validated and before canonical bridge backfill begins.
- A hostile trigger using that reviewed name but attached to canonical-slot INSERT can no longer
  abort a legitimate missing-bridge backfill.
- Backfill still validates or writes exact canonical-v1 bridges, then the existing deterministic
  installer recreates the reviewed subject INSERT freeze and all four conflict-integrity triggers.
- The early DROP remains inside the existing outer migration transaction. A bridge mismatch rolls
  the migration back to v27 and restores the hostile trigger definition exactly.

## Changed files

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `.superpowers/sdd/phase-4-task-4b-fix-4-report.md`

No repository, merger, runtime, worker, IPC, renderer, network, budget, audio, GPU, or key code was
changed.

## TDD evidence

All commands ran from `app` with TEMP, TMP, npm, and Electron caches rooted at
`G:\Jarvis\.runtime-cache\phase4-task4b-fix4`.

### Exact RED

Production code was unchanged. The new fixture created a complete v27 schema, one valid memory
with durable subjects but no canonical bridge, and a hostile
`memory_item_subjects_immutable_insert` trigger attached to
`BEFORE INSERT ON memory_item_canonical_slots`.

```powershell
node --test --test-name-pattern="v28 drops a hostile wrong-target subject trigger before missing bridge backfill" test/jarvis/MemorySubjectMigration.test.js
```

Result: 0/1 pass, 1 fail. The `assert.doesNotThrow` failure reported the exact hostile error
`hostile wrong-target subject trigger fired` with `SQLITE_CONSTRAINT_TRIGGER`, proving that the
old migration reached bridge INSERT before removing the stale reviewed-name trigger.

### Minimal GREEN

The only production change was an early
`DROP TRIGGER IF EXISTS memory_item_subjects_immutable_insert` after complete required-column
validation and before `backfillMemoryItemCanonicalSlots()`.

The same exact command passed 1/1.

### Rollback regression

The second hostile fixture supplied a mismatched existing bridge. It verifies that migration
fails for `canonical slot mismatch`, leaves `user_version = 27`, preserves the mismatched bridge,
and restores the hostile trigger's `sqlite_master.sql` exactly.

```powershell
node --test --test-name-pattern="v28 (drops|rollback restores) a hostile wrong-target subject trigger" test/jarvis/MemorySubjectMigration.test.js
```

Result: 2/2 pass.

### Prior fix-round and repair focused gates

The exact prior fix-3 six-test pattern remained green:

```powershell
node --test --test-name-pattern="(missing selected_member_id|subject INSERT after canonical bridge|permits subject-before-bridge|direct-SQL conflict bypass|repairs a base-style|preserves legacy groups)" test/jarvis/MemorySubjectMigration.test.js
```

Result: 6/6 pass.

The fix-4 hostile paths plus required-column rollback and v28 repair/no-op remained green:

```powershell
node --test --test-name-pattern="(hostile wrong-target|missing selected_member_id|repairs a base-style|v28 reopen is a no-op)" test/jarvis/MemorySubjectMigration.test.js
```

Result: 5/5 pass.

## Verification gates

1. Fresh nine-file Task 4B union:

   ```powershell
   node --test test/jarvis/MemoryRepository.test.js test/jarvis/MemorySubjectMigration.test.js test/jarvis/JarvisLineageMigration.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/AgentWorkloadMigration.test.js test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/MemoryMerger.test.js test/jarvis/JarvisAnalysisWorker.test.js test/jarvis/LongRunStatusSnapshot.test.js
   ```

   Result: 219/219 pass, 0 fail, 0 skipped.

2. Changed-file ESLint:

   ```powershell
   npx --no-install eslint src/jarvis/main/JarvisMigrations.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass. Node emitted only the existing module-type performance warning for
   `src/eslint.config.js`.

3. Changed-file Prettier:

   ```powershell
   npx --no-install prettier --check src/jarvis/main/JarvisMigrations.js test/jarvis/MemorySubjectMigration.test.js
   ```

   Result: pass (`All matched files use Prettier code style!`).

4. `git diff --check`

   Result: pass; Git printed only LF-to-CRLF working-copy warnings.

## Self-review

### Ordering and narrow scope

- The complete required table/column loop finishes before the new DROP, preserving fail-closed
  behavior for incomplete v27 schemas without touching any trigger first.
- The new statement drops only the single reviewed name. No broad trigger enumeration or
  unrelated schema mutation was added.
- Backfill and the full deterministic installer retain their original order after the DROP.

### Transactional rollback

- `upgradeMemoryConflictIntegrityV28()` is invoked inside the existing
  `applyJarvisMigrations()` `db.transaction()` that also advances `user_version`.
- SQLite transactional DDL restores the early-dropped trigger when bridge validation or any later
  migration step throws.
- The hostile mismatch regression compares the complete pre-migration and post-failure trigger SQL
  strings, in addition to checking version and bridge state.

### Preserved Task 4B behavior

- Exact canonical-v1 missing-bridge backfill and strict existing-bridge mismatch rejection remain
  covered.
- Missing-column fail-closed behavior still occurs before trigger replacement.
- Subject-after-bridge INSERT freeze, subject UPDATE/DELETE immutability, source/session cascade,
  unrelated-group isolation, and homogeneous mixed raw/canonical conflict resolution remain in the
  219-test union.
- Fresh v28 creation and v28 reopen no-op behavior are unchanged.

## Concerns

No in-scope correctness concern remains. The only diagnostic is the pre-existing ESLint
module-type warning; package metadata changes are outside this review fix.
