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

## Initial verification (superseded by independent-review repairs below)

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

## Independent-review repair

The independent review identified authority-race, playback, temporary-evidence, recovery, migration-identity, path-hardening, parser, and observability gaps. The repair keeps database authority plus verified hashes as the only basis for promotion, rollback, and cleanup.

### Repair RED evidence

- Promotion/retention race and expired rename-crash startup cleanup: focused command selected 2 tests; 0 passed / 2 failed because the non-authoritative final FLAC remained on disk.
- FLAC playback IPC and stale verified-WAV lease cleanup: focused command selected 2 tests; 0 passed / 2 failed because IPC returned `null` instead of the reader's WAV and no startup cleanup API existed.
- Missing/corrupt FLAC authority recovery: focused command selected 3 tests; 0 passed / 3 failed because authority stayed FLAC and completed jobs lacked a diagnostic failure.
- Completed replay ordering: after reverting the ordering fix, focused command selected 2 tests; 0 passed / 2 failed with `audio_expired` and `audio_deleted`; restoring the immediate completed-job return made both pass.
- v7 identity, deterministic deduplication, and eligible backfill: focused command selected 3 tests; 0 passed / 3 failed because different hashes created duplicate compression identities, duplicate v6 jobs survived, and no v7 backfill ran.
- Recovery error callback, authoritative hard link, and strict WAV bounds: focused command selected 4 tests; the three new missing behaviors failed as expected. The initial root-junction run path already rejected the junction, so the test was refined to the vulnerable cleanup path, where it then failed with `Missing expected rejection` before the root validation fix.
- Reader authority hard-link protection: focused command selected 1 test; it failed because decoding proceeded through a two-link file.
- Tombstoned rename-crash cleanup: focused command selected 1 test; it failed because the final FLAC remained after the row lost its original path.
- Startup and retention stale-lease hooks: focused command selected 2 tests; 0 passed / 2 failed because neither lifecycle invoked the shared reader cleanup.

### Repair GREEN evidence

- Every RED group above passed after its minimal repair: 2/2, 2/2, 3/3, 2/2, 3/3, 4/4, 1/1, 1/1, and 2/2 respectively.
- Fresh focused regression:
  `node --test test/jarvis/FlacCompressionWorker.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisService.test.js test/jarvis/JarvisRecovery.test.js test/jarvis/DualTrackRecovery.test.js test/jarvis/RetentionCleaner.test.js test/jarvis/contracts.test.js`
  -- 173 passed, 0 failed, 0 skipped.
- The real bundled-FFmpeg lossless round trip ran and passed; it was not skipped.

### Repair behavior

- Promotion now revalidates live committed WAV authority and retention deadline inside the transaction. A rejected promotion removes only the exact renamed file whose encoded hash is still known and which never became database authority.
- Tombstones retain a private cleanup locator and prior format while exposing the public tombstone path. Startup and online retention remove only database-derived, single-link regular artifacts that can be tied to the row; the sole authoritative copy is never guessed from an extension.
- The shared `AudioEvidenceReader` now serves `jarvis:audio:read`, so both WAV and FLAC authority produce a verified playable WAV for the renderer's existing `audio/wav` consumer.
- `withVerifiedWav` remains the format-independent lease API. Its leases live in the controlled `.evidence-tmp` direct child with strict names and permissions, while FLAC decode uses bounded in-memory FFmpeg output. Startup and retention remove only stale leases proven by chunk id, PCM hash, safe file identity, and decoded content.
- Invalid FLAC authority rolls back transactionally to a verified sibling WAV and restores the compression job to retry. If neither file verifies, the FLAC row is preserved with `flac_authority_invalid` diagnostic state.
- Compression identity is now exactly `compress_chunk + chunk_id + encoder_version`. Migration v7 deterministically keeps the most trusted job, merges attempt/error diagnostics, leaves transcription jobs untouched, and backfills only live committed WAV rows with complete metadata.
- Recordings roots are fixed and revalidated against junction/symlink replacement. Authority and cleanup files must be regular and single-link before reads, promotion, or deletion. The WAV parser rejects inconsistent RIFF sizes, truncated chunks, and missing padding.
- Startup sibling failures call `onRecoveryError({ chunkId, jobId, code })` and continue; the callback contains no path, audio, device, or transcript data.

### Phase boundary

This task does not create a transcription runner. The committed-chunk transcription consumer approved for Phase 2 Task 2 must consume audio through `withVerifiedWav`; the lease API and cross-authority test are ready for that integration.

### Repair final verification

- `npm run test:jarvis` -- exit 0 in 15.6 seconds. The complete main-process Node suite passed, then the renderer suite reported 18 files / 194 tests passed.
- `npm run typecheck` -- exit 0.
- `npm run lint` -- exit 0; only the existing module-type performance warning was emitted.
- `npm run i18n:check` -- exit 0.
- `node --check` on all 12 changed JavaScript source and test files -- exit 0.
- `git diff --check` -- exit 0; only Git LF-to-CRLF working-copy notices were emitted.
- Diff credential scan -- PASS without printing matched content.
- Audio artifact scan -- PASS; no WAV, FLAC, or partial evidence is tracked or left untracked.
