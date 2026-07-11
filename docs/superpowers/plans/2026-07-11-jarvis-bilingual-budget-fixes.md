# Jarvis Bilingual Accuracy, Budget Guard, and Desktop Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows Jarvis MVP draggable, improve local Chinese-English transcription, expose persistent self-voice enrollment status, and add opt-in cloud correction protected by a $5–$10 monthly application hard stop.

**Architecture:** Keep microphone capture, diarization, and the first transcript local. Add small pure modules for windowed transcript quality and cloud cost policy, persist usage through `JarvisRepository`, and inject an `OpenAiCorrectionService` into the existing meeting IPC pipeline. The renderer receives local finals immediately and optional versioned correction events later.

**Tech Stack:** Electron 41, React 19, TypeScript 6, Node.js 24, `better-sqlite3`, Vitest, Node test runner, local whisper.cpp, OpenAI Audio Transcriptions API.

## Global Constraints

- Target Windows 10/11 x64.
- Cloud correction defaults off and only uploads low-confidence speech after explicit consent.
- Default monthly limit is 5.00 USD; allowed range is 5.00–10.00 USD; month boundaries use UTC.
- Requests are serialized and reserve 100,000 micro-USD before network I/O.
- Unknown usage or pricing pauses cloud correction instead of treating the request as free.
- MiniMax remains text-only; enrollment audio and embeddings never leave the device.
- Jarvis remains functional in local-only mode when no OpenAI key is configured, the network fails, or the budget is exhausted.
- Raw API keys, full audio, and transcript text must not be written to the usage ledger or debug logs.

---

## File Structure

- Create `app/src/jarvis/renderer/JarvisTitleBar.tsx`: isolated draggable titlebar using existing `WindowControls`.
- Create `app/src/jarvis/main/transcriptionQuality.js`: pure bilingual prompt, overlap merge, and suspicious-text classification.
- Create `app/src/jarvis/main/CloudBudgetGuard.js`: serialized reservation/settlement policy and fixed pricing snapshot.
- Create `app/src/jarvis/main/OpenAiCorrectionService.js`: opt-in OpenAI multipart request and usage settlement.
- Create `app/src/jarvis/renderer/TranscriptionQualityCard.tsx`: cloud consent, key state, model state, budget status, and limit control.
- Modify `app/src/jarvis/main/JarvisRepository.js`: cloud settings/usage/revision schema and transactional methods.
- Modify `app/src/jarvis/main/VoiceEnrollmentService.js`: metadata-only `getStatus()`.
- Modify `app/src/jarvis/shared/contracts.js`, `app/src/jarvis/main/registerJarvisIpc.js`, `app/preload.js`, `app/src/types/electron.ts`, and `app/src/jarvis/types.ts`: narrow typed IPC contracts.
- Modify `app/src/jarvis/renderer/JarvisShell.tsx`, `TodayView.tsx`, and `VoiceEnrollment.tsx`: titlebar, budget card, and persistent self-voice state.
- Modify `app/src/jarvis/renderer/useJarvisRecording.ts`, `app/src/stores/meetingRecordingStore.ts`, and `app/src/helpers/ipcHandlers.js`: Jarvis turbo default, 12-second stable windows, 2-second overlap, bilingual prompt, and correction events.
- Modify `app/main.js`: construct and inject the correction service.
- Add focused Node and Vitest tests beside the existing Jarvis suites.

---

### Task 1: Draggable Jarvis titlebar

**Files:**
- Create: `app/src/jarvis/renderer/JarvisTitleBar.tsx`
- Modify: `app/src/jarvis/renderer/JarvisShell.tsx`
- Modify: `app/src/jarvis/renderer/__tests__/JarvisShell.test.tsx`

**Interfaces:**
- Consumes: existing `WindowControls` component.
- Produces: `JarvisTitleBar(): JSX.Element` and DOM hooks `data-testid="jarvis-drag-region"`, `data-testid="jarvis-window-controls"`.

- [ ] **Step 1: Write the failing renderer test**

Add a mock for `WindowControls` and assert the titlebar exists outside the interactive content:

```tsx
vi.mock("../../../components/WindowControls", () => ({
  default: () => <div data-testid="jarvis-window-controls">controls</div>,
}));

it("provides a draggable titlebar without making window controls draggable", () => {
  render(<JarvisShell />);
  expect(screen.getByTestId("jarvis-drag-region")).toHaveStyle({ WebkitAppRegion: "drag" });
  expect(screen.getByTestId("jarvis-window-controls").parentElement).toHaveStyle({
    WebkitAppRegion: "no-drag",
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/JarvisShell.test.tsx`

