# Jarvis Phase 4 release acceptance

This is the canonical release-candidate matrix for Phase 4. It is intentionally conservative:
results from an older commit or from a worktree before the final change do not automatically carry
forward. This evidence revision records only gates actually run against hardened candidate
`e0303215f8cf9a25430e851a6e1bb53e034e2776`. Physical-device, private-speaker, real-inference,
migration-interruption, and live-network rows remain blocked or not run as stated below.

All caches, temporary profiles, logs, reports, packages, and copied fixtures used by this gate must
stay below `G:\Jarvis`. The canonical evidence root is
`G:\Jarvis\.release-evidence\phase-4\<run-id>`.

## Status vocabulary

- `PASS` means actual execution completed against the recorded candidate and its evidence is present.
- `NOT RUN` means the gate was not executed against the recorded candidate.
- `BLOCKED` means a prerequisite is unavailable; the blocker must be named and must not be presented
  as a test failure or a pass.

Only these three status values are valid. A skipped test is not a pass. A deterministic simulation
is not physical-hardware evidence. A build completing is not packaged launch, offline, or restart
evidence.

## Current matrix

<!-- RELEASE_ACCEPTANCE_MATRIX_START -->

| Gate ID             | Gate                                                                                            | Status    | Evidence or blocker                                                                                                                                                                                                                                                                    | Required G-drive command or procedure                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTO_REGRESSION     | Full Jarvis main and renderer regression                                                        | `PASS`    | observed=2026-08-04T06:08:00+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\SUMMARY.md; result=main 2361 passed with 3 platform skips; renderer 434 passed.                                                | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; $env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'; npm run test:main; npm run test:renderer`                                           |
| STATIC_GATES        | Typecheck, lint, renderer build, release version, and patch hygiene                             | `PASS`    | observed=2026-08-04T06:15:00+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\SUMMARY.md; result=all commands exited 0; five inherited lint warnings were non-blocking.                                      | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; npm run typecheck; npm run lint; npm run build:renderer; npm run release:check -- --tag jarvis-v0.2.0-rc.2; Set-Location ..; git diff --check`                                                           |
| VIRTUAL_CAPTURE_3H  | Three-hour deterministic capture, FLAC, migration, and retention endurance                      | `NOT RUN` | Not executed: candidate-specific soak was not rerun after the acoustic dedupe and retry-lifecycle changes; rc.1 evidence is not inherited.                                                                                                                                             | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run test:jarvis:capture-soak`                                                                                                         |
| VIRTUAL_RESOURCE_3H | Three-hour deterministic CPU, GPU-pressure, preview, and queue governance endurance             | `NOT RUN` | Not executed: candidate-specific soak was not rerun after the retry-lifecycle change; rc.1 evidence is not inherited.                                                                                                                                                                  | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run test:jarvis:resource-soak`                                                                                                        |
| WINDOWS_PACKAGE     | Unsigned Windows package and package-safety scan                                                | `PASS`    | observed=2026-08-04T06:15:00+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\SUMMARY.md; result=guarded build, safety scan, unsigned check, and model-component publication passed.                         | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; npm run build:win:unsigned -- --output-dir G:\Jarvis\releases\0.2.0-rc.2-e0303215`                                                                                                                       |
| NATIVE_ABI          | Source Node ABI restore and packaged Electron ABI/bindings smoke                                | `PASS`    | observed=2026-08-04T06:15:00+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\SUMMARY.md; result=packaged Electron ABI 145 and restored source Node ABI 137 loaded successfully.                             | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; node scripts\verify-native-abi.js (Get-Command node.exe).Source (Resolve-Path node_modules\better-sqlite3) (Resolve-Path node_modules\better-sqlite3\build\Release\better_sqlite3.node) 137 source-node` |
| PACKAGED_OFFLINE    | Unpacked executable launch with process-scoped offline transport                                | `PASS`    | observed=2026-08-04T06:15:40+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.runtime-cache\packaged-smoke-rc2-e0303215\runs\1785795330040-35892-b935967e\packaged-smoke.jsonl; result=two launches remained offline and exited gracefully.                 | `npm run smoke:win:unpacked -- --runtime-root G:\Jarvis\.runtime-cache\packaged-smoke-rc2-e0303215 --executable 'G:\Jarvis\releases\0.2.0-rc.2-e0303215\win-unpacked\Jarvis Memory.exe' --expected-commit e0303215f8cf9a25430e851a6e1bb53e034e2776`                     |
| PACKAGED_RESTART    | Fresh isolated-profile real session persistence, reopen, and no-duplicate smoke                 | `PASS`    | observed=2026-08-04T06:15:40+08:00; commit=e0303215f8cf9a25430e851a6e1bb53e034e2776; evidence=G:\Jarvis\.runtime-cache\packaged-smoke-rc2-e0303215\runs\1785795330040-35892-b935967e\packaged-smoke.jsonl; result=the synthetic session existed exactly once before and after restart. | `npm run smoke:win:unpacked -- --runtime-root G:\Jarvis\.runtime-cache\packaged-smoke-rc2-e0303215 --executable 'G:\Jarvis\releases\0.2.0-rc.2-e0303215\win-unpacked\Jarvis Memory.exe' --expected-commit e0303215f8cf9a25430e851a6e1bb53e034e2776`                     |
| LEGACY_FIXTURE      | Migration interruption and recovery on a copied real-shaped legacy database                     | `NOT RUN` | Not executed: the candidate-specific v48 migration and cold reopen passed, but the forced interruption portion was not run; full legacy and migration acceptance remains blocked on this gate.                                                                                         | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; run the migration fault-injection harness only against a disposable G:\Jarvis\.release-evidence copy, then verify restart, idempotence, integrity, foreign keys, and counts`                             |
| REAL_MIC            | Physical microphone selection, dual capture, interruption recovery, and wall-clock resource UAT | `BLOCKED` | blocker=requires explicit tester consent for physical recording and coordinated disconnect/reconnect actions; this candidate did not capture physical audio during automated acceptance.                                                                                               | `& 'G:\Jarvis\releases\0.2.0-rc.2-e0303215\win-unpacked\Jarvis Memory.exe' --user-data-dir='G:\Jarvis\.release-evidence\phase-4\<run-id>\profiles\real-mic'`                                                                                                            |
| CUDA_WHISPER        | Verified real CUDA Whisper inference, fallback, and GPU-pressure UAT                            | `BLOCKED` | blocker=the server reported `cuda: true` at startup, but no candidate-specific real inference was recorded; startup alone does not prove GPU inference.                                                                                                                                | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run jarvis:cuda:self-test`                                                                                                            |
| CAMPP_IDENTITY      | Consented private CAM++ enrollment and persistent speaker-identity quality UAT                  | `BLOCKED` | blocker=no candidate-specific consented private quality fixture and aggregate CAM++ report are available.                                                                                                                                                                              | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:JARVIS_SPEAKER_EVAL_DIR='G:\Jarvis\.private\speaker-eval'; npm run test:speaker-eval`                                                                                                               |
| MINIMAX_LIVE        | Live MiniMax analysis and daily-digest network UAT under the configured budget                  | `BLOCKED` | blocker=no candidate-specific authorized billable provider request was performed; offline, budget, schema, retry, and redaction behavior is covered only by tests.                                                                                                                     | `& 'G:\Jarvis\releases\0.2.0-rc.2-e0303215\win-unpacked\Jarvis Memory.exe' --user-data-dir='G:\Jarvis\.release-evidence\phase-4\<run-id>\profiles\minimax-live'`                                                                                                        |

