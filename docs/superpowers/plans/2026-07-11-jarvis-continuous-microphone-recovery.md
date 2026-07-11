# Jarvis Continuous Microphone Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an active Jarvis recording alive through unlimited microphone disconnects, automatically recover onto a physical input, and show a non-fatal reconnecting state.

**Architecture:** Add a pure recovery-policy module that owns virtual-device filtering, candidate ordering, and retry delays. Replace the recording store's one-shot fallback flags with one cancelable recovery loop that re-enumerates devices every cycle and attaches every replacement to the existing PCM/transcription pipeline. Propagate a small recovery state to the existing recording card without changing persisted session data.

**Tech Stack:** TypeScript 6, Zustand 5, React 19, Web MediaDevices/MediaStream APIs, Web Audio API, Vitest 3, Testing Library, Electron 41.

## Global Constraints

- Runtime recovery has no maximum attempt count.
- Retry delays are exactly `0`, `500`, `1000`, `2000`, `5000`, then `10000` milliseconds for every later failed cycle.
- Automatic recovery excludes labels containing `sonar`, `voicemeeter`, `steam`, or `yy`, case-insensitively.
- Empty-label devices are excluded from exact automatic candidates; an unlabeled default stream is rejected.
- Initial microphone permission denial remains fatal as `MIC_PERMISSION`.
- A runtime outage does not emit `MIC_DISCONNECTED` or stop the active Jarvis session.
- Stop, pause, finalize, and shutdown cancel pending timers and discard late streams.
- No database schema, cloud-budget, transcription-session, speaker, or retention changes.

---

### Task 1: Pure microphone recovery policy

**Files:**
- Create: `app/src/jarvis/renderer/microphoneRecoveryPolicy.ts`
- Create: `app/src/jarvis/renderer/__tests__/microphoneRecoveryPolicy.test.ts`

**Interfaces:**
- Consumes: browser `MediaDeviceInfo`-shaped values with `kind`, `deviceId`, and `label`.
- Produces: `isDeniedAutomaticMicrophone(label: string): boolean`, `orderMicrophoneRecoveryCandidates(devices, selectedDeviceId): MicrophoneRecoveryCandidate[]`, and `getMicrophoneRecoveryDelay(attempt: number): number`.

- [ ] **Step 1: Write failing policy tests**

```ts
import { describe, expect, it } from "vitest";
import {
  getMicrophoneRecoveryDelay,
  isDeniedAutomaticMicrophone,
  orderMicrophoneRecoveryCandidates,
} from "../microphoneRecoveryPolicy";

const input = (deviceId: string, label: string) =>
  ({ kind: "audioinput", deviceId, label }) as MediaDeviceInfo;

describe("microphoneRecoveryPolicy", () => {
  it.each(["SteelSeries SONAR", "VoiceMeeter Output", "Steam Streaming Mic", "YY AI Voice"])(
    "denies virtual input %s",
    (label) => expect(isDeniedAutomaticMicrophone(label)).toBe(true)
  );

  it.each(["Microphone (5- Shure MV7)", "Microphone (6- Arctis Nova Pro)"])(
    "allows physical input %s",
    (label) => expect(isDeniedAutomaticMicrophone(label)).toBe(false)
  );

  it("orders the saved physical device first and removes unsafe candidates", () => {
    const devices = [
      input("default", "SteelSeries Sonar - Microphone"),
      input("shure", "Microphone (5- Shure MV7)"),
      input("arctis", "Microphone (6- Arctis Nova Pro)"),
      input("hidden", ""),
      input("shure", "Microphone (5- Shure MV7)"),
      input("duplicate-label", "Microphone (5- Shure MV7)"),
    ];
    expect(orderMicrophoneRecoveryCandidates(devices, "arctis")).toEqual([
      { deviceId: "arctis", label: "Microphone (6- Arctis Nova Pro)" },
      { deviceId: "shure", label: "Microphone (5- Shure MV7)" },
    ]);
  });

  it("backs off to a stable ten-second retry interval", () => {
    expect(Array.from({ length: 8 }, (_, attempt) => getMicrophoneRecoveryDelay(attempt))).toEqual([
      0, 500, 1000, 2000, 5000, 10000, 10000, 10000,
    ]);
  });
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/microphoneRecoveryPolicy.test.ts`

Expected: FAIL because `../microphoneRecoveryPolicy` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