Expected: FAIL because `jarvis-drag-region` does not exist.

- [ ] **Step 3: Implement the isolated titlebar**

`JarvisTitleBar.tsx` must render a 40 px row with the following style boundary:

```tsx
<header data-testid="jarvis-drag-region" style={{ WebkitAppRegion: "drag" }}>
  <span>Jarvis Memory</span>
  <div data-testid="jarvis-window-controls-slot" style={{ WebkitAppRegion: "no-drag" }}>
    <WindowControls />
  </div>
</header>
```

Change `JarvisShell` to a two-row root (`40px minmax(0,1fr)`) and place its existing navigation/main/aside grid in row two.

- [ ] **Step 4: Run focused and full renderer tests**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/JarvisShell.test.tsx`

Expected: all `JarvisShell` tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add app/src/jarvis/renderer/JarvisTitleBar.tsx app/src/jarvis/renderer/JarvisShell.tsx app/src/jarvis/renderer/__tests__/JarvisShell.test.tsx
git commit -m "fix: make Jarvis window draggable"
```

### Task 2: Persistent self-voice enrollment status

**Files:**
- Modify: `app/src/jarvis/main/VoiceEnrollmentService.js`
- Modify: `app/src/jarvis/shared/contracts.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/jarvis/renderer/VoiceEnrollment.tsx`
- Modify: `app/test/jarvis/VoiceEnrollmentService.test.js`
- Modify: `app/test/jarvis/contracts.test.js`
- Modify: `app/test/jarvis/PreloadVoiceEnrollment.test.js`
- Modify: `app/src/jarvis/renderer/__tests__/VoiceEnrollment.test.tsx`

**Interfaces:**
- Produces: `VoiceEnrollmentService.getStatus(): { enrolled: boolean, profileId: number | null, sampleCount: number, updatedAt: string | null }`.
- Produces: `CHANNELS.getVoiceEnrollmentStatus = "jarvis:voice-enrollment:status"`.
- Produces: `window.electronAPI.jarvis.getVoiceEnrollmentStatus()` returning metadata only.

- [ ] **Step 1: Write failing service and contract tests**

Use a database manager stub with `getSpeakerProfiles()` and assert profile `id === -1` maps to enrolled status without an `embedding` field:

```js
assert.deepEqual(service.getStatus(), {
  enrolled: true,
  profileId: -1,
  sampleCount: 3,
  updatedAt: "2026-07-11 03:00:00",
});
```

Add IPC and preload assertions for `jarvis:voice-enrollment:status`.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && node --test test/jarvis/VoiceEnrollmentService.test.js test/jarvis/contracts.test.js test/jarvis/PreloadVoiceEnrollment.test.js`

Expected: FAIL because status API is absent.

- [ ] **Step 3: Implement metadata-only status**

Add constructor validation for `databaseManager.getSpeakerProfiles`, then:

```js
getStatus() {
  const profile = this.databaseManager
    .getSpeakerProfiles(false)
    .find((candidate) => candidate.id === SELF_VOICE_PROFILE_ID);
  return profile
    ? { enrolled: true, profileId: profile.id, sampleCount: profile.sample_count, updatedAt: profile.updated_at }
    : { enrolled: false, profileId: null, sampleCount: 0, updatedAt: null };
}
```

Register the new channel and expose it through the existing `jarvis` preload namespace.

- [ ] **Step 4: Make `VoiceEnrollment` load and refresh status**

On mount call `getVoiceEnrollmentStatus()`. Display `已绑定` plus the last calibration time when enrolled, `未绑定` otherwise, and relabel the start button as `重新校准` when enrolled. After successful save, refresh status instead of relying only on the ephemeral `saved` state.

- [ ] **Step 5: Run Node and renderer tests**

Run: `cd app && node --test test/jarvis/VoiceEnrollmentService.test.js test/jarvis/contracts.test.js test/jarvis/PreloadVoiceEnrollment.test.js && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/VoiceEnrollment.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add app/src/jarvis/main/VoiceEnrollmentService.js app/src/jarvis/shared/contracts.js app/src/jarvis/main/registerJarvisIpc.js app/preload.js app/src/types/electron.ts app/src/jarvis/types.ts app/src/jarvis/renderer/VoiceEnrollment.tsx app/test/jarvis/VoiceEnrollmentService.test.js app/test/jarvis/contracts.test.js app/test/jarvis/PreloadVoiceEnrollment.test.js app/src/jarvis/renderer/__tests__/VoiceEnrollment.test.tsx
git commit -m "feat: show persistent self voice status"
```

### Task 3: Local bilingual transcription windows and turbo default

**Files:**
- Create: `app/src/jarvis/main/transcriptionQuality.js`
- Create: `app/test/jarvis/transcriptionQuality.test.js`
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts`
- Modify: `app/src/stores/meetingRecordingStore.ts`
- Modify: `app/src/helpers/ipcHandlers.js`
- Modify: `app/src/jarvis/renderer/__tests__/recordingController.test.ts`
- Modify: `app/src/jarvis/renderer/__tests__/meetingPreparation.test.ts`