<!-- RELEASE_ACCEPTANCE_MATRIX_END -->

## Candidate-specific supplemental evidence

- Real v48 migration: candidate `e0303215f8cf9a25430e851a6e1bb53e034e2776` migrated a pristine
  G-drive copy from v48 to v58, preserved 40 sessions, 9988 audio chunks, and 9698 transcript rows,
  passed integrity and foreign-key checks, cold reopened, and completed a second idempotent
  migration. Evidence:
  `G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\migration\jarvis-v48-to-v58-candidate.db`.
- Acoustic duplicate repair: in the running packaged Memory view, the reported KOOK primary row is
  visible, its system-mix fallback is hidden through the durable `duplicate_of` relation, and the
  competing DOTA 2 row remains independent. A 15-second live observation added no deferral warning;
  per-session retry is bounded to 60 seconds and can release early when resources recover. Evidence:
  `G:\Jarvis\.release-evidence\phase-4\rc2-e0303215-20260804\SUMMARY.md`.

## Recording a PASS

Change a row to `PASS` only after the command or procedure has actually completed. Its evidence cell
must use this minimum machine-readable form:

```text
observed=2026-07-17T12:34:56+08:00; commit=<40-hex>; evidence=G:\Jarvis\.release-evidence\phase-4\<run-id>\<report>
```

