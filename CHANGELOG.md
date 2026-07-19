# Jarvis Memory changelog

All user-visible Jarvis changes are recorded here. Versions follow Semantic Versioning and use
Jarvis-prefixed Git tags so they cannot be confused with upstream OpenWhispr releases.

## Unreleased

### Planned for 0.2.0

- Evidence-gated Todos, suggestions, and local personalization.
- Progressive Finish & Summarize session page and a compact home Action Center.

## 0.2.0-alpha.2 - 2026-07-20

Phase 2 adds private local speaker identity and evidence-gated activity classification.

### Added

- Guided SELF enrollment using three ten-second physical-microphone samples.
- Two isolated 192-dimensional local speaker models: CAM++ Chinese for primary matching and
  ERes2NetV2 Chinese for idle-time review.
- Encrypted local storage for enrollment, cluster, and confirmed-person voice embeddings.
- Cross-session anonymous people linkage that requires both models to agree; names remain
  user-confirmed only.
- Strict speaker-learning gates: SELF learns only from exact physical-microphone evidence, while
  mixed system audio, overlap, echo, and unsafe application evidence never update SELF.
- Eight-category local activity classification with conservative 80%/55% decision thresholds.
- Optional MiniMax semantic review using normalized application names, anonymous speaker labels,
  transcript text, and non-biometric statistics only.
- Durable schema v34 history for dual-model evidence and activity classifications.
- A safe renderer IPC projection for classifications that excludes paths, titles, hashes, names,
  raw audio, and voice embeddings.

### Changed

- Activity classification shares the existing durable MiniMax hard-budget ledger.
- Finished sessions schedule classification in the background without blocking safe audio
  finalization.
- The main-process test command now excludes renderer-only TypeScript suites and helper fixtures.

### Version governance

- Added a local and GitHub version gate that requires `package.json`, `package-lock.json`, the
  Jarvis changelog, and `jarvis-v*` Git tags to agree.
- Added automatic immutable draft GitHub Releases for verified Jarvis tags.

### Verification

- Main-process, database, privacy, native-helper, and three-hour virtual soak tests: 1,922 passed,
  0 failed, 3 skipped by design.
- Renderer tests: 329 passed, 0 failed.
- ESLint, TypeScript typecheck, locale-key consistency, and production renderer build passed.
- App version: `0.2.0-alpha.2`; database target: `v34`.

### Conservative release state

- Automatic long-term speaker association remains candidate-only until a private held-out
  evaluation demonstrates at least 95% precision and no more than 5% false-positive rate for both
  model spaces. Manual confirmation and naming are fully available.

## 0.2.0-alpha.1 - 2026-07-20

Phase 1 establishes the application-source and durable evidence foundation for the personal agent.

### Added

- Native Windows audio-session discovery and process-specific loopback capture.
- A bounded dynamic application-audio pool: four tracks by default, configurable from one to
  eight, reduced to two during full-screen games.
- Conservative mixed-system fallback with explicit degraded intervals and recovery points; unknown
  source is retained without guessing an application.
- Durable application tracks and attribution intervals in database schema v32.
- Cross-track duplicate lineage, application-source public projections, coverage reporting, and
  database-enforced evidence direction in schema v33.
- Resource settings for enabling app-aware audio and choosing the simultaneous track limit.

### Fixed

- Reinstalled analysis-manifest immutability triggers after the v33 transcript-table rebuild.
- Required a fresh migration destination when a live SQLite source changes after an interrupted
  data-directory migration.
- Kept resource-priority controls usable when app-audio discovery is temporarily unavailable or an
  older main process is still running.
- Prevented mixed-system fallback evidence from persisting a guessed application key.

### Verification

- Main-process, database, native-helper, migration, and three-hour virtual soak tests:
  1,860 passed, 0 failed, 3 skipped by design.
- Renderer tests: 329 passed, 0 failed.
- TypeScript typecheck, locale-key consistency, and production renderer build passed.
- App version: `0.2.0-alpha.1`; database target: `v33`.
- Git commit and GitHub release: pending creation of a user-owned `origin`; never push this branch
  to the upstream `openwhispr` remote.

## 0.1.0 - 2026-07-17

- Established the Windows desktop Jarvis MVP baseline.
- Added durable microphone/system recording, final transcription, memory, MiniMax analysis,
  resource governance, CUDA verification, and Phase 4 release acceptance evidence.