```ts
const DENIED_AUTOMATIC_MICROPHONE_TOKENS = ["sonar", "voicemeeter", "steam", "yy"];
const RECOVERY_DELAYS_MS = [0, 500, 1000, 2000, 5000, 10000] as const;

export interface MicrophoneRecoveryCandidate {
  deviceId: string;
  label: string;
}

export function isDeniedAutomaticMicrophone(label: string): boolean {
  const normalized = label.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    DENIED_AUTOMATIC_MICROPHONE_TOKENS.some((token) => normalized.includes(token))
  );
}

export function orderMicrophoneRecoveryCandidates(
  devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  selectedDeviceId: string | null | undefined
): MicrophoneRecoveryCandidate[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const allowed = devices
    .filter((device) => device.kind === "audioinput")
    .filter((device) => device.deviceId !== "default")
    .filter((device) => !isDeniedAutomaticMicrophone(device.label))
    .filter((device) => {
      const normalizedLabel = device.label.trim().toLocaleLowerCase();
      if (seenIds.has(device.deviceId) || seenLabels.has(normalizedLabel)) return false;
      seenIds.add(device.deviceId);
      seenLabels.add(normalizedLabel);
      return true;
    })
    .map(({ deviceId, label }) => ({ deviceId, label }));
  return [
    ...allowed.filter((candidate) => candidate.deviceId === selectedDeviceId),
    ...allowed.filter((candidate) => candidate.deviceId !== selectedDeviceId),
  ];
}

export function getMicrophoneRecoveryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), RECOVERY_DELAYS_MS.length - 1);
  return RECOVERY_DELAYS_MS[index];
}
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/microphoneRecoveryPolicy.test.ts`

Expected: PASS with all policy cases green.

- [ ] **Step 5: Commit the policy unit**

```powershell
git add app/src/jarvis/renderer/microphoneRecoveryPolicy.ts app/src/jarvis/renderer/__tests__/microphoneRecoveryPolicy.test.ts
git commit -m "feat(jarvis): add microphone recovery policy"
```

---

### Task 2: Unlimited cancelable recovery controller

**Files:**
- Modify: `app/src/stores/meetingRecordingStore.ts:73-94, 428-475, 711-759, 1233-1350, 1457-1466`
- Modify: `app/src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts:17-24, 181-320`

**Interfaces:**
- Consumes: Task 1 policy functions and existing `attachMicPipeline(stream, fallbackActive)` pipeline handoff.
- Produces: meeting-store fields `micRecoveryStatus: "idle" | "reconnecting" | "restored"` and `micRecoveryAttempt: number`; an active capture that repeatedly re-enumerates and recovers without a fatal state transition.

- [ ] **Step 1: Replace the one-shot regression expectation with failing continuous-recovery tests**

Add tests using fake timers and distinct `FakeTrack` instances:

```ts
it("keeps retrying after failed recovery cycles without stopping the session", async () => {
  vi.useFakeTimers();
  const enumerate = vi.mocked(navigator.mediaDevices.enumerateDevices);
  enumerate.mockResolvedValue([]);
  vi.mocked(navigator.mediaDevices.getUserMedia)
    .mockResolvedValueOnce(streamFor(track))
    .mockRejectedValue(new DOMException("missing", "NotFoundError"));

  await startJarvisRecording("s-unlimited-recovery");
  track.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(12_000);

  expect(enumerate.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(useMeetingRecordingStore.getState()).toMatchObject({
    isRecording: true,
    error: null,
    micRecoveryStatus: "reconnecting",
  });
  expect(window.electronAPI.meetingTranscriptionStop).not.toHaveBeenCalled();
});

it("rejects a Sonar default stream and later attaches a physical microphone", async () => {
  vi.useFakeTimers();
  const sonarTrack = namedTrack("SteelSeries Sonar - Microphone");
  const shureTrack = namedTrack("Microphone (5- Shure MV7)");
  vi.mocked(navigator.mediaDevices.enumerateDevices)
    .mockResolvedValueOnce([])
    .mockResolvedValue([inputDevice("shure", shureTrack.label)]);
  vi.mocked(navigator.mediaDevices.getUserMedia)
    .mockResolvedValueOnce(streamFor(track))
    .mockResolvedValueOnce(streamFor(sonarTrack))
    .mockResolvedValueOnce(streamFor(shureTrack));

  await startJarvisRecording("s-filter-virtual");
  track.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(500);

  expect(sonarTrack.stop).toHaveBeenCalledOnce();
  expect(useMeetingRecordingStore.getState()).toMatchObject({
    isRecording: true,
    activeMicLabel: shureTrack.label,
    micRecoveryStatus: "restored",
  });
});

it("recovers again when a replacement track later ends", async () => {
  const firstReplacement = namedTrack("Microphone (5- Shure MV7)");
  const secondReplacement = namedTrack("Microphone (6- Arctis Nova Pro)");
  vi.mocked(navigator.mediaDevices.enumerateDevices)
    .mockResolvedValueOnce([inputDevice("shure", firstReplacement.label)])
    .mockResolvedValueOnce([inputDevice("arctis", secondReplacement.label)]);
  vi.mocked(navigator.mediaDevices.getUserMedia)
    .mockResolvedValueOnce(streamFor(track))
    .mockResolvedValueOnce(streamFor(firstReplacement))
    .mockResolvedValueOnce(streamFor(secondReplacement));
  await startJarvisRecording("s-repeat-recovery");
  track.dispatchEvent(new Event("ended"));
  await waitForActiveMic(firstReplacement.label);
  firstReplacement.dispatchEvent(new Event("ended"));
  await waitForActiveMic(secondReplacement.label);
  expect(useMeetingRecordingStore.getState().isRecording).toBe(true);
});

it("cancels a delayed retry when recording stops", async () => {
  vi.useFakeTimers();
  await startJarvisRecording("s-cancel-delay");
  track.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(500);
  const callsBeforeStop = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.length;
  await stopRecording();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(callsBeforeStop);
});
```