**Interfaces:**
- Produces: `buildBilingualPrompt(previousText: string): string` capped at 800 Unicode code points.
- Produces: `classifyTranscriptQuality(text: string): { suspicious: boolean, reasons: string[] }`.
- Produces: `mergeOverlappingTranscript(previous: string, next: string): string`.
- Produces constants `JARVIS_STABLE_WINDOW_MS = 12_000` and `JARVIS_OVERLAP_MS = 2_000`.

- [ ] **Step 1: Write failing pure unit tests**

Cover these exact cases:

```js
assert.match(buildBilingualPrompt("我们讨论 API latency"), /中文和英文混合/);
assert.equal(mergeOverlappingTranscript("我们讨论 API latency", "API latency and budget"), "and budget");
assert.equal(classifyTranscriptQuality("und der die das").suspicious, true);
assert.equal(classifyTranscriptQuality("我们 review 一下 API budget").suspicious, false);
```

Also test repeated 3-grams, blank markers, punctuation-only results, and a normal Chinese-English sentence.

- [ ] **Step 2: Run pure tests and verify RED**

Run: `cd app && node --test test/jarvis/transcriptionQuality.test.js`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement pure bilingual helpers**

Implement deterministic Unicode-aware normalization, suffix/prefix overlap search from longest to shortest, and conservative suspicious-text rules. The prompt must state: preserve Chinese and English, do not translate, use previous context, and emit `[听不清]` rather than inventing a proper noun.

- [ ] **Step 4: Add failing Jarvis model-selection tests**

Extract and export `resolveJarvisWhisperModel(settings)` from `useJarvisRecording.ts`. Assert:

```ts
expect(resolveJarvisWhisperModel({ meetingWhisperModel: "", whisperModel: "base" })).toBe("turbo");
expect(resolveJarvisWhisperModel({ meetingWhisperModel: "small", whisperModel: "base" })).toBe("small");
```

The first assertion makes Jarvis use turbo by default without changing global OpenWhispr defaults.

- [ ] **Step 5: Run renderer tests and verify RED**

Run: `cd app && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/recordingController.test.ts src/jarvis/renderer/__tests__/meetingPreparation.test.ts`

Expected: FAIL because the resolver and local transcription overrides are absent.

- [ ] **Step 6: Implement Jarvis-specific local overrides**

Extend `StartRecordingArgs` with:

```ts
localModelOverride?: string;
localLanguageOverride?: string | null;
localPromptMode?: "bilingual-context";
```

Have `recordingArgs()` pass `localModelOverride: resolveJarvisWhisperModel(getSettings())`, `localLanguageOverride: null`, and `localPromptMode: "bilingual-context"`. `getMeetingTranscriptionOptions()` must use these overrides only for the Jarvis forced-local call.

- [ ] **Step 7: Change the main local meeting loop**

For active Jarvis sessions only:

- schedule stable transcription every 12,000 ms;
- retain the final 2,000 ms of 24 kHz mono PCM in `meetingLocalBuffers.mic` after a flush;
- pass `initialPrompt: buildBilingualPrompt(meetingLocalTranscript)`;
- remove overlap from the new text with `mergeOverlappingTranscript(lastLocalText, text)`;
- discard only empty/marker-only output; suspicious output remains visible with `confidence: 0.25` and becomes a cloud-correction candidate;
- non-suspicious output receives `confidence: 0.8` until whisper.cpp exposes token probabilities.

Non-Jarvis meeting recording keeps its existing 5-second behavior.

