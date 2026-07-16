# Phase 4 Task 4B Review Fix Round 3

Base commit: `9cd6ae001585a84980c689b34475ba01abafa3f2`

Close the remaining independent-review result `C0 / I2 / M0` with strict RED/GREEN TDD. Preserve every prior Task 4B behavior and fix-round-2 gate. Use `apply_patch`; route TEMP/TMP/npm/Electron caches to `G:\Jarvis\.runtime-cache`; no C-drive temp, network, audio, GPU, or key.

Allowed production file:

- `app/src/jarvis/main/JarvisMigrations.js`

Allowed tests/reports:

- `app/test/jarvis/MemorySubjectMigration.test.js`
- directly affected migration/schema guard tests only if required
- `.superpowers/sdd/phase-4-task-4b-fix-3-report.md`

Do not modify `MemoryRepository.js`, `MemoryMerger.js`, runtime, IPC, renderer, network, or budget behavior.

## I1 - v28 must reject an incomplete v27 column contract

The v28 repair currently validates too few columns. SQLite may create a trigger whose `NEW`/`OLD` references name columns absent from the target table, so trigger creation is not proof that the v27 dependency contract is complete.

1. Enumerate and validate every column read or written by canonical bridge backfill and the deterministically installed subject/member/resolution/supersession/lifecycle triggers before dropping/replacing triggers or advancing `user_version`.
2. The required contract must cover at minimum:
   - `memory_items_v2`: `id`, `kind`, `canonical_slot_key`, `title`, `lifecycle`;
   - `memory_item_subjects`: `memory_item_id`, `subject_kind`, `subject_id`;
   - `memory_item_canonical_slots`: `memory_item_id`, `canonical_slot_key`, `algorithm`;
   - `memory_conflict_groups`: `id`, `slot_key`, `episode`, `state`, `selected_member_id`, `resolved_at`, `created_at`, `updated_at`;
   - `memory_conflict_members`: `group_id`, `memory_item_id`, `created_at`;
   - `memory_supersessions`: `previous_id`, `next_id`, `reason`, `analysis_input_id`, `created_at`.
3. A partial v27 schema missing any dependency column must throw before trigger replacement and before `user_version` changes; the complete transaction must roll back to version 27.
4. Preserve the intentional earlier-version component-fixture behavior only when the complete v27 memory schema is wholly absent, as fix round 2 established. A `user_version=27` database must never skip this validation.

Required RED/GREEN test: derive a base-style v27 database, rebuild `memory_conflict_groups` without `selected_member_id` (and preferably table-driven checks for other trigger dependency columns), then prove `applyJarvisMigrations()` throws, `user_version` remains 27, the partial table remains unchanged, and no replacement trigger survives.

## I2 - subjects become immutable once a canonical bridge exists

`memory_item_subjects` currently blocks UPDATE and DELETE but allows INSERT after `memory_item_canonical_slots` is written. This lets the actual canonical-v1 identity drift while all schema guards continue trusting the stale stored bridge.

1. Add a `BEFORE INSERT ON memory_item_subjects` trigger that aborts whenever a canonical bridge already exists for `NEW.memory_item_id`.
2. Preserve the legitimate construction order: insert the memory row, insert all durable subject rows, then insert the canonical bridge.
3. Install/reinstall this trigger deterministically for both fresh v27/v28 creation and v27->v28 repair. A missing or hostile old trigger must be replaced by the reviewed definition.
4. Do not recompute or overwrite existing bridges. The earlier mismatch rollback remains strict.
5. Keep subject UPDATE/DELETE immutability and session/source deletion behavior unchanged.

Required RED/GREEN tests:

- fresh v28 rejects subject INSERT after bridge creation and leaves the subject set/bridge unchanged;
- v27->v28 with a missing or stale subject-insert trigger installs the exact reviewed trigger;
- the full direct-SQL bypass from review cannot start: after two bridged same-slot memories are created, adding a new subject to one is rejected before conflict membership/resolution/supersession/lifecycle writes;
- normal repository-style subject-before-bridge construction still succeeds;
- the homogeneous raw-key -> canonical member -> resolved lifecycle path from fix round 1 still passes.

Use stable SQLite trigger errors consistent with the existing immutable-subject contract.

## Verification

Run at minimum:

1. all new focused tests with exact test-name patterns;
2. `MemorySubjectMigration.test.js`, `MemoryRepository.test.js`, `JarvisLineageMigration.test.js`, `JarvisMigrations.test.js`, and directly affected latest-version migration tests;
3. the prior required eight-file Task 4B gate;
4. changed-file ESLint and Prettier;
5. `git diff --check`.

Write `.superpowers/sdd/phase-4-task-4b-fix-3-report.md`, self-review both Important findings and all prior Task 4B fixes, commit only authorized files/brief/report, and return SHA plus exact RED/GREEN evidence. Worktree must be clean.