Use small test helpers `streamFor`, `namedTrack`, `inputDevice`, `startJarvisRecording`, and `waitForActiveMic` to keep each assertion focused. Restore real timers in `afterEach`.

- [ ] **Step 2: Run the capture test and verify RED**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts`

Expected: FAIL because the current second-ended/failed-fallback path sets `MIC_DISCONNECTED` and calls `stopRecording`.

- [ ] **Step 3: Add state and cancellation ownership**

Add the two recovery fields to `MeetingRecordingState`, initialize them to `idle`/`0`, and reset them in `resetStoppedMeetingState`. Add a module-scoped cancellation hook called before `cleanupCaptureSources` closes the media pipeline:

```ts
let cancelActiveMicRecovery: (() => void) | null = null;

async function cleanupCaptureSources(): Promise<void> {
  cancelActiveMicRecovery?.();
  cancelActiveMicRecovery = null;
  // existing processor, node, stream, and context cleanup
}
```

- [ ] **Step 4: Implement exact-candidate acquisition and virtual-default rejection**

Inside the active `startRecording` scope, add `acquireRecoveryStream()` that calls `enumerateDevices()` on every invocation, tries ordered exact candidates with the existing audio constraints, validates `readyState === "live" && !muted`, then tries the default constraints. Stop every rejected or denied stream immediately. Permission errors are logged and returned as failed recovery attempts; they do not terminate an already-running session.

```ts
const selectedMicDeviceId = getSettings().selectedMicDeviceId || null;
const activeLabel = (stream: MediaStream) => stream.getAudioTracks()[0]?.label?.trim() || "";
const isUsableMicStream = (stream: MediaStream) => {
  const track = stream.getAudioTracks()[0];
  return Boolean(track && track.readyState === "live" && !track.muted);
};
const recoveryLog = (error: unknown, candidate?: MicrophoneRecoveryCandidate) => ({
  attempt: useMeetingRecordingStore.getState().micRecoveryAttempt,
  candidateLabel: candidate?.label ?? "system-default",
  errorName: error instanceof DOMException || error instanceof Error ? error.name : "UnknownError",
});

const acquireRecoveryStream = async (): Promise<MediaStream | null> => {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const candidates = orderMicrophoneRecoveryCandidates(devices, selectedMicDeviceId);
  for (const candidate of candidates) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: candidate.deviceId }, ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS },
      });
      if (isUsableMicStream(stream) && !isDeniedAutomaticMicrophone(activeLabel(stream))) {
        return stream;
      }
      stopMediaStream(stream);
    } catch (error) {
      logger.info(
        "Jarvis microphone recovery candidate unavailable",
        recoveryLog(error, candidate),
        "meeting"
      );
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
    });
    if (isUsableMicStream(stream) && !isDeniedAutomaticMicrophone(activeLabel(stream))) return stream;
    stopMediaStream(stream);
  } catch (error) {
    logger.info(
      "Jarvis default microphone recovery unavailable",
      recoveryLog(error),
      "meeting"
    );
  }
  return null;
};
```

- [ ] **Step 5: Replace one-shot fallback flags with one unlimited loop**

Use one generation token, one promise, and one timer. Every attached track receives `beginMicRecovery`; replacement tracks are therefore recoverable too.

```ts
let recoveryGeneration = 0;
let recoveryPromise: Promise<void> | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let resolveRecoveryDelay: (() => void) | null = null;

