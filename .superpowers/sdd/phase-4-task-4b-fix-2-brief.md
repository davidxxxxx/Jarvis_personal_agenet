# Phase 4 Task 4B Review Fix Round 2

Base commit: `1f44aa93ffdd9e18dbd6092629779cce36398b17`

Close the remaining independent-review result `C0 / I2 / M0` with strict TDD. Preserve all prior Task 4B and fix-round-1 behavior. Use `apply_patch`; route TEMP/TMP/npm/Electron caches to `G:\Jarvis\.runtime-cache`; no C-drive temp, network, audio, GPU, or key.

Allowed production files:

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/MemoryRepository.js`

Allowed tests/reports:

- migration latest-version tests directly affected by the version bump
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `app/test/jarvis/MemoryRepository.test.js`
- `.superpowers/sdd/phase-4-task-4b-fix-2-report.md`

Do not modify `MemoryMerger.js`, runtime, IPC, renderer, network, budget behavior, or unrelated production modules.

## I1 - Existing v27 databases must receive the fix

The current code edits the v27 upgrade body while retaining `TARGET_VERSION = 27`; a database already migrated by commit `592f3059` returns `27 -> 27` and keeps the old triggers and any missing bridge rows.

Implement a real v28 migration:

1. Set `TARGET_VERSION = 28` and add an explicit `fromVersion < 28` upgrade.
2. Refactor the canonical-slot backfill and canonical conflict-trigger installer so they can be used by both fresh v27 creation and v27 -> v28 repair without recreating v27 tables.
3. For every `memory_items_v2` row, derive the exact canonical-v1 slot from `kind`, canonicalized `title`, and the sorted/deduped durable `memory_item_subjects.subject_id` set.
4. Insert missing `memory_item_canonical_slots` rows. If an existing bridge has a different algorithm/key, fail closed and roll back; never overwrite it.
5. Drop/recreate the corrected conflict member, conflict resolution, lifecycle, and supersession slot-integrity triggers deterministically in v28.
6. Preserve old raw keys and historical conflict group keys; do not bulk rekey.

Required RED/GREEN migration tests:

- a checked-in/base-style v27 fixture with old triggers and a post-v27 imported memory missing a bridge upgrades to v28, backfills the bridge, installs corrected trigger SQL, and supports the homogeneous mixed raw/canonical relation path;
- reopen `28 -> 28` is a no-op;
- an existing mismatched bridge makes v28 migration roll back completely at user_version 27;
- fresh `0 -> 28` and earlier supported versions remain valid.

Update only directly affected latest-version expectations.

## I2 - Heterogeneous legacy raw groups must fail closed

The old raw slot algorithm can group memories that map to different canonical-v1 slots after durable subjects are included. Matching one member is not enough.

Create one shared repository validation path for conflict-group semantic identity:

- derive each member's canonical-v1 slot from the actual memory fields plus durable subject rows; verify any stored bridge agrees;
- require a non-empty group and exactly one canonical-v1 slot across all members;
- a missing/mismatched bridge in a v28 production row or multiple derived semantic slots is corrupt/ambiguous and must fail closed;
- conflict application must validate every relevant historical/open group before reuse or episode calculation;
- `resolveMemoryConflict()` must validate the selected group before sampling the clock or writing group state/supersessions/lifecycles;
- multiple homogeneous semantic open groups continue to fail closed;
- homogeneous raw-key groups continue to reuse and resolve exactly as fix round 1 proved.

Tighten v28 trigger installation consistently:

- semantic member insertion is allowed only when the existing bridged group members are homogeneous with the new member;
- resolution of a fully bridged heterogeneous group is rejected at the schema boundary;
- supersession prefers canonical bridge equality whenever both rows are bridged, using raw-key equality only as compatibility fallback for a genuinely unmapped side;
- lifecycle transitions remain possible for the valid homogeneous mixed raw/canonical resolution flow.

Required RED/GREEN repository/schema tests:

1. Seed one raw-key group whose members have different durable subjects/canonical-v1 slots. Applying a candidate matching one member must throw before candidate/input/entity visibility and leave counts/hashes unchanged.
2. Resolving that heterogeneous group through `resolveMemoryConflict()` must fail before clock/ID/write and leave group/member/lifecycle/supersession rows unchanged.
3. Equivalent direct SQL resolution/member/supersession attempts are rejected by the v28 triggers when all involved rows are bridged.
4. Retain and rerun the homogeneous raw group -> canonical member -> select canonical member -> resolved lifecycle/supersession -> idempotent retry test.

Use stable coded errors (`MEMORY_CONFLICT_AMBIGUOUS` or an existing corruption error) and do not silently split, merge, or rekey historical groups.

## Verification

Run at minimum:

1. all new focused tests;
2. `MemoryRepository.test.js`, `MemorySubjectMigration.test.js`, `JarvisLineageMigration.test.js`, and directly affected latest migration tests;
3. `MemoryMerger.test.js`, `JarvisAnalysisWorker.test.js`, v25-v28 migration tests, `LongRunStatusSnapshot.test.js`;
4. changed-file ESLint and Prettier;
5. `git diff --check`.

Write `.superpowers/sdd/phase-4-task-4b-fix-2-report.md`, self-review both Important findings and all prior fixes, commit only authorized files/brief/report, and return SHA plus exact evidence. Worktree must be clean.
