# Phase 4 Task 4A report - pure deterministic MemoryMerger planner

## Scope and takeover state

- Base/starting HEAD: `572675d226daf87745dc5a5b2179914f3401e59c` on the existing isolated worktree.
- Takeover status contained only the two intended untracked files:
  - `app/src/jarvis/main/MemoryMerger.js`
  - `app/test/jarvis/MemoryMerger.test.js`
- No interrupted partial write, conflict marker, repository change, migration change, or unrelated worktree damage was found.
- All commands used `TEMP`, `TMP`, `npm_config_cache`, and `ELECTRON_CACHE` below `G:\Jarvis\.runtime-cache`. No network, key, audio, GPU, clock service, or real database outside the repository tests was used.

## Inherited TDD evidence

The handoff reported twelve completed requirement groups and an original focused result of 19/19. Those behaviors were present as the first nineteen focused tests at takeover, covering canonical-v1, semantic hashing, purity, topic merge behavior, memory/event/todo/suggestion behavior, fail-closed validation, trusted replacement proof, row permutations, and idempotent topic occurrence reuse.

This report does not relabel that prior-agent evidence as personally observed RED output. I personally reran the complete inherited file immediately on takeover. The handoff predicted 19/21 after two review tests, but the actual fresh result was 20/21:

- `duplicate canonical snapshot identities fail closed before row order can choose a winner` was already GREEN. Source review confirmed topic canonical-key uniqueness was checked before constructing the lookup map.
- `reusable memory occurrence tie-breaks by ID independent of snapshot order` was the only RED. The plan selected `occurrence-a` versus `occurrence-b` according to snapshot order.

After the minimal memory occurrence ID tie-break, the then-current focused suite was fresh GREEN at 21/21.

## Personally verified RED/GREEN evidence

All behavioral RED runs below used `node --test --test-name-pattern=... test/jarvis/MemoryMerger.test.js`, except the takeover RED which used the complete focused command.

| Behavior                                          | Observed RED                                                                                                                                                                                                   | Minimal GREEN                                                                                                       | Green evidence                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Reusable memory occurrence                        | Complete focused: 20 passed, 1 failed; selected occurrence changed between `occurrence-a` and `occurrence-b` after reversing snapshot order.                                                                   | Sort reusable occurrences by ID before selecting a shared-evidence occurrence.                                      | Complete focused 21/21.             |
| Reusable active-todo occurrence                   | Targeted 0/1; selected occurrence changed between `occurrence-a` and `occurrence-b`.                                                                                                                           | Sort todo occurrences by ID before selecting.                                                                       | Targeted 1/1.                       |
| Transcript supersession occurrence                | Targeted 0/1; `priorOccurrenceId` changed between `occurrence-a` and `occurrence-b`.                                                                                                                           | Sort prior occurrences by ID before the existing authorization-and-break logic.                                     | Targeted 1/1.                       |
| Topic canonical identity collision                | Targeted 0/1; two future topic inserts were returned for one canonical key (`2 !== 1`). A strengthened normalized-semantic/display tie then failed because retained `name`/`summary` changed with input order. | Group topics by planner canonical key and use a fixed display tuple as the final canonical sort tie-break.          | Targeted 1/1 after each step.       |
| Todo canonical identity collision                 | Targeted 0/1; two future todo inserts were returned for one canonical base key (`2 !== 1`). A strengthened display tie then failed because retained `title`/`dueText` changed with input order.                | Group todos by resolved planner canonical key and use a fixed display tuple tie-break.                              | Targeted 1/1 after each step.       |
| Memory-value and suggestion identity collision    | Targeted 0/1; retained display wording changed with input order and duplicate unique identities produced extra inserts.                                                                                        | Group memories by canonical value key and suggestions by canonical key; use fixed display tuples.                   | Targeted 1/1.                       |
| Duplicate evidence preservation                   | Strengthened targeted 0/1; memory insert contained only `seg-2`, not the required sorted union `seg-1`, `seg-2`.                                                                                               | Clone the selected item and union/sort/deduplicate memory and suggestion evidence within the identity group.        | Targeted 1/1.                       |
| Unified existing-vs-candidate conflict descriptor | Targeted 0/1; implementation returned singular `candidateCanonicalValueKey` instead of sorted `candidateCanonicalValueKeys`.                                                                                   | Accumulate conflicts by canonical slot into sets, then emit the unified sorted-array descriptor.                    | Combined conflict targeted run 2/2. |
| Candidate-vs-candidate changed bodies             | Targeted 0/1; both distinct values were inserted but `conflicts` was empty.                                                                                                                                    | Accumulate all distinct candidate value keys for the slot while preserving both inserts.                            | Combined conflict targeted run 2/2. |
| Applied candidate-candidate conflict no-op        | Strengthened targeted 0/1; both inserts and links were no-ops but the planner repeated the conflict action.                                                                                                    | Emit the candidate-candidate conflict only while at least one candidate value is absent from the existing snapshot. | Targeted 1/1.                       |