const waitForRecoveryDelay = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    if (delayMs === 0) {
      resolve();
      return;
    }
    resolveRecoveryDelay = resolve;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      resolveRecoveryDelay = null;
      resolve();
    }, delayMs);
  });

const cancelRecovery = () => {
  recoveryGeneration += 1;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  resolveRecoveryDelay?.();
  resolveRecoveryDelay = null;
  useMeetingRecordingStore.setState({ micRecoveryStatus: "idle", micRecoveryAttempt: 0 });
};
cancelActiveMicRecovery = cancelRecovery;

const beginMicRecovery = () => {
  if (!isRecordingFlag || recoveryPromise) return;
  const generation = recoveryGeneration;
  recoveryPromise = (async () => {
    for (let attempt = 0; isRecordingFlag && generation === recoveryGeneration; attempt += 1) {
      useMeetingRecordingStore.setState({
        activeMicLabel: null,
        currentMicLevel: 0,
        error: null,
        micFallbackActive: true,
        micRecoveryStatus: "reconnecting",
        micRecoveryAttempt: attempt + 1,
      });
      await waitForRecoveryDelay(getMicrophoneRecoveryDelay(attempt));
      if (!isRecordingFlag || generation !== recoveryGeneration) return;
      const replacement = await acquireRecoveryStream();
      if (!replacement) continue;
      if (!isRecordingFlag || generation !== recoveryGeneration) {
        stopMediaStream(replacement);
        return;
      }
      await attachMicPipeline(replacement, true);
      useMeetingRecordingStore.setState({ micRecoveryStatus: "restored", micRecoveryAttempt: 0 });
      return;
    }
  })().finally(() => {
    recoveryPromise = null;
  });
};
```

The delay helper resolves early when `cancelRecovery` clears its timer. Do not call `stopRecording()` from an ended handler or recovery failure.

- [ ] **Step 6: Run the capture test and verify GREEN**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts`

Expected: PASS, including repeated recovery, virtual-device rejection, and cancellation cases.

- [ ] **Step 7: Run all renderer tests for regression coverage**

Run: `npm run test:renderer`

Expected: all renderer tests PASS with zero failures.

- [ ] **Step 8: Commit the recovery controller**

```powershell
git add app/src/stores/meetingRecordingStore.ts app/src/jarvis/renderer/__tests__/meetingFinalSegmentShutdown.test.ts
git commit -m "fix(jarvis): recover microphones without stopping"
```

---

### Task 3: Recovery status in the recording card

**Files:**
- Modify: `app/src/jarvis/renderer/useJarvisRecording.ts:687-700, 703-713, 916-929`
- Modify: `app/src/jarvis/renderer/RecordingControls.tsx:71-175`
- Modify: `app/src/locales/en/translation.json:54-57`
- Modify: `app/src/locales/zh-CN/translation.json:54-57`
- Create: `app/src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

**Interfaces:**
- Consumes: Task 2 store fields `micRecoveryStatus` and `micRecoveryAttempt`.
- Produces: optional `UseJarvisRecordingResult` fields with the same names and localized reconnecting/restored notices.

- [ ] **Step 1: Write failing UI tests**

Render `RecordingControls` with a reusable fake `UseJarvisRecordingResult`. Stub `navigator.mediaDevices.enumerateDevices` to return a Shure device so the test remains deterministic.

```tsx
it("shows a non-fatal reconnecting notice while controls remain available", async () => {
  render(
    <RecordingControls
      recording={fakeRecording({
        micRecoveryStatus: "reconnecting",
        micRecoveryAttempt: 7,
        activeMicLabel: null,
        error: null,
      })}
    />
  );
  expect(screen.getByText("麦克风已断开，正在重连（第 7 次）…")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "完成" })).toBeEnabled();
});

