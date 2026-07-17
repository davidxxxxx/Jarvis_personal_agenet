# Jarvis SDD Progress

Branch: `codex/jarvis-all-day-runtime`
Merge base: `b0d1b96ab35c1bb77f87008a923f9c5db27b0a17`

## Phase 1 - Evidence and Dual-Track Capture

- Task 1: complete (commits b0d1b96a..a4417e4b, review clean)
- Task 2: complete (commits a4417e4b..55e5f479, review clean after two fix rounds)
- Task 3: complete (commits 55e5f479..9e91ce2f, review clean after two fix rounds)
- Task 4: complete (commits 9e91ce2f..37dae3ec, review clean after four fix rounds)
- Task 5: complete (commits 37dae3ec..a039d7d7, review clean after five fix rounds)
- Task 6: complete (commits a039d7d7..14c46a8f, review clean after two fix rounds)
- Task 7: complete (commits 14c46a8f..5bc793a0, review clean after two fix rounds)
- Task 8: complete (review clean; implementation commit immediately follows `5bc793a0`)
- Task 8.1: complete (commit `fe4e975b`, review clean after one fix round)
- Task 9: complete (commit `7a9739db`, review clean after four rounds)
- Task 10: complete (commits `555984a8`..`450c3d76`, review clean after five rounds)
- Task 11: complete (commits `35c9a85d`..`dfe49427`, review clean after four fix rounds)
- Task 12: complete (commits `c19c1283`..`752e7087`, review clean after two fix rounds)

## Phase 2 - Complete Transcription and Session Playback

- Task 1: complete (commits `ecb126a2`..`af3c0014`, review clean after one fix round)
- Task 2: complete (commits `237711a6`..`9fee811f`, review clean after one fix round)
- Task 3: complete (commits `b43a999a`..`b1c71dbc`, review clean after one fix round)
- Task 4: complete (commits `e5b1fb7d`..`181f3626`, review clean after one fix round)
- Task 5: complete (commits `0e6dd2e4`..`05a97c01`, review clean after two fix rounds)
- Task 6: complete (commits `ddf35a5c`..`53f0fb81`, review clean after one fix round)
- Task 7: complete (commit `8f17cfa4`, review clean)
- Task 8: complete (commits `8f17cfa4`..`682a7df2`, review clean after one fix wave)
- Task 9: complete (commits `a8abe83f`..`44107f91`, review clean after two fix waves plus focused FLAC audit)
- Task 10: complete (commits `a6d798c2`..`02774b80`, review clean after three fix waves; final C0/I0/M0)
- Task 11: complete (commits `5ffa1f11`..`1c320a8d`, review clean after three fix rounds; final C0/I0/M0)
- Task 12: complete (commits `513b327a`..`a1bcf7bc`, independent review clean after one fix round; final C0/I0/M0)
- Task 13: complete (commits `3fa991aa`..`487de817`, independent review clean after one fix round; final C0/I0/M0; real microphone/CUDA/WPR hardware gates remain explicitly NOT RUN)

## Phase 3 - Speaker and Long-Term Identity

- Task 1: complete (commits `5d462bc5`..`4819e1d8`, independent review clean after two fix rounds; final C0/I0/M0)
- Task 2: complete (commits `b60bcab3`..`4746654f`, independent review clean after two fix rounds; final C0/I0/M0; real microphone/model hardware UAT remains NOT RUN)
- Task 3: complete (commits `17fc0521`..`d9604719`, independent review clean after three fix rounds; final C0/I0/M0; real microphone/model hardware UAT remains NOT RUN)
- Task 4: complete (commits `559f5699`..`fd64e0ce`, independent review clean after one fix round plus full-suite baseline/cleanup alignment; final C0/I0/M0; real microphone/CAM++/CUDA/MiniMax hardware/network gates remain NOT RUN)
- Task 5: complete (commits `503acb4d`..`1f8e08a8`, plus baseline lifecycle fix `ef500009`; independent review clean after one fix round; final C0/I0/M0; hardware/network UAT remain NOT RUN)
- Task 6: complete (commit `1d6ec462`, independent review clean; final C0/I0/M0; private hardware/model/audio evaluation NOT RUN)
- Task 7: complete (commits `52fa1fe4`..`f6e61bfd`; independent reviews clean with final C0/I0/M0; private speaker quality, physical hardware/CUDA, and cloud/network validation remain explicitly NOT RUN)

## Phase 4 - Evidence-Based Memory and Personal-Agent Output

