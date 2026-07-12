# Paused Restoration Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep manual pauses durable during source restoration and reject false resumes when every source is still recovering.

**Architecture:** Extend the existing atomic restoration transaction with a compatibility-defaulted target state. Select manual-pause versus natural-restoration behavior in `JarvisService`, and enforce resumability independently in both the public service and persistence store.

**Tech Stack:** Node.js CommonJS, `node:test`, SQLite via `better-sqlite3`, `MultiTrackAudioWriter`.

## Global Constraints

- `restoreTrack.targetState` accepts only `"active"` or `"paused"`; omitted means `"active"`.
- A session is manually paused only when public status is `paused` and at least one source is `paused`.
- All-recovering resume rejects before disk checks, writer creation, repository calls, or mutation.
- Manual-pause restoration closes the gap and changes recovering to paused atomically without opening a writer or changing session status.
- Natural all-reconnecting restoration preserves existing active restoration behavior.
- Preserve all prior focused and full Jarvis tests.

---

### Task 1: Persistence guards and restoration target

**Files:**
- Modify: `app/test/jarvis/CaptureEvidenceStore.test.js`
- Modify: `app/src/jarvis/main/CaptureEvidenceStore.js`

**Interfaces:**
- Consumes: `resumeCapture({ sessionId, sources, at })` and `restoreTrack({ trackId, gapId, endedAt, recoveryAttempts, targetState? })`.
- Produces: all-recovering resume rejection and atomic active/paused restoration.

- [ ] **Step 1: Write failing store tests**

Add a test that creates two recovering tracks with open gaps, pauses the session, calls `resumeCapture` with both expected as recovering, expects `/paused track/i`, and asserts the session remains paused, both tracks remain recovering, and both gaps remain open. Add restoration assertions for omitted/default active, explicit paused with `ended_at === endedAt`, and an invalid target that rejects before closing its gap.

- [ ] **Step 2: Run store tests to verify RED**

Run:

```text
cd app
node --test --test-name-pattern="all tracks are recovering|restoration target state" test/jarvis/CaptureEvidenceStore.test.js
```

Expected: failures because all-recovering resume currently persists recording and paused/invalid restoration targets are not enforced.

- [ ] **Step 3: Implement minimal store behavior**

Change the restoration signature and transition to:

```js
({ trackId, gapId, endedAt, recoveryAttempts = 1, targetState = "active" }) => {
  if (!new Set(["active", "paused"]).has(targetState)) {
    throw new TypeError("invalid restoration target state");
  }
  this._assertIdentifier(trackId, "trackId");
  this._assertIdentifier(gapId, "gapId");
  this._assertSafeInteger(endedAt, "restoration endedAt");
  this._assertNonNegativeSafeInteger(recoveryAttempts, "recoveryAttempts");
  const track = this.statements.getTrack.get(trackId);
  if (!track) throw new Error(`track ${trackId} does not exist`);
  const gap = this.statements.getGap.get(gapId);
  if (!gap) throw new Error(`gap ${gapId} does not exist`);
  if (gap.track_id !== trackId) throw new Error("gap track does not match transition track");
  if (track.state !== "recovering") {
    throw new Error(`track ${trackId} must be recovering before restoration`);
  }
  if (gap.ended_at !== null) throw new Error(`gap ${gapId} is not open`);
  if (endedAt < gap.started_at) {
    throw new RangeError("restoration endedAt must not be before gap startedAt");
  }
  const closed = this.closeGap(gapId, endedAt, recoveryAttempts);
  if (closed.changes !== 1) throw new Error(`gap ${gapId} is not open`);
  const updated = this.setTrackState(
    trackId,
    targetState,
    targetState === "paused" ? endedAt : null
  );
  if (updated.changes !== 1) throw new Error(`track ${trackId} was not updated`);
  return { trackId, gapId, targetState };
}
```

