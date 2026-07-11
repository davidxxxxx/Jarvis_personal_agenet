# Jarvis Microphone Selector and Continuous Recovery Design

## Problem

Jarvis exposes a microphone selector and can hot-swap once from a pinned input to the Windows default input. The default input on this machine is `SteelSeries Sonar - Microphone`. If the selected track ends, Jarvis can therefore move onto the same unstable virtual-audio path; if that replacement track ends, the current one-shot recovery guard emits `MIC_DISCONNECTED` and stops the recording.

Jarvis must keep an already-started recording session alive through any number of microphone interruptions. Automatic recovery must re-enumerate devices, avoid known virtual inputs, retry indefinitely, and resume the existing audio/transcription pipeline when a physical input becomes available.

## Goals

- Preserve the existing explicit microphone selector and persisted `selectedMicDeviceId` setting.
- Respect the user's explicit selection when a recording starts.
- When an active Jarvis microphone track ends, keep the recording session and timer running.
- Re-enumerate audio inputs before every recovery cycle instead of reusing a stale device list.
- Prefer the saved physical microphone, then other physical microphones, then a non-virtual system-default input.
- Exclude known virtual inputs from automatic recovery, including SteelSeries Sonar, VoiceMeeter, Steam, and YY inputs.
- Retry without a maximum attempt count while the recording remains active.
- Resume PCM delivery, WAV writing, transcription, diarization, and analysis in the same Jarvis session after recovery.
- Cancel pending retry timers and discard late streams when the user pauses, stops, finalizes, or exits.
- Show a non-fatal reconnecting state while no microphone is available.

## Non-goals

- Capturing computer/system audio.
- Changing the Windows default audio device.
- Preventing the user from explicitly selecting a virtual microphone for the initial recording.
- Perfect hardware classification. Automatic recovery uses a conservative, test-covered label denylist because Web media-device APIs do not expose a reliable physical/virtual flag.
- Filling a microphone outage with generated silence. The session clock continues, but no synthetic PCM is written during the gap.
- Changing cloud-correction, MiniMax analysis, speaker identity, retention, or budget behavior.

## User experience

The existing `Microphone` selector remains enabled only while changing devices is safe. An explicitly selected device remains persisted across restarts.

During normal recording, the card displays the label from the active `MediaStreamTrack`. When the track ends, Jarvis clears the active label and displays a non-blocking status such as `Microphone disconnected. Reconnecting…`. The recording timer and session remain active.

Recovery starts immediately. If it does not succeed, Jarvis retries after progressively longer delays and then settles at one attempt every 10 seconds. There is no final `MIC_DISCONNECTED` transition solely because recovery attempts have failed. The status remains reconnecting until a suitable microphone is acquired or the user ends the operation.

After recovery, the card displays the new active device and a notice such as `Microphone restored with <device>.` If that replacement later ends, Jarvis returns to the same reconnecting flow.

The user can always pause or stop. Either action immediately cancels future retries and cleans up any replacement stream that resolves after cancellation.

## Architecture

### Recovery policy module

Create a focused renderer module beside the recording store. It contains pure, independently tested policy functions for:

- normalizing device labels;
- detecting denied virtual-device labels;
- ordering recovery candidates;
- returning the retry delay for an attempt.

The denylist is case-insensitive and includes tokens for `sonar`, `voicemeeter`, `steam`, and `yy`. A device with an empty label is not automatically accepted during recovery because its physical/virtual status cannot be verified. The system-default entry is accepted only when its resolved track label is non-empty and does not match the denylist.

Candidate order for each cycle is:

1. the persisted selected device, if it is present and its current label is not denied;
2. remaining labeled, non-denied `audioinput` devices in enumeration order;
3. a default-device request, retained only if the returned track label is non-empty and not denied.

Duplicate device ids and duplicate resolved labels are attempted once per cycle.

Retry delays are `0 ms`, `500 ms`, `1 s`, `2 s`, `5 s`, then `10 s` for every subsequent failed cycle. The delay counter resets after a stream is successfully attached. A new disconnect starts again with an immediate attempt.

### Continuous recovery controller

Replace the capture-local one-shot flags with one recovery controller scoped to the active `startRecording` invocation. It owns:

- a generation token that invalidates work after pause/stop/finalize;
- a single in-flight recovery promise;
- one cancellable retry timer;
- the current attempt number;
- the last active device id and label for ordering and diagnostics.

Every Jarvis mic-only track receives the same ended handler, including replacement tracks. The handler is idempotent: duplicate `ended` events join the existing recovery operation rather than starting parallel `getUserMedia` calls.

For each recovery cycle the controller:

1. verifies that the recording generation is still active;
2. publishes the reconnecting state without setting the fatal recording error;
3. calls `enumerateDevices()`;
4. constructs the ordered physical-device candidates;
5. requests each exact candidate until one returns a live, unmuted audio track;
6. if needed, requests the default device and rejects/stops it when its resolved label is denied;
7. attaches the first accepted stream to the existing microphone pipeline;
8. resets the retry counter and publishes the restored active-device state.

If enumeration, acquisition, or pipeline attachment fails, all partial streams and audio nodes are closed before the next scheduled cycle. The same session remains recording.

### Pipeline handoff

The existing pipeline attachment helper remains responsible for creating the 24 kHz audio context, worklet processor, analyser, and track-ended listener. A replacement is built before the previous pipeline references are discarded. Publication of the new references happens atomically, and only the currently published processor may dispatch PCM chunks.

Recovery reuses the existing `onMicChunk` callback. Therefore recovered audio continues through the same main-process WAV writer and local transcription socket with the same Jarvis session id. Recovery does not reset transcript segment ids, speaker identities, cloud budget state, the recording timer, or scheduled analysis.

### State propagation

Extend the meeting recording state with a small recovery status rather than representing a temporary outage as a fatal error:

- `micRecoveryStatus: "idle" | "reconnecting" | "restored"`
- `micRecoveryAttempt: number`
- existing `activeMicLabel: string | null`
- existing `micFallbackActive: boolean`

`activeMicLabel` becomes `null` while reconnecting. `micFallbackActive` remains true when the active stream is not the saved selection. Cleanup resets all fields. No database migration is required.

## Initial acquisition

An explicitly selected device is still attempted first on start and resume. If it cannot open for a non-permission reason, Jarvis applies the same candidate filtering to choose another physical device. An explicit permission denial remains `MIC_PERMISSION` and does not enter a background retry loop.

An initial recording cannot transition to the active recording state without at least one accepted live microphone stream. Infinite recovery applies after a Jarvis recording has successfully started; this prevents creating a new session that contains no audio from its first moment.

## Error handling and concurrency

- `MIC_PERMISSION` remains fatal because retrying cannot fix denied operating-system permission.
- Runtime device absence, `NotFoundError`, `NotReadableError`, an ended track, or a denied automatic fallback is recoverable and must not stop the session.
- Only one recovery cycle and one retry timer may exist at a time.
- A late stream resolving after cancellation is stopped and never attached.
- A track that ends during pipeline construction is rejected and closed.
- A replacement that ends later starts a fresh unlimited recovery sequence.
- Pause, stop, finalize, and app shutdown invalidate the controller before closing media resources.
- Recovery logs contain attempt number, candidate label, and browser error name, but never transcript text or audio contents.

## Testing

### Policy unit tests

- Denies Sonar, VoiceMeeter, Steam, and YY labels case-insensitively.
- Does not deny Shure MV7 or Arctis Nova Pro labels.
- Orders the saved physical device before other physical inputs.
- Excludes empty labels, denied labels, and duplicate candidates.
- Produces `0`, `500`, `1000`, `2000`, `5000`, then repeated `10000` millisecond delays.

### Capture pipeline tests

- A selected track ending begins recovery without ending the Jarvis session.
- Recovery re-enumerates devices before each failed cycle.
- A Sonar default stream is stopped and not attached.
- A physical candidate is selected before a virtual default stream.
- Failed cycles continue beyond the previous one-attempt limit.
- A recovered track ending starts another recovery sequence.
- Duplicate ended events do not create parallel acquisition calls.
- Stop during a delay cancels the timer.
- Stop during `getUserMedia` discards the late stream.
- Recovery preserves the Jarvis session id and continues PCM delivery.
- Permission denial on initial start still produces `MIC_PERMISSION`.

### Renderer tests

- The recording card displays reconnecting state and attempt count without a fatal error.
- The restored active-device label replaces the reconnecting message.
- Pause and stop remain available while reconnecting.

### Hardware acceptance

- Pin Jarvis to Shure MV7 or Arctis Nova Pro.
- Start a recording and disconnect or disable the selected endpoint.
- Confirm the timer and session remain active while the UI reports reconnecting.
- Confirm Sonar is never shown as the automatically recovered active device.
- Reconnect the physical microphone and confirm audio/transcription resume in the same session.
- Repeat the disconnect/reconnect cycle at least twice.
- Stop during reconnecting and confirm no later microphone activation occurs.

## Success criteria

- A runtime microphone interruption never stops an already-started Jarvis session unless the user stops it or microphone permission is revoked.
- Automatic recovery never attaches a known virtual input.
- Recovery can survive any number of sequential track endings.
- Device candidates are refreshed on every cycle.
- Failed recovery settles at a 10-second interval and continues indefinitely without parallel retries.
- Recovered audio continues in the same WAV/transcription/session pipeline.
- Existing Jarvis, renderer, localization, type-check, build, and packaging checks pass.
