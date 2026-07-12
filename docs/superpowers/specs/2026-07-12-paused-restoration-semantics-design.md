# Paused Restoration Semantics Design

## Goal

Preserve an explicit manual pause while a reconnecting source is restored, and prevent an all-recovering paused capture from being resumed into a false recording state.

## State distinction

A paused service state has two meanings that are distinguishable from its sources:

- **Explicit manual pause:** `state.status === "paused"` and at least one source has `state === "paused"`.
- **Natural all-reconnecting pause:** `state.status === "paused"` and no source has `state === "paused"`; all requested sources are reconnecting.

Only an explicit manual pause is resumable. An all-reconnecting pause must remain paused until at least one source is restored naturally.

## Persistence design

`CaptureEvidenceStore.restoreTrack` accepts `targetState`, strictly limited to `"active"` or `"paused"`, with `"active"` as the compatibility default. Both targets use the existing SQLite transaction: validate the track and gap, close the gap, then transition the track atomically.

- `targetState: "active"` clears `audio_tracks.ended_at`.
- `targetState: "paused"` sets `audio_tracks.ended_at` to the restoration timestamp.
- Invalid target states reject before any mutation.

`CaptureEvidenceStore.resumeCapture` retains exact session-track coverage and lifecycle validation, then additionally requires at least one persisted track in `paused` state. An all-recovering exact track set rejects before the session can become `recording`.

## Service data flow

`JarvisService.resumeCapture` checks for at least one public paused source immediately after validating the session and timestamp. If none exists, it rejects before disk checks, writer creation, or repository calls. Repeated calls have the same result and leave public and durable state unchanged.

`JarvisService.sourceRestored` selects its path before writer work:

1. During an explicit manual pause, call `restoreTrack` with `targetState: "paused"` without checking capture disk space or opening a writer.
2. After persistence succeeds, apply normalized restored device metadata, clear interruption fields, and set the public source to `paused`.
3. Keep the public and durable session paused and publish the unchanged session status.
4. A later explicit resume opens every paused lane, including the restored lane, and atomically resumes their persisted track states.

During a natural all-reconnecting pause, restoration keeps the existing path: disk preflight, open the restored writer, call `restoreTrack` with the default active target, compensate the new writer if persistence fails, derive the new degraded or recording status, and persist it.

## Error handling and invariants

- Store validation occurs before gap closure, so invalid targets and stale evidence cannot partially mutate the gap or track.
- Manual-pause restoration mutates public state only after the atomic repository transaction succeeds.
- Natural restoration retains writer compensation when repository persistence fails.
- The paused session is not rewritten during manual-pause restoration because its durable state is already correct.
- Existing sequence tracking remains owned by `MultiTrackAudioWriter`; skipping writer creation during restoration lets explicit resume reopen at the next sequence exactly once.

## Tests

- A service test proves repeated all-recovering resume attempts reject without writer or repository calls and without public/durable mutations.
- Store tests prove direct all-recovering resume rejects atomically and `restoreTrack` accepts only active/paused targets while defaulting to active.
- A real-repository dual-source test covers active writes, one interruption, manual pause while degraded, paused restoration without a writer, explicit resume, successful writes on both lanes, a closed gap, recording session state, and unique contiguous per-lane sequence numbers.
- Existing focused and full Jarvis suites remain green.
