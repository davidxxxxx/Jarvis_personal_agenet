# Jarvis Phase 4 release acceptance

This is the canonical release-candidate matrix for Phase 4. It is intentionally conservative:
results from an older commit or from a worktree before the final change do not automatically carry
forward. The current snapshot is a dirty working tree, so it is not yet a release sign-off. Record
the exact final commit only when a row is changed to `PASS`.

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

| Gate ID             | Gate                                                                                            | Status    | Evidence or blocker                                                                                                                                   | Required G-drive command or procedure                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTO_REGRESSION     | Full Jarvis main and renderer regression                                                        | `NOT RUN` | Not executed: rerun after the final Phase 4 diff is frozen.                                                                                           | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; $env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'; npm run test:jarvis`                                                                                                                                     |
| STATIC_GATES        | Typecheck, lint, i18n, renderer build, and patch hygiene                                        | `NOT RUN` | Not executed: the final combined Task 7/8 diff is still changing.                                                                                     | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; $env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'; npm run typecheck; npm run lint; npm run i18n:check; npm run build:renderer; Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime; git diff --check` |
| VIRTUAL_CAPTURE_3H  | Three-hour deterministic capture, FLAC, migration, and retention endurance                      | `NOT RUN` | Not executed: prior historical runs do not certify the final candidate.                                                                               | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run test:jarvis:capture-soak`                                                                                                                                                                              |
| VIRTUAL_RESOURCE_3H | Three-hour deterministic CPU, GPU-pressure, preview, and queue governance endurance             | `NOT RUN` | Not executed: prior historical runs do not certify the final candidate.                                                                               | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run test:jarvis:resource-soak`                                                                                                                                                                             |
| WINDOWS_PACKAGE     | Unsigned Windows package and package-safety scan                                                | `NOT RUN` | Not executed: no final Phase 4 Windows artifact has been produced.                                                                                    | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; $env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'; npm run build:win:unsigned`                                                                                                                              |
| NATIVE_ABI          | Source Node ABI restore and packaged Electron ABI/bindings smoke                                | `NOT RUN` | Not executed: run the native tests and the package builder's source/package ABI verification on the final artifact.                                   | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; node --test test/jarvis/NativeAbiPackaging.test.js test/jarvis/PackagedRuntimeDependencies.test.js; npm run build:win:unsigned`                                                                                |
| PACKAGED_OFFLINE    | Unpacked executable launch with process-scoped offline transport                                | `BLOCKED` | blocker=final unpacked Windows artifact is not built and the automated offline launch harness has not run.                                            | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run smoke:win:unpacked -- --runtime-root G:\Jarvis\.runtime-cache\packaged-smoke`                                                                                                                          |
| PACKAGED_RESTART    | Fresh isolated-profile real session persistence, reopen, and no-duplicate smoke                 | `BLOCKED` | blocker=final unpacked Windows artifact is not built and the automated fresh-profile restart harness has not run.                                     | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run smoke:win:unpacked -- --runtime-root G:\Jarvis\.runtime-cache\packaged-smoke`                                                                                                                          |
| LEGACY_FIXTURE      | Real-shaped copied legacy database migration, interruption, restart, and idempotence            | `BLOCKED` | blocker=no version-pinned real-shaped legacy SQLite fixture exists; full legacy and migration acceptance remains blocked on this gate.                | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime; rg --files -g '*legacy*.sqlite' -g '*legacy*.sqlite3' -g '*legacy*.db' app\test G:\Jarvis\.release-fixtures`                                                                                                                                                                      |
| REAL_MIC            | Physical microphone selection, dual capture, interruption recovery, and wall-clock resource UAT | `BLOCKED` | blocker=requires an installed final artifact, an identified physical microphone, and coordinated tester consent for recording and disconnect actions. | `& 'G:\Jarvis\.worktrees\jarvis-all-day-runtime\app\dist\win-unpacked\Jarvis Memory.exe' --user-data-dir='G:\Jarvis\.release-evidence\phase-4\<run-id>\profiles\real-mic'`                                                                                                                                                                   |
| CUDA_WHISPER        | Verified real CUDA Whisper inference, fallback, and GPU-pressure UAT                            | `BLOCKED` | blocker=the final artifact has no recorded verified CUDA runtime/model installation and no real GPU inference evidence.                               | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:TEMP='G:\Jarvis\.runtime-cache\temp'; $env:TMP=$env:TEMP; npm run jarvis:cuda:self-test`                                                                                                                                                                                 |
| CAMPP_IDENTITY      | Consented private CAM++ enrollment and persistent speaker-identity quality UAT                  | `BLOCKED` | blocker=no consented private speaker fixture directory and no candidate-specific aggregate CAM++ quality report are available.                        | `Set-Location G:\Jarvis\.worktrees\jarvis-all-day-runtime\app; $env:JARVIS_SPEAKER_EVAL_DIR='G:\Jarvis\.private\speaker-eval'; npm run test:speaker-eval`                                                                                                                                                                                    |
| MINIMAX_LIVE        | Live MiniMax analysis and daily-digest network UAT under the hard monthly budget                | `BLOCKED` | blocker=final unpacked artifact is not built and no live provider request or billable usage is claimed for this candidate.                            | `& 'G:\Jarvis\.worktrees\jarvis-all-day-runtime\app\dist\win-unpacked\Jarvis Memory.exe' --user-data-dir='G:\Jarvis\.release-evidence\phase-4\<run-id>\profiles\minimax-live'`                                                                                                                                                               |

<!-- RELEASE_ACCEPTANCE_MATRIX_END -->

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