After `_assertLifecycleTransition` returns evidence in `resumeCaptureTransaction`, reject when `!evidence.some(({ track }) => track.state === "paused")` before any track/session updates.

- [ ] **Step 4: Run store tests to verify GREEN**

Run the Step 2 command and require all selected tests to pass.

### Task 2: Service preflight and manual-pause restoration

**Files:**
- Modify: `app/test/jarvis/JarvisService.test.js`
- Modify: `app/src/jarvis/main/JarvisService.js`

**Interfaces:**
- Consumes: persisted restoration target behavior from Task 1.
- Produces: side-effect-free all-recovering resume rejection and explicit paused restoration flow.

- [ ] **Step 1: Write failing service tests**

Add a fake-repository test that interrupts every requested source, calls `resumeCapture` twice, expects `/no paused sources/i`, and asserts no writer reopen or repository resume calls plus unchanged public/durable recovering/gap evidence. Add a real-repository dual-source test that writes both lanes, interrupts one, manually pauses, restores the interrupted lane, verifies paused state/no appendable writer, explicitly resumes, writes both lanes, and asserts session recording, closed gap, both tracks active, and per-source sequence numbers `[0, 1]` without duplicates.

- [ ] **Step 2: Run service tests to verify RED**

Run:

```text
cd app
node --test --test-name-pattern="all sources are recovering|manual pause restoration" test/jarvis/JarvisService.test.js
```

Expected: the first test observes a repository resume call/recording persistence; the real-repository test observes an active restored source and session status change before explicit resume.

- [ ] **Step 3: Implement minimal service behavior**

In `resumeCapture`, add this preflight immediately after time validation:

```js
if (!Object.values(this.state.sources).some((source) => source.state === "paused")) {
  throw new Error("capture has no paused sources to resume");
}
```

In `sourceRestored`, compute:

```js
const isManualPause =
  this.state.status === "paused" &&
  Object.values(this.state.sources).some((entry) => entry.state === "paused");
```

For `isManualPause`, call `repository.restoreTrack` with `targetState: "paused"`, then assign normalized metadata plus paused state and cleared gap/interruption fields, and publish without reopening a writer or persisting a different session status. Leave the existing active restoration path unchanged.

```js
if (isManualPause) {
  this.repository.restoreTrack({
    trackId: source.trackId,
    gapId: source.gapId,
    endedAt: restoration.at,
    recoveryAttempts: 1,
    targetState: "paused",
  });
  Object.assign(source, restored, {
    state: "paused",
    gapId: null,
    interruptedAt: null,
    reason: null,
    errorCode: null,
  });
  return this._publish(restoration.at);
}
```

- [ ] **Step 4: Run service tests to verify GREEN**

Run the Step 2 command and require both selected tests to pass.

### Task 3: Regression verification, report, and implementation commit

**Files:**
- Modify ignored report: `.superpowers/sdd/phase-1-task-4-report.md` after commit.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verified Round 4 implementation and audit evidence.

- [ ] **Step 1: Run the required focused gate**

```text
cd app
node --test test/jarvis/JarvisService.test.js test/jarvis/contracts.test.js test/jarvis/MultiTrackAudioWriter.test.js test/jarvis/AudioChunkWriter.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisRepository.test.js test/jarvis/JarvisMigrations.test.js test/jarvis/JarvisRecovery.test.js test/jarvis/GracefulShutdownCoordinator.test.js
```

- [ ] **Step 2: Run full and static gates**

```text
cd app
npm run test:jarvis
npm run typecheck
npm run lint
git diff --check
```

- [ ] **Step 3: Review and commit implementation**

Stage only the plan, service/store production files, and their tests, then commit:

```text
git commit -m "fix(jarvis): preserve manual pause during restoration"
```

- [ ] **Step 4: Append ignored Round 4 report**

Append `## Round 4 Fix` at EOF with the approved design, root cause, RED/GREEN evidence, final gate counts, files changed, and exact implementation commit hash. Confirm the worktree is clean and the report headings remain chronological.