- [ ] **Step 8: Run focused and full Jarvis tests**

Run: `cd app && node --test test/jarvis/transcriptionQuality.test.js test/jarvis/meetingPipelineIntegration.test.js && npm run test:renderer -- --run src/jarvis/renderer/__tests__/recordingController.test.ts src/jarvis/renderer/__tests__/meetingPreparation.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add app/src/jarvis/main/transcriptionQuality.js app/test/jarvis/transcriptionQuality.test.js app/src/jarvis/renderer/useJarvisRecording.ts app/src/stores/meetingRecordingStore.ts app/src/helpers/ipcHandlers.js app/src/jarvis/renderer/__tests__/recordingController.test.ts app/src/jarvis/renderer/__tests__/meetingPreparation.test.ts
git commit -m "feat: improve Jarvis bilingual local transcription"
```

### Task 4: Transactional monthly cloud budget

**Files:**
- Create: `app/src/jarvis/main/CloudBudgetGuard.js`
- Create: `app/test/jarvis/CloudBudgetGuard.test.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/test/jarvis/JarvisRepository.test.js`

**Interfaces:**
- Produces repository methods `getCloudBudgetSettings()`, `setCloudBudgetSettings(input)`, `getCloudBudgetStatus(at)`, `reserveCloudUsage(input)`, `settleCloudUsage(input)`, and `releaseCloudUsage(input)`.
- Produces `CloudBudgetGuard.reserve(request)`, `.settle(reservationId, usage)`, `.release(reservationId)`, and `.status(at)`.

- [ ] **Step 1: Write failing repository migration tests**

Create an in-memory repository, set `{ enabled: true, monthlyLimitMicrousd: 5_000_000 }`, reserve 100,000 micro-USD, settle with known token usage, close/reopen a file-backed database, and assert the setting and settled cost persist. Assert 4,950,001 spent blocks another 100,000 reservation.

- [ ] **Step 2: Run repository tests and verify RED**

Run: `cd app && node --test test/jarvis/JarvisRepository.test.js`

Expected: FAIL because cloud tables and methods do not exist.

- [ ] **Step 3: Add schema and atomic statements**

Add tables exactly matching the design spec. Enforce `monthly_limit_microusd BETWEEN 5000000 AND 10000000`, status values `reserved|settled|released|unknown`, and a unique usage ID. Implement reservation with one `better-sqlite3` immediate transaction that sums settled plus reserved rows for `month_utc` before inserting.

- [ ] **Step 4: Write failing guard tests**

Use a fake repository to assert:

- two simultaneous `reserve()` calls are serialized;
- input/output cost uses `$2.50/M` and `$10.00/M` for `gpt-4o-transcribe`;
- unknown usage calls `markUnknown` and makes future reservations fail closed;
- a failed network request releases its reservation.

- [ ] **Step 5: Implement the guard**

Use constants:

```js
const RESERVATION_MICROUSD = 100_000;
const DEFAULT_LIMIT_MICROUSD = 5_000_000;
const MIN_LIMIT_MICROUSD = 5_000_000;
const MAX_LIMIT_MICROUSD = 10_000_000;
const PRICE = { version: "openai-2026-07-11", inputPerMillion: 2_500_000, outputPerMillion: 10_000_000 };
```

Calculate micro-USD with integer ceiling arithmetic and keep a promise tail so only one reserve/settle operation runs at a time.

- [ ] **Step 6: Run budget tests**

Run: `cd app && node --test test/jarvis/JarvisRepository.test.js test/jarvis/CloudBudgetGuard.test.js`

