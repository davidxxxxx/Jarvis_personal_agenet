# Phase 4 Task 4B Review Fix Round 4

Base commit: `06c3f12a29eefed454b11adea6f5ad5ae056af5c`

Close the remaining independent-review result `C0 / I1 / M0` with strict RED/GREEN TDD. Preserve every prior Task 4B behavior. Route all TEMP/TMP/npm/Electron caches to `G:\Jarvis\.runtime-cache`; no C-drive temp, network, audio, GPU, or key. Use `apply_patch`.

Allowed production file: `app/src/jarvis/main/JarvisMigrations.js`.
Allowed test/report files: `app/test/jarvis/MemorySubjectMigration.test.js` and `.superpowers/sdd/phase-4-task-4b-fix-4-report.md`.

## Finding

`upgradeMemoryConflictIntegrityV28()` currently calls canonical bridge backfill before the integrity installer drops/recreates `memory_item_subjects_immutable_insert`. A hostile pre-v28 trigger using that reviewed name but attached to `BEFORE INSERT ON memory_item_canonical_slots` can abort a legitimate missing-bridge backfill before deterministic replacement.

## Required behavior

1. Add an exact RED fixture: complete v27 schema, one valid memory missing its canonical bridge, and a hostile `memory_item_subjects_immutable_insert` trigger attached to canonical-slot INSERT that raises a unique error. Current migration must fail for that hostile error.
2. After the complete required-table/column contract is validated, but before canonical bridge backfill, drop only the stale `memory_item_subjects_immutable_insert` trigger inside the existing outer migration transaction.
3. Backfill exact canonical-v1 bridges, then run the full deterministic installer so the reviewed subject INSERT freeze and the four conflict-integrity triggers are installed.
4. If bridge validation/backfill or later installation fails, the outer transaction must roll back the early DROP, preserve `user_version=27`, and restore the previous trigger definition.
5. Do not weaken bridge mismatch rollback, missing-column fail-closed, subject-after-bridge freeze, update/delete immutability, source/session cascade, unrelated-group isolation, or homogeneous mixed raw/canonical resolution.

Required GREEN tests:

- hostile wrong-target same-name trigger plus missing bridge upgrades to v28, backfills exact bridge, and installs the reviewed trigger on `memory_item_subjects`;
- hostile trigger plus mismatched existing bridge rolls back to v27 and restores the hostile trigger exactly;
- prior fix-3 focused 6 tests, required-column rollback, v28 repair/no-op, and Task 4B combined gate remain green.

Run focused tests, the prior 9-file union, changed-file ESLint/Prettier, and `git diff --check`. Write the fix-4 report, self-review, commit only authorized files/report, and return SHA plus exact evidence with a clean worktree.