One initial topic-collision test run had a test-source Unicode transfer syntax error. It was corrected to explicit `\uFFxx` escapes and rerun to the behavioral `2 !== 1` RED above; the syntax-error run is not counted as TDD RED evidence.

## Final implementation behavior

- Exports the required algorithm constants, canonicalization/hash helpers, Dice-bigram similarity helper, validation error, and pure `MemoryMerger.plan(input)` API.
- Canonical-v1 uses NFKC, Unicode whitespace collapse, trim, locale-independent lowercase, punctuation preservation, fixed JSON-array tuple hashing, SHA-256 hex, and code-point sorting.
- Candidate collections and nested evidence/subject sets are copied, normalized, deterministically sorted, and never mutate caller data.
- Candidate identity collisions converge before planning unique writes. Stable display/confidence selection is independent of input order; memory and suggestion evidence is preserved as a sorted union.
- Changed memory values in one slot remain distinct and produce one unified conflict descriptor:

  ```js
  {
    canonicalSlotKey,
    existingMemoryIds: [],
    candidateCanonicalValueKeys: [],
    reason: "independent_changed_body"
  }
  ```

- Existing occurrence selection, supersession selection, action arrays, nested IDs, and semantic references are deterministic under snapshot/candidate permutations.
- Planner validation fails closed for malformed private snapshots, duplicate canonical snapshot identities, cross-session/missing/malformed evidence, invalid bindings/intervals, factual zero-evidence, unknown kinds, and incomplete/untrusted transcript replacements.
- The planner performs no SQLite/file/network access and creates no IDs or timestamps. Task 4B remains responsible for snapshot adaptation, transactions, IDs, timestamps, and applying descriptors.

## Final verification

Environment prefix for every command:

```powershell
$cache = 'G:\Jarvis\.runtime-cache'
$env:TEMP = "$cache\tmp"
$env:TMP = "$cache\tmp"
$env:npm_config_cache = "$cache\npm"
$env:ELECTRON_CACHE = "$cache\electron"
```

Commands and fresh results:

- `node --test test/jarvis/MemoryMerger.test.js` - PASS, 27/27.
- `node --test test/jarvis/JarvisAnalysisSchema.test.js test/jarvis/MemoryRepository.test.js` - PASS, 58/58.
- `node_modules/.bin/eslint.cmd src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js` - PASS, exit 0. It prints the repository's existing `MODULE_TYPELESS_PACKAGE_JSON` performance warning for `src/eslint.config.js`; no lint rule warning/error was reported in the task files.
- `node_modules/.bin/prettier.cmd --check src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js` - PASS, both files matched.
- `git diff --check` - PASS after report creation and final content review.

## Changed files

- `app/src/jarvis/main/MemoryMerger.js`
- `app/test/jarvis/MemoryMerger.test.js`
- `.superpowers/sdd/phase-4-task-4a-report.md`

## Self-review

- Reviewed every brief section against the final source and all 27 focused tests.
- Confirmed no IDs/timestamps are generated or returned, no inputs are mutated, and no arbitrary public snapshot adaptation exists.
- Confirmed exact topic reuse/revision rules, inclusive Dice threshold, canonical merge-pair ordering, and terminal merge-suggestion idempotency.
- Confirmed exact memory/event occurrence rules, conflict preservation, and supersession only from explicit complete same-session replacement lineage.
- Confirmed terminal todo monotonicity/recurrence boundaries and suggestion terminal-state behavior.
- Confirmed fail-closed validation occurs before returning a plan and duplicate existing canonical map identities cannot select a row by input order.
- Confirmed final file scope is limited to the two requested code/test files plus this report.

## Follow-up review closure

Independent review recorded C0/I3/M1 in `phase-4-task-4a-review.md`. The follow-up changed only the approved planner, focused test, and report files.

### Follow-up RED/GREEN evidence