Expected: all selected tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add app/src/jarvis/main/JarvisRepository.js app/src/jarvis/main/CloudBudgetGuard.js app/test/jarvis/JarvisRepository.test.js app/test/jarvis/CloudBudgetGuard.test.js
git commit -m "feat: add transactional cloud budget guard"
```

### Task 5: Opt-in OpenAI correction service and versioned renderer updates

**Files:**
- Create: `app/src/jarvis/main/OpenAiCorrectionService.js`
- Create: `app/test/jarvis/OpenAiCorrectionService.test.js`
- Modify: `app/src/jarvis/main/JarvisRepository.js`
- Modify: `app/src/helpers/ipcHandlers.js`
- Modify: `app/src/stores/meetingRecordingStore.ts`
- Modify: `app/src/types/electron.ts`
- Modify: `app/main.js`
- Modify: `app/test/jarvis/meetingPipelineIntegration.test.js`
- Modify: `app/src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts`

**Interfaces:**
- Consumes: `CloudBudgetGuard`, `environmentManager.getOpenAIKey()`, Electron `net.fetch`, and `classifyTranscriptQuality()`.
- Produces: `OpenAiCorrectionService.maybeCorrect(input): Promise<{ status: string, text?: string, confidence?: number }>`.
- Produces meeting event type `correction` with `{ text, originalText, source, timestamp, confidence }`.

- [ ] **Step 1: Write failing service tests with a mock fetch**

Assert a normal bilingual transcript performs no request; a suspicious transcript with consent and key sends one multipart request containing model `gpt-4o-transcribe`, `include[]=logprobs`, the WAV, and the bilingual prompt. Mock this response:

```json
{"text":"我们 review 一下 API budget","usage":{"type":"tokens","input_tokens":120,"output_tokens":18,"total_tokens":138},"logprobs":[]}
```

Assert usage settles, while 401/429/500/timeouts release the reservation and return the local fallback. Assert request/log metadata never contains the key or transcript.

- [ ] **Step 2: Run the service test and verify RED**

Run: `cd app && node --test test/jarvis/OpenAiCorrectionService.test.js`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement the service**

The service must check, in order: suspicious classification, cloud enabled/consent, key present, budget reservation. It posts to `https://api.openai.com/v1/audio/transcriptions`, parses JSON, validates `text` and token usage, settles the reservation, and returns a correction only when normalized text differs from the local draft. Abort after 30 seconds.

- [ ] **Step 4: Add transcript revision persistence**

Add a `transcript_revisions` table keyed by revision ID with segment/session identity, original/current text, source, confidence, reason, and corrected time. `JarvisRepository.addTranscriptRevision()` must reject a segment from a different session and never change `person_id`, `speaker_label`, `started_at`, or `ended_at`.

- [ ] **Step 5: Add failing correction-event tests**

Assert the renderer replaces only the segment matching `source + timestamp + originalText`, preserves its speaker fields, sets `revisionSource: "openai_correction"`, and ignores stale corrections after recording cleanup.

- [ ] **Step 6: Wire the main pipeline**

Construct `CloudBudgetGuard` and `OpenAiCorrectionService` in `main.js`, inject the service into `IPCHandlers`, and after emitting a suspicious local final call `maybeCorrect()` without awaiting it. On success emit:

```js
win.webContents.send("meeting-transcription-segment", {
  type: "correction",
  text: corrected.text,
  originalText: localText,
  source,
  timestamp: segTimestamp,
  confidence: corrected.confidence,
});
```

Guard against destroyed windows and changed `activeJarvisSessionId` before emitting.

- [ ] **Step 7: Run focused integration tests**

Run: `cd app && node --test test/jarvis/OpenAiCorrectionService.test.js test/jarvis/meetingPipelineIntegration.test.js && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add app/src/jarvis/main/OpenAiCorrectionService.js app/src/jarvis/main/JarvisRepository.js app/src/helpers/ipcHandlers.js app/src/stores/meetingRecordingStore.ts app/src/types/electron.ts app/main.js app/test/jarvis/OpenAiCorrectionService.test.js app/test/jarvis/meetingPipelineIntegration.test.js app/src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts
git commit -m "feat: correct low confidence transcripts within budget"
```

### Task 6: Budget and transcription quality UI

**Files:**
- Create: `app/src/jarvis/renderer/TranscriptionQualityCard.tsx`
- Create: `app/src/jarvis/renderer/__tests__/TranscriptionQualityCard.test.tsx`
- Modify: `app/src/jarvis/shared/contracts.js`
- Modify: `app/src/jarvis/main/registerJarvisIpc.js`
- Modify: `app/preload.js`
- Modify: `app/src/types/electron.ts`
- Modify: `app/src/jarvis/types.ts`
- Modify: `app/src/jarvis/renderer/TodayView.tsx`
- Modify: `app/src/locales/en/translation.json`
- Modify: `app/src/locales/zh-CN/translation.json`
- Modify: `app/test/jarvis/contracts.test.js`

**Interfaces:**
- Produces channels `jarvis:cloud-budget:get` and `jarvis:cloud-budget:set`.
- Produces `JarvisCloudBudgetStatus` with enabled, keyConfigured, limit/spent/reserved/remaining micro-USD, month UTC, and blocked reason.

