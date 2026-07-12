# Phase 1 Task 10 — Verified FLAC evidence compression

## Status

Implemented and verified. Committed WAV evidence is compressed asynchronously with bundled FFmpeg, decoded back to canonical PCM for integrity verification, and promoted to authoritative FLAC only in a durable database transaction. Startup recovery is database-authority-driven and handles every crash window without allowing one bad sibling to stop recovery of the rest.

## Design and scope

- Added `AudioEvidenceReader` with legacy WAV support, verified PCM reads, safe temporary WAV leases for transcription, and bundled-FFmpeg FLAC decoding.
- Added `FlacCompressionWorker` with no-shell FFmpeg encoding, fsynced partial output, lossless PCM/rate/channel/duration verification, atomic rename, transactional authority promotion, and post-commit WAV cleanup.
- Added schema version 6 evidence metadata and an idempotent `compress_chunk` migration backfill for live WAV rows.
- Kept `sha256` as the single canonical PCM hash; `pcm_sha256` is a compatibility alias, while `file_sha256` identifies the authoritative encoded file.
- Added independent durable compression jobs alongside transcription jobs and wired background processing only after chunk commit returns.
- Added startup reconciliation for valid/invalid partials, conflicting double-file states, completed database authority switches, tombstones, expiry, and sibling failures.
- Hardened recording-root containment against traversal, junction/symlink escape, non-regular targets, and pre-existing partial hard links.

## TDD evidence

### RED

- Initial worker test: `node --test test/jarvis/FlacCompressionWorker.test.js` — exit 1 because `AudioEvidenceReader` did not exist.
- Expanded worker/recovery suite: 17 tests, 9 passed / 8 failed before replay, recovery, reader APIs, and expiry behavior were implemented.
- Service/default integration suite: 21 tests, 17 passed / 4 failed before production defaults and asynchronous service wiring.
- Migration suite: 6 tests, 5 passed / 1 failed before legacy compression-job backfill.
- Crash-before-rename preservation and startup sibling-isolation tests were each observed failing before their focused fixes.

### GREEN

- Fresh focused regression:
  `node --test test/jarvis/FlacCompressionWorker.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisService.test.js test/jarvis/JarvisRecovery.test.js test/jarvis/DualTrackRecovery.test.js test/jarvis/RetentionCleaner.test.js`
  — 138 tests passed, 0 failed, 0 skipped.
- Real codec test: `uses bundled FFmpeg for a real lossless FLAC round trip` passed without a skip.
- Bundled runtime was repaired with `npm rebuild ffmpeg-static`; `ffmpeg.exe -version` succeeded (FFmpeg 6.1.1). No tracked package manifest or lockfile changed.

## Final verification

- `npm run test:jarvis` — exit 0 in 15.4 s. The main-process Node suite passed and the chained renderer suite reported 18 files / 194 tests passed.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0; only the existing module-type performance warning was emitted.
- `npm run i18n:check` — exit 0.
- `node --check` on all changed production modules and the new worker test — exit 0.
- `git diff --check` — exit 0; only Git's LF-to-CRLF working-copy notices were emitted.
- Diff credential scan — PASS; no credential-like content printed.
- Audio artifact scan — PASS; no `.wav`, `.flac`, or `.partial` evidence is tracked or left untracked.

## Requirement coverage

- Authority switch after decoded PCM verification: covered by success and verification-failure tests.
- Independent durable jobs and idempotency: covered for coexistence, replay, and migration backfill.
- Crash consistency: covered before rename, after rename, and after database promotion/before WAV deletion.
- Startup recovery: covered for valid/invalid partial and temporary files, conflicting double files, authoritative FLAC cleanup, and sibling failure isolation.
- Transcription compatibility: covered by verified temporary WAV lease surviving an authority switch and legacy `sha256` rows.
- Retention safety: covered for tombstoned and exactly-expired chunks.
- Metadata verification: covered for sample rate, channel count, duration/sample count, PCM hash, and encoded file hash.
- Path safety: covered for outside-root paths, junction escape, and hard-linked partial output.

## Concerns

- Compression failures intentionally leave the durable job pending for later service or startup retry; they do not invalidate the authoritative WAV.
- Background compression is contained and recoverable but is not synchronously drained by shutdown; crash consistency and startup recovery are the safety boundary.