- Task 1: complete (commits `2a5591e1`..`217074cf`; durable v2 lineage, history semantics, redacted payload storage, conflict lifecycle, legacy import, and v25 budget schema/core; independent reviews clean after cross-session importer fixes; final C0/I0/M0)
- Task 2: complete (commit `4b95be0c`; v2 closed schema, deterministic redacted input builder, single-request official-endpoint MiniMax client, v2 scheduler chain, and production fail-closed wiring; independent review clean after two privacy/idempotence fix rounds; final C0/I0/M0)
- Task 7A budget foundation: in progress (commits `3378281f`, `1b72387d`; durable v25 ledger, service lifecycle, and awaited encrypted MiniMax secret persistence complete; worker/IPC/GUI integration pending)
- Task 8A final-only foundation: in progress (commit `2c871300`; branded immutable admission snapshot, priority 70/80 contract, and independent cloud pressure projection complete; durable desired-head/cloud lane/runtime integration pending)
- Task 8B durable cloud-lane foundation: complete (commit `8639b41e`; v26 desired-head CAS, immutable response candidates, startup zero-network recovery, and disjoint local/cloud processing lanes; independent review clean after one fix round; final C0/I0/M0)
- Task 3: complete (commits `c3237627`, `07a6d25f`, `572675d2`; durable one-request analysis worker, restart-safe cloud dispatcher, authoritative budget recovery, enqueue-only scheduler, and zero-network candidate recovery; independent review clean after two fix rounds; final C0/I0/M0)
- Task 4A pure planner: complete (commits `e2796836`, `244eb60e`, `b7f336d3`; canonical-v1 semantic planner, event clustering, topic similarity, conflict and recurrence lineage, deterministic convergence; independent review clean after two fix rounds; final C0/I0/M0)
- Task 4B transactional repository: complete (commits `592f3059`, `1f44aa93`, `9cd6ae00`, `06c3f12a`, `eae44ec7`; deterministic one-transaction plan application, canonical-v1 bridge repair, heterogeneous conflict fail-closed, subject identity freeze, and tightened member/resolution/supersession/lifecycle guards; independent review clean after four fix rounds; final C0/I0/M0)
- Task 5A durable daily-digest inputs: complete (commits `13da56a2`, `be784d99`, `5537b672`; v29 immutable input/candidate schema, sessionless digest job identity, deterministic local-day evidence snapshots, privacy boundary, migration rollback/identity audits, and indexed long-run queries; three independent review gates, final Spec PASS / Quality PASS / C0/I0/M0; final verifier superset 324/324)
- Task 5B1 digest schema and MiniMax client: complete (commits `9e290763`, `e4a57d27`, `482ca7e1`, `c3832c42`; exact evidence-backed output contract, subject/evidence binding, user-controlled suggestions, shared 1 MiB input boundary, official-origin one-request client, authoritative usage handling, all-string secret/path fail-closed scanning, bounded streaming response reads, and English/Chinese automatic-action semantics; independent Spec PASS / Quality PASS / C0/I0/M0; final verifier superset 149/149)
- Task 5B2 digest service and crash recovery: complete (commit `c0e9fedd`; strict immutable-input binding, two-pass source freshness, exact admission/budget lifecycle, candidate-first zero-network recovery, paid/unknown crash-window convergence, and analysis/digest claim isolation; focused verifier 316/316 plus ESLint/diff checks)
- Task 5C shared cloud/runtime/daily-digest integration: complete (shared priority-fenced cloud lane, IANA/DST-safe scheduler, per-repository production composition, missing-key zero-network behavior, date-only privacy-safe IPC; focused verifier 420/420; typecheck/ESLint/diff clean; independent review C0/I0)
- Task 6: complete (durable knowledge/daily review UI, evidence navigation, bounded indexed public snapshots, safe session projections, and retry-safe user actions; main focused 150/150 plus migration 51/51 and renderer 293/293; independent review C0/I0)
- Task 7: complete (production analysis-budget runtime facade, awaited MiniMax key save/clear,
  strict public IPC/preload projections, durable restart-safe analysis status, and independent
  MiniMax budget/settings UI; full Jarvis regression green after final change; independent review
  C0/I0/M0)
- Task 8: in progress (release matrix and packaged Windows offline/restart smoke automation landed in
  the working tree; real unsigned package build, ABI scan, unpacked launch, and matrix evidence update
  pending)

## Review Notes

- Phase 1 Task 1 minor: focused empty-DB test does not inspect every new evidence-table column/foreign key/unique constraint; final review should decide whether broader migration assertions are worthwhile.
- Phase 1 Task 2 minor: legacy duplicate non-null `(track_id, sequence_number)` rows fail v2 migration atomically with a generic SQLite diagnostic; no rows are discarded and `user_version` is not advanced.
- Phase 1 Task 3 minor: focused tests do not inject successful-callback sidecar cleanup (`unlinkSync`) failure, and do not separately inject every WAV/sidecar write, fsync, hash, or descriptor-close failure; the shared cleanup path was independently reviewed and approved.
- Phase 2 Task 3 minor: the reverse-target mutation regression test combines the non-final target condition with each cross-track/session/time case, so branch isolation could be sharper; implementation guards were independently reviewed and approved.