| Review item                             | Observed RED                                                                                                                                             | Minimal GREEN                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 event candidate convergence          | Targeted 0/1: two same-value events separated beyond the inclusive 30-minute window incorrectly converged into one insert.                               | Cluster same-value event candidates by deterministic evidence intervals before value convergence; keep the first cluster as the insert and plan later clusters as occurrences. Targeted 1/1; full focused 28/28.                             |
| I2 candidate-candidate topic similarity | Targeted 0/1: two new candidate topics with raw Dice score exactly `0.72` produced no merge suggestion.                                                  | Compare canonical unordered pairs across active existing and candidate topic references, include pairs with at least one candidate, apply the inclusive raw threshold, and suppress already-applied pairs. Targeted 1/1; full focused 29/29. |
| I3 todo terminal leaf selection         | Targeted 0/1: later evidence for a completed A -> B chain planned no recurrence because A was selected by ID instead of B as the terminal leaf.          | Select the unique no-outgoing leaf when no open instance exists. Targeted 1/1.                                                                                                                                                               |
| I3 todo graph validation                | Targeted parent plus seven subtests: 3 passed and 5 failed; cross-base edges, cycles, ambiguous leaves, and multiple active instances were not rejected. | Validate same-base edges, acyclicity, one incoming/outgoing edge maximum, exactly one leaf per base, at most one open instance, and require the open instance to be that leaf. Matrix 8/8; combined leaf/matrix 9/9; full focused 38/38.     |

### M1 planner decomposition

After the behavior fixes were green, `MemoryMerger.plan` was reduced to validation, candidate-context resolution, pure helper orchestration, deterministic array combination, and result construction. Planning is now separated into `planTopics`, `planMemories`, `planTodos`, and `planSuggestions`, with shared evidence-bound calculation isolated as a pure helper. The complete focused suite was run after each extraction step:

- candidate-context extraction - 38/38
- `planTopics` - 38/38
- `planMemories` - 38/38
- `planTodos` - 38/38
- `planSuggestions` - 38/38

### Follow-up final verification

- `node --test test/jarvis/MemoryMerger.test.js` - PASS, 38/38.
- `node --test test/jarvis/JarvisAnalysisSchema.test.js test/jarvis/MemoryRepository.test.js` - PASS, 58/58.
- `node_modules/.bin/eslint.cmd src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js` - PASS, exit 0; only the existing `MODULE_TYPELESS_PACKAGE_JSON` performance warning was printed.
- `node_modules/.bin/prettier.cmd --check src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js ../.superpowers/sdd/phase-4-task-4a-report.md` - PASS.
- `git diff --check` and `git diff --cached --check` - PASS.

## Round 2 follow-up closure

Round 2 recorded C0/I2/M0 and explicitly confirmed the original I1/I2/I3/M1 closure. This second follow-up again changed only the approved planner, focused test, and report files.

### Round 2 RED/GREEN evidence

| Review item                                      | Observed RED                                                                                                                                                                                                                                                                                                                                                         | Minimal GREEN                                                                                                                                                                                                                                                         | Green evidence                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I4 topic/todo canonical duplicate evidence union | Targeted 0/2: both retained actions contained only `seg-2`, losing disjoint `seg-1`; expected sorted union was `seg-1`, `seg-2`.                                                                                                                                                                                                                                     | Pass `evidenceSegmentIds` through the existing deterministic canonical-group convergence for topics and todos so the selected display representative receives the normalized group union.                                                                             | Targeted 2/2; complete focused 40/40. Each test also applies the union to one occurrence and proves the repeated logical candidate plans no insert, revision/link, or recurrence. |
| I5 recurrence source lineage                     | Targeted parent plus nine subtests: 4 passed and 6 failed. Valid owned/later source and retention-null source were accepted; existing validation already rejected open previous and malformed `completedAt`. Missing rejections were dangling source, previous-owned source, equal/too-early start, and dismissed previous; the failed parent was the sixth failure. | Build a validated occurrence map of `occurrenceId -> { todoId, startedAt }`; require every recurrence previous todo to be completed even with null source; require a non-null source to exist, belong to the next todo, and start strictly after previous completion. | Original matrix 10/10 after the fix. Added explicit malformed source-start coverage for final targeted 11/11; complete focused 51/51.                                             |

The first I4 test construction incorrectly repeated an evidence ID inside one candidate item and was rejected as `malformed_candidate`. It was corrected to repeat evidence only across three individually valid canonical-identical candidates before the behavioral 0/2 RED above; the construction error is not counted as RED evidence.

### Round 2 final verification

- `node --test test/jarvis/MemoryMerger.test.js` - PASS, 51/51.
- `node --test test/jarvis/JarvisAnalysisSchema.test.js test/jarvis/MemoryRepository.test.js` - PASS, 58/58.
- `node_modules/.bin/eslint.cmd src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js` - PASS, exit 0; only the existing `MODULE_TYPELESS_PACKAGE_JSON` performance warning was printed.
- `node_modules/.bin/prettier.cmd --check src/jarvis/main/MemoryMerger.js test/jarvis/MemoryMerger.test.js ../.superpowers/sdd/phase-4-task-4a-report.md` - PASS.
- `git diff --check` and `git diff --cached --check` - PASS.
