# Jarvis Microphone Selector and Runtime Fallback Design

## Problem

Jarvis currently records from the application-wide microphone setting, but the Jarvis control panel does not expose a device selector. The default Windows capture endpoint on this machine is `SteelSeries Sonar - Microphone`. That virtual endpoint has intermittently ended its `MediaStreamTrack` shortly after capture starts, producing the generic `MIC_DISCONNECTED` message even though physical microphones remain available.

The user needs to pin Jarvis to a physical microphone while retaining an automatic system-default fallback when the pinned device is unavailable or disconnects during a recording.

## Goals

- Show every currently available audio-input device in a compact selector on the Jarvis recording card.
- Persist an explicitly selected device through the existing `selectedMicDeviceId` setting.
- Disable `preferBuiltInMic` when the user makes an explicit Jarvis selection so it cannot override the pinned device.
- Use an exact device constraint for the selected microphone on start and resume.
- Fall back to the system-default microphone if the selected device cannot be opened.
- If the selected track ends during capture, replace the microphone pipeline with a system-default stream without ending the Jarvis session.
- Display the actual active microphone and a visible fallback notice.
- Preserve the current `MIC_DISCONNECTED` failure behavior only when both the selected device and system default are unavailable.

## Non-goals

- Capturing computer/system audio.
- Automatically switching back to the preferred microphone during an active recording after fallback succeeds.
- Changing the global Windows default audio device.
- Uploading audio or changing cloud-correction behavior.
- Classifying devices as physical or virtual with an unreliable label heuristic.

## User experience

The recording card gains a `Microphone` select control. It is enabled while Jarvis is idle, finished, failed, or paused, and disabled while starting, recording, or finalizing.

The selector contains `System default` followed by every `audioinput` device returned by `enumerateDevices()`. If labels are unavailable, Jarvis requests microphone access once, stops the temporary permission stream immediately, and enumerates again.

Selecting a named device stores its exact `deviceId` and sets `preferBuiltInMic=false`. Selecting `System default` stores an empty device id and also sets `preferBuiltInMic=false`.

During capture, the card displays the label from the active `MediaStreamTrack`, not merely the saved selection. If fallback is active, a non-blocking notice says: `Selected microphone disconnected. Continuing with <device>.`

If fallback also fails, Jarvis stops the capture pipeline and shows the existing recording error. The saved preferred device is not erased, so the next session can try it again.

## Architecture

### Device selector

Create `app/src/jarvis/renderer/JarvisMicrophoneSelector.tsx`. It owns device enumeration and device-change refresh, and consumes the existing Zustand settings store:

- `selectedMicDeviceId`
- `setSelectedMicDeviceId(deviceId)`
- `setPreferBuiltInMic(false)`

It receives `disabled: boolean` from `RecordingControls` and exposes no recording lifecycle methods.

`RecordingControls` renders the selector inside the recording card and uses the active microphone metadata from `UseJarvisRecordingResult` for its status label.

### Capture selection and initial fallback

Refactor microphone constraint resolution in `meetingRecordingStore.ts` into an independently testable unit. The resolver returns both the preferred exact constraint and the default fallback constraint.

For Jarvis mic-only capture:

1. If `selectedMicDeviceId` is set, call `getUserMedia` with `deviceId: { exact: selectedMicDeviceId }`.
2. If that request fails for any reason other than permission denial, retry once with the default constraints.
3. Permission denial remains `MIC_PERMISSION`; it must not trigger a second permission request.
4. If no explicit device is stored, open the system default directly.

Non-Jarvis meeting capture retains its existing fallback behavior.

### Mid-recording hot swap

Extract microphone pipeline attachment into a capture-local helper that can be invoked for both the initial stream and a replacement stream. The helper owns:

- the `MediaStream` and active audio track;
- a 24 kHz `AudioContext` detached from an output device;
- the worklet source and processor;
- the microphone analyser;
- the track-ended listener.

When the selected track fires `ended` during Jarvis mic-only capture:

1. Guard recovery with a single in-flight promise so duplicate events cannot create parallel pipelines.
2. Acquire the system-default stream once.
3. Build the replacement pipeline using the existing `onChunk` callback, so main-process WAV writing and local transcription continue in the same Jarvis session.
4. Atomically publish the new stream/context/source/processor/analyser references.
5. Flush and close the old pipeline after the replacement is ready.
6. Publish active-device metadata with `fallbackActive=true`.

If default acquisition or replacement-pipeline creation fails, preserve the current `MIC_DISCONNECTED` path and stop recording.

The fallback stream is not automatically switched back to the selected microphone during the same recording. The preferred id remains persisted for the next start or manual pause/resume.

### State propagation

Extend the meeting recording state and `UseJarvisRecordingResult` with:

- `activeMicLabel: string | null`
- `micFallbackActive: boolean`

Reset both fields during final cleanup. The user-visible recording state continues to come from the existing Jarvis session machine; no new database columns are required.

## Error handling and concurrency

- Device enumeration failure shows a local selector error without changing the saved device.
- A missing saved device remains visible as `Previously selected microphone unavailable` until the user chooses another device.
- A selection cannot be changed during an active start/finalize/recording operation.
- Only one default-device recovery attempt may run for a track-ended event.
- Stop/finalize invalidates an in-flight recovery; a late replacement stream is stopped and never attached.
- Old and replacement pipelines must never dispatch the same PCM buffer concurrently.
- Recovery does not reset the Jarvis timer, session id, transcript segment ids, speaker identities, or cloud budget state.

## Testing

### Renderer component tests

- Enumerates labeled microphones and renders the system-default choice.
- Requests permission only when labels are absent and immediately stops the temporary stream.
- Selecting a device persists its id and disables built-in preference.
- The selector is disabled while recording and enabled while paused.
- Device removal preserves the saved id and displays the unavailable label.

### Capture pipeline tests

- An available exact device is used without requesting default fallback.
- An unavailable exact device falls back to default for Jarvis mic-only capture.
- Permission denial reports `MIC_PERMISSION` without fallback.
- A selected track ending attaches one default replacement and continues PCM dispatch in the same session.
- Duplicate ended events share one recovery.
- Stop during recovery discards the late replacement.
- Default recovery failure produces `MIC_DISCONNECTED` and stops capture.

### Hardware acceptance

- Select the active Shure MV7 or Arctis Nova Pro endpoint in Jarvis.
- Restart the app and confirm the selection persists.
- Start, pause, resume, and finish while verifying the active-device label and microphone meter.
- Confirm WAV files under `G:\JarvisData\recordings` contain non-silent audio.
- Confirm cloud correction remains off and no usage is recorded.

## Success criteria

- Jarvis can be pinned to a physical microphone from its own control panel.
- Sonar is not used while the pinned device is available.
- A preferred-device disconnect does not end the Jarvis session when the system default can be opened.
- The UI always states the device actually supplying audio.
- Existing Jarvis, packaging, lint, type-check, and localization suites pass.
