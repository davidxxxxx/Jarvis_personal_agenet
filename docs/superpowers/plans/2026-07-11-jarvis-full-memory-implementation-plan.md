# Jarvis Full Memory Implementation Plan

> Execute this plan test-first in an isolated git worktree. Preserve the existing user database and recordings.

## Objective

Deliver the approved microphone selector/fallback plus working Today, People, Topics, Todos, and Memory pages backed by persistent local data and text-only MiniMax analysis.

## Task 1: Persist derived memory data

Files:

- Modify `app/src/jarvis/main/JarvisRepository.js`
- Modify `app/src/jarvis/types.ts`
- Test `app/test/jarvis/JarvisRepository.test.js`

Steps:

1. Add failing repository tests for idempotent migrations, analysis-run lifecycle, summaries, topics, todos, memories/evidence, session detail, local search, and preservation of existing sessions.
2. Add schema and prepared statements with explicit validation and transactions.
3. Expose repository query/mutation methods used by the UI and analysis merger.
4. Run `npm run test:main -- --test-name-pattern=JarvisRepository` from `app`.
5. Commit `feat(jarvis): persist derived memory data`.

## Task 2: Validate and merge AI analysis

Files:

- Create `app/src/jarvis/main/JarvisAnalysisSchema.js`
- Create `app/src/jarvis/main/MemoryMerger.js`
- Test `app/test/jarvis/JarvisAnalysisSchema.test.js`
- Test `app/test/jarvis/MemoryMerger.test.js`

Steps:

1. Write failing tests for valid payloads and rejection of unknown evidence, unsupported types, invalid dates/confidence, empty fields, oversized output, and extra keys.
2. Implement a strict validator and normalization helpers.
3. Write failing merger tests for idempotent retries, exact topic/todo merge, evidence insertion, no AI completion, and transaction rollback.
4. Implement the minimal transactional merger.
5. Run focused main tests and commit `feat(jarvis): validate and merge AI analysis`.

## Task 3: MiniMax client, secure key, and scheduler

Files:

- Create `app/src/jarvis/main/MiniMaxAnalysisClient.js`
- Create `app/src/jarvis/main/AnalysisScheduler.js`
- Modify `app/src/helpers/environment.js`
- Modify `app/main.js`
- Test `app/test/jarvis/MiniMaxAnalysisClient.test.js`
- Test `app/test/jarvis/AnalysisScheduler.test.js`
- Modify security tests under `app/test/jarvis`

Steps:

1. Add failing client tests using a mock fetch for endpoint/auth, forced tool schema, output parsing, redacted errors, timeout, 401/429/5xx classification, and model fallback.
2. Implement direct main-process HTTP calls; do not log request bodies or headers.
3. Add dedicated encrypted MiniMax key save/configured methods without exposing key to renderer.
4. Add failing scheduler tests for ten-minute windows, final analysis, one in-flight request, idempotent hashes, retry/backoff, restart recovery, and budget/quota pause.
5. Implement the scheduler and wire it to segment persistence and session finish.
6. Run focused tests and commit `feat(jarvis): add text-only MiniMax analysis`.

## Task 4: IPC query surface

Files:

- Modify `app/src/jarvis/shared/contracts.js`
- Modify `app/src/jarvis/main/registerJarvisIpc.js`
- Modify `app/preload.js`
- Modify `app/src/types/electron.ts`
- Test `app/test/jarvis/contracts.test.js`

Steps:

1. Add failing contract tests for session detail/search, people detail, topics, todos, summary/insights, todo status, topic rename, analysis retry, and MiniMax configuration.
2. Implement narrow validated handlers and preload methods.
3. Confirm the renderer cannot read the MiniMax key or arbitrary audio paths.
4. Run contract/security tests and commit `feat(jarvis): expose memory query APIs`.

## Task 5: Memory history and audio access

Files:

- Create `app/src/jarvis/renderer/MemoryView.tsx`
- Create `app/src/jarvis/renderer/SessionDetail.tsx`
- Create `app/src/jarvis/renderer/AudioChunkPlayer.tsx`
- Modify `app/src/jarvis/renderer/jarvisStore.ts`
- Modify `app/src/jarvis/renderer/JarvisShell.tsx`
- Add renderer component tests

Steps:

1. Write failing tests that seven persisted sessions render, grouping/search work, a detail loads transcript/summary/audio metadata, expired audio is unavailable, and errors do not erase prior data.
2. Implement loading/empty/error states and session navigation.
3. Add safe main-process audio reads using opaque audio chunk ids; never expose arbitrary filesystem reads.
4. Run renderer tests and commit `feat(jarvis): add searchable memory history`.

## Task 6: People, Topics, and Todos

Files:

- Create `app/src/jarvis/renderer/PeopleView.tsx`
- Create `app/src/jarvis/renderer/TopicsView.tsx`
- Create `app/src/jarvis/renderer/TodosView.tsx`
- Modify `app/src/jarvis/renderer/JarvisShell.tsx`
- Add renderer component tests

Steps:

1. Write failing tests for each list/detail view, source navigation, speaker rename/self display, topic rename, todo complete/reopen, and empty/error states.
2. Implement the three views using shared cards and query helpers.
3. Ensure every derived item displays evidence/source navigation.
4. Run renderer tests and commit `feat(jarvis): enable people topics and todos`.

## Task 7: Today insights and analysis controls

Files:

- Create `app/src/jarvis/renderer/AnalysisStatus.tsx`
- Modify `app/src/jarvis/renderer/TodayView.tsx`
- Modify `app/src/jarvis/renderer/useJarvisRecording.ts`
- Modify relevant renderer tests

Steps:

1. Write failing tests for current summary/topic/todo/advice, ten-minute refresh, final refresh, recent sessions, offline/quota/retry states, and non-blocking recording.
2. Wire the scheduler notifications/query refresh into Today.
3. Replace placeholder insight cards with persisted data.
4. Run focused tests and commit `feat(jarvis): show live memory insights`.

## Task 8: Microphone selector and same-session fallback

Files:

- Create `app/src/jarvis/renderer/JarvisMicrophoneSelector.tsx`
- Modify `app/src/jarvis/renderer/RecordingControls.tsx`
- Modify `app/src/stores/meetingRecordingStore.ts`
- Modify `app/src/jarvis/renderer/useJarvisRecording.ts`
- Add/update main and renderer tests named in the approved microphone design

Steps:

1. Write selector and capture fallback failures first.
2. Implement persistent exact-device selection and system-default initial fallback.
3. Implement guarded same-session pipeline replacement on track `ended`.
4. Display actual active device and fallback notice.
5. Run focused tests and commit `fix(jarvis): recover from microphone disconnects`.

## Task 9: Localization and quality gates

Files:

- Modify all supported `app/src/locales/*/translation.json`
- Modify affected renderer tests and product documentation

Steps:

1. Add translation keys in every locale, using English fallback text outside zh-CN where necessary.
2. Run `npm run i18n:check`, `npm run typecheck`, `npm run lint`, and `npm run format:check`.
3. Run `npm run test:main` and `npm run test:renderer`.
4. Run transcript/key log scans and verify the existing database still reports seven sessions.
5. Commit `test(jarvis): verify full memory experience`.

## Task 10: Package and Windows acceptance

Steps:

1. Build renderer and unsigned Windows artifacts using the repository's existing safe packaging path.
2. Install/run the new build against the existing user-data directory only after a database backup.
3. Verify Shure MV7 or Arctis Nova Pro selection, start/pause/resume/finish, fallback behavior, and non-silent WAV output.
4. Verify all five navigation views, historic sessions, transcript/audio detail, MiniMax text-only request, final summary, todo completion, and seven-day audio status.
5. Copy final user-facing installers to the configured Codex outputs directory and report exact paths plus test evidence.
