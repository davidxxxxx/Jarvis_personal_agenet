# Phase 4 Task 4B Review Fix Round 1

Base commit: `592f30594bbf8f26b4205d3f322b20e972fb2b44`

Fix every independent-review finding below with focused RED/GREEN tests. Do not modify `MemoryMerger.js`, network, renderer behavior, runtime behavior, IPC, or unrelated production modules. Keep all TEMP/TMP/npm/Electron caches under `G:\Jarvis\.runtime-cache`.

Allowed production files:

- `app/src/jarvis/main/MemoryRepository.js`
- `app/src/jarvis/main/JarvisMigrations.js` only if a schema-integrity fix is genuinely necessary (prefer repository/query fixes)

Allowed tests/reports:

- `app/test/jarvis/MemoryRepository.test.js`
- `app/test/jarvis/MemorySubjectMigration.test.js`
- `app/test/jarvis/LongRunStatusSnapshot.test.js`
- directly affected migration tests only
- `.superpowers/sdd/phase-4-task-4b-fix-1-report.md`

## I1 - Post-v27 legacy imports must create canonical-v1 bridge rows

`JarvisRepository` migrates to v27 before `importLegacyAnalysis()`. Every legacy `memory_items_v2` row first created by that importer must receive one immutable `memory_item_canonical_slots` row in the same transaction. Compute the canonical-v1 slot with the exact `MemoryMerger` canonicalization and the durable subject IDs actually stored for that memory; do not trust the legacy raw key and do not guess identities. If no durable subjects exist, the canonical subject set is empty. Existing mapped targets remain idempotent and consume no extra ID/clock. Add a test that imports after v27, asserts the bridge, then proves a later canonical-v1 conflict/relation does not hit `memory conflict slot mismatch`.

## I2 - Reuse legacy raw-key open conflicts and preserve semantic episodes

Conflict application must locate an open group through semantic canonical-v1 identity, including a group whose persisted `slot_key` is an old raw key but whose members map through `memory_item_canonical_slots`. If exactly one semantic open group exists, reuse it and add new members. If multiple semantic open groups exist, fail closed and roll back. When creating a new group after resolved legacy episodes, compute the next episode across every group that represents the same canonical-v1 slot, not only literal `slot_key = canonical-v1`. Add repository-level tests for:

- one migrated raw-key open group reused by a new canonical-v1 conflict;
- a resolved raw-key episode followed by canonical-v1 conflict gets the next semantic episode;
- multiple semantic open groups fail closed with no candidate/input/entity writes.

Do not bulk rekey legacy rows or groups.

## I3 - Strictly validate semantic retries

In direct `applyCandidateAnalysis`, an input whose semantic candidate was already applied must still pass the strict closed candidate schema and allowed evidence/owner scope before comparing semantic hashes. A candidate with an extra field, missing field, out-of-scope evidence/owner, or otherwise malformed shape must fail closed; it must not return `already_applied`. This validation path may perform reads but must not invoke `MemoryMerger.plan`, clocks, ID allocation, or writes. Preserve valid reordered-semantic retry as read-only. Add focused tests for malformed extra-field and out-of-scope retry plus valid reorder no-work.

## I4 - Dual memory references must both resolve

For any action reference accepted by `resolveMemoryId`:

- supplied `memoryId` must exist in the canonical map;
- supplied `canonicalValueKey` must resolve;
- when both are supplied they must resolve to the same ID;
- missing/unknown/mismatched references fail closed.

Add an injected planner-action regression with a valid existing `memoryId` plus an unknown canonical key and prove the whole stored-candidate transaction rolls back, including candidate disposition and `analysis_inputs.candidate_hash`.

## M1 - Restore analysis-stage runtime-status coverage

Do not replace the `analyze_session` fixture with `generate_daily_digest`. Seed a minimal valid immutable `analysis_inputs` row and matching `analysis_desired_heads` row, then insert a valid cloud `analyze_session` job (`priority=70`, `analysis_input_id`, `desired_head_hash`, matching `input_hash`/`model_version`). Restore the expected `analysis` stage. Keep this as a test-only fixture correction; do not weaken v26 cloud-contract triggers.

## Verification

Run at minimum:

1. focused new tests;
2. `MemoryRepository.test.js`, `MemorySubjectMigration.test.js`, `JarvisLineageMigration.test.js`, `LongRunStatusSnapshot.test.js`;
3. `MemoryMerger.test.js`, `JarvisAnalysisWorker.test.js`, v25/v26/v27 migration tests;
4. changed-file ESLint and Prettier;
5. `git diff --check`.

Self-review every C/I/M item, write the fix report, commit only authorized files, and return the SHA with exact test evidence. No real network, audio, GPU, key, or C-drive temp writes.