it("shows the restored physical microphone", () => {
  render(
    <RecordingControls
      recording={fakeRecording({
        micRecoveryStatus: "restored",
        activeMicLabel: "Microphone (5- Shure MV7)",
      })}
    />
  );
  expect(screen.getByText("麦克风已恢复：Microphone (5- Shure MV7)")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted UI test and verify RED**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

Expected: FAIL because the result fields and localized recovery notices do not exist.

- [ ] **Step 3: Propagate recovery state and render localized notices**

Add optional fields to `UseJarvisRecordingResult`, subscribe to the two meeting-store fields, and return them. In `RecordingControls`, render reconnecting before the old fallback notice and remove the existing corrupted hard-coded fallback text.

```tsx
{recording.micRecoveryStatus === "reconnecting" ? (
  <p aria-live="polite" className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
    {t("jarvis.micReconnecting", { count: recording.micRecoveryAttempt ?? 1 })}
  </p>
) : recording.micRecoveryStatus === "restored" && recording.activeMicLabel ? (
  <p aria-live="polite" className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
    {t("jarvis.micRestored", { device: recording.activeMicLabel })}
  </p>
) : recording.micFallbackActive ? (
  <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
    {t("jarvis.micFallback", { device: recording.activeMicLabel || t("jarvis.defaultMicrophone") })}
  </p>
) : null}
```

Add these English and Simplified Chinese keys:

```json
"micReconnecting": "Microphone disconnected. Reconnecting (attempt {{count}})…",
"micRestored": "Microphone restored: {{device}}",
"micFallback": "Preferred microphone disconnected. Continuing with {{device}}."
```

```json
"micReconnecting": "麦克风已断开，正在重连（第 {{count}} 次）…",
"micRestored": "麦克风已恢复：{{device}}",
"micFallback": "首选麦克风已断开，正在使用 {{device}} 继续录音。"
```

Other locales use the English fallback until translated; no unrelated locale rewrite is included.

- [ ] **Step 4: Run the targeted UI test and verify GREEN**

Run: `npx vitest run --config src/vitest.config.ts src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

Expected: PASS with reconnecting and restored notices covered.

- [ ] **Step 5: Run localization, type, and renderer checks**

Run: `npm run i18n:check`

Expected: PASS because added keys remain valid JSON and fallback behavior is supported.

Run: `npm run typecheck`

Expected: PASS with zero TypeScript errors.

Run: `npm run test:renderer`

Expected: all renderer tests PASS with zero failures.

- [ ] **Step 6: Commit the UI state**

```powershell
git add app/src/jarvis/renderer/useJarvisRecording.ts app/src/jarvis/renderer/RecordingControls.tsx app/src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx app/src/locales/en/translation.json app/src/locales/zh-CN/translation.json
git commit -m "feat(jarvis): show microphone recovery status"
```

---

### Task 4: Full verification and Windows package

**Files:**
- Verify: all files changed in Tasks 1-3.
- Package output: `app/dist/Jarvis Memory 0.1.0.exe` or the existing portable output configured by `electron-builder`.

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: fresh test/build/package evidence and a runnable Windows artifact.

- [ ] **Step 1: Review the complete diff against the approved design**

Run: `git diff master...HEAD --check`

Expected: no whitespace errors.

Run: `git diff master...HEAD --stat`

Expected: changes are limited to microphone recovery policy, recording lifecycle, UI state, locales, and tests.

- [ ] **Step 2: Run all automated checks**

Run: `npm run test:main`

Expected: all main-process tests PASS.

Run: `npm run test:renderer`

Expected: all renderer tests PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npm run i18n:check`

Expected: PASS.

- [ ] **Step 3: Build the renderer and Windows package**

Run: `npm run build:renderer`

Expected: Vite exits `0` and produces renderer assets.

Run: `npm run build:win:unsigned`

Expected: `scripts/build-windows.js` exits `0`, performs its Electron/native-module ABI verification and Node ABI restoration, and writes the unsigned Windows artifact under `app/dist`.

- [ ] **Step 4: Launch and perform hardware acceptance**

Start the newly packaged Jarvis build. Pin Shure MV7 or Arctis Nova Pro, start recording, disable/disconnect it twice, and verify:

- the session timer never stops;
- Sonar is not selected automatically;
- reconnecting attempts continue past the old one-shot limit;
- reconnecting the physical device restores the active label and transcript;
- stopping during reconnecting prevents any later microphone activation.

- [ ] **Step 5: Integrate the verified branch**

After all checks and hardware acceptance pass, merge the feature branch into local `master` without rewriting unrelated history. Keep all commits and report the final artifact path and verification counts.