Physical or live-network rows also require:

```text
artifact=G:\Jarvis\.worktrees\jarvis-all-day-runtime\app\dist\<artifact>; consent=<recorded-local-reference>
```

Do not put API keys, audio, transcripts, embeddings, real speaker names, raw provider responses, or
private fixture paths in the report. Store only hashes, anonymous fixture IDs, safe request IDs,
aggregate metrics, timestamps, device/runtime versions, process exit codes, and bounded resource
measurements.

## Gate-specific evidence

### Automated regression and virtual endurance

The full regression report must record main and renderer pass/fail/skip counts. Platform capability
skips remain skips and must be named. Both endurance commands advance deterministic clocks by exactly
three virtual hours; neither result proves three hours of wall-clock operation, physical audio
capture, real CUDA inference, or live MiniMax availability.

The capture endurance report must include bounded queue/handle/helper peaks, committed chunks/jobs,
orphan/corrupt counts, interruption recovery, FLAC authority recovery, migration recovery, and
seven-day retention behavior. The resource endurance report must include heavy-job concurrency,
preview coalescing, GPU-pressure deferral, CUDA-failure fallback simulation, and final queue/resource
drain.

### Package, ABI, offline, and restart

Package acceptance requires the final artifact name, SHA-256, commit, build exit code, package-safety
result, and the builder's source Node ABI plus packaged Electron ABI checks. A fake or fixture asar is
not the final packaged ABI result.

Run packaged offline and restart acceptance through
`npm run smoke:win:unpacked -- --runtime-root G:\Jarvis\.runtime-cache\packaged-smoke`. The harness
must create a fresh isolated profile and keep that profile, logs, sentinels, and reports under the
runtime root. It uses
process-scoped unreachable proxy variables, never system-wide proxy changes. Record startup
readiness, process exit, sanitized report path, artifact name, artifact SHA-256, and exact Git
commit. The first process creates and completes one no-audio smoke session through the public
renderer API, then exits cleanly. The second process reopens the same fresh profile and verifies that
the same terminal session exists exactly once. This gate does not claim legacy migration, transcript,
summary, people, topic, todo, memory, analysis, or audio-retention coverage; full legacy and
migration acceptance remains blocked on `LEGACY_FIXTURE`.

### Legacy fixture

The fixture must be copied into a disposable G-drive profile; never mutate the source. Record fixture
version and SHA-256, source/target counts, provenance and evidence counts, injected interruption,
restart, second-open idempotence, and the absence of duplicate imports. Synthetic unit schemas do not
replace this gate. Until a real-shaped fixture is available, this row remains `BLOCKED`.

### Real microphone, CUDA, CAM++, and MiniMax

Real microphone UAT requires explicit recording consent, the physical Windows device label, capture
mode, start/stop indicators, two controlled disconnect/reconnect cycles, virtual-device avoidance,
same-session recovery, and wall-clock CPU/RSS/handle/log observations. The detailed dual-track
procedure remains in `docs/testing/jarvis-dual-track-hardware-acceptance.md`.

CUDA UAT must record GPU model/UUID, driver, runtime and model hashes, actual backend `cuda`, real
inference latency, GPU-pressure deferral, and verified CPU fallback. A simulated CUDA crash or a
successful CPU fallback does not pass this row.

CAM++ UAT is local-only and consent-gated. It must use the private manifest rules in
`docs/TESTING.md`, record only the fixture manifest SHA-256 and anonymous aggregate metrics, and meet
the locked precision/false-positive thresholds. A skipped private-fixture test is not a pass.

MiniMax live UAT must remain within the configured hard monthly budget. Record only safe request IDs,
model, timestamps, public status transitions, usage/cost aggregates, and sanitized evidence paths.
Verify session analysis, daily digest, offline retry, budget block, restart persistence, and key
clear. Never echo the subscription key or raw prompt/response.

## Machine check

From `app/`:

```powershell
Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app
$env:TEMP='G:\Jarvis\.runtime-cache\temp'
$env:TMP=$env:TEMP
node --test test/jarvis/ReleaseAcceptanceMatrix.test.js
```

This check validates gate coverage, exact status vocabulary, G-drive scoping, blocker wording, and
the minimum evidence required before physical or live-network rows can be marked `PASS`.