- [ ] **Step 1: Write failing IPC and renderer tests**

The card test must assert defaults `$5.00`, cloud toggle off, key-not-configured state, range validation, a `$4.90 used / $0.10 remaining` display, and blocked copy for `budget_protected` and `usage_unknown`.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && node --test test/jarvis/contracts.test.js && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/TranscriptionQualityCard.test.tsx`

Expected: FAIL because channels and component are absent.

- [ ] **Step 3: Implement narrow budget IPC**

`get` returns status plus `keyConfigured: Boolean(environmentManager.getOpenAIKey())`; it never returns the key. `set` accepts only `{ enabled: boolean, monthlyLimitMicrousd: safe integer }` and reuses repository validation.

- [ ] **Step 4: Implement the card**

Render the current local model, cloud toggle, explicit audio-upload consent text, `$5–$10` number input, progress, and precise blocked state. When no key exists, show a password field that calls the existing `saveOpenAIKey()` method and clears its local value immediately after save.

- [ ] **Step 5: Add the card to the insights column and translations**

Place `TranscriptionQualityCard` above `VoiceEnrollment`. Add all new copy to English and Simplified Chinese locale files and run the existing i18n checker.

- [ ] **Step 6: Run UI and contract tests**

Run: `cd app && node --test test/jarvis/contracts.test.js && npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/TranscriptionQualityCard.test.tsx src/jarvis/renderer/__tests__/JarvisShell.test.tsx && npm run i18n:check`

Expected: all selected tests and i18n check PASS.

- [ ] **Step 7: Commit**

```powershell
git add app/src/jarvis/renderer/TranscriptionQualityCard.tsx app/src/jarvis/renderer/__tests__/TranscriptionQualityCard.test.tsx app/src/jarvis/shared/contracts.js app/src/jarvis/main/registerJarvisIpc.js app/preload.js app/src/types/electron.ts app/src/jarvis/types.ts app/src/jarvis/renderer/TodayView.tsx app/src/locales/en/translation.json app/src/locales/zh-CN/translation.json app/test/jarvis/contracts.test.js
git commit -m "feat: add transcription budget controls"
```

### Task 7: Regression, package, and Windows hardware verification

**Files:**
- Modify only files required by failures found in this task.

**Interfaces:**
- Consumes all prior tasks.
- Produces verified unpacked Windows artifact.

- [ ] **Step 1: Run the full automated suite**

Run from `app`:

```powershell
npm run test:jarvis
npm run typecheck
npm run lint
npm run i18n:check
npm run build:renderer
```

Expected: all commands exit 0.

- [ ] **Step 2: Run packaging security and ABI checks**

Run:

```powershell
node --test test/jarvis/PackagingSafety.test.js test/jarvis/NativeAbiPackaging.test.js
npm run build:win:unsigned
```

Expected: security/ABI tests PASS and unsigned Windows artifacts are produced.

- [ ] **Step 3: Launch and verify hardware behavior**

Launch the unpacked executable. Verify titlebar dragging, minimize/maximize/close, turbo download/load, a five-minute Chinese-English sample, voice enrollment persistence after restart, and local recording continuity with cloud disabled.

- [ ] **Step 4: Verify cloud fail-closed behavior**

With mock budget near exhaustion, verify no outbound request occurs. With an independently scoped OpenAI Project Key entered through the app, enable consent, trigger one suspicious sample, compare local and corrected text, and match local token ledger with the response usage.

- [ ] **Step 5: Copy the verified deliverables**

Copy the installer/unpacked launch artifact and updated README/release notes to `C:\Users\xujie\Documents\Codex\2026-07-10\mvp\outputs` without deleting prior user artifacts.

- [ ] **Step 6: Confirm the verification tree is clean**

```powershell
git status --short
```

Expected: no output. If verification exposes a defect, return to the owning task, add a failing regression test, implement the fix, rerun that task's checks, and use that task's explicit commit command before repeating Task 7.

---

## Self-Review Results

- Spec coverage: window dragging, local turbo/context, suspicious classification, cloud correction, strict local budget stop, unknown-usage fail-closed behavior, voice enrollment status, privacy boundaries, UI, persistence, and hardware verification are each mapped to a task.
- Placeholder scan: no unfinished markers or unspecified error-handling steps remain.
- Type consistency: channel names, service method names, repository methods, renderer event type, budget units, and voice status fields are identical across producer and consumer tasks.
