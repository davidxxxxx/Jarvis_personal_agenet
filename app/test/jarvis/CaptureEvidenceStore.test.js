const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function fixture(t, { createId } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyJarvisMigrations(db);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s1', 10, 'recording', 10)"
  ).run();
  let nextId = 0;
  const store = new CaptureEvidenceStore(db, {
    createId: createId ?? ((prefix) => `${prefix}-${++nextId}`),
    now: () => 100,
  });
  t.after(() => db.close());
  return { db, store };
}

function createTrack(store, overrides = {}) {
  return store.createTrack({
    id: "t1",
    sessionId: "s1",
    sourceType: "system",
    deviceId: "device-1",
    deviceLabel: "PC audio",
    strategy: "wasapi-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
    ...overrides,
  });
}

function chunk(overrides = {}) {
  return {
    id: "c1",
    sessionId: "s1",
    trackId: "t1",
    sourceType: "system",
    sequenceNumber: 0,
    path: "c1.wav",
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    sha256: "abc",
    expiresAt: 30,
    ...overrides,
  };
}

function seedProcessingJob(db, overrides = {}) {
  db.prepare(
    `
    INSERT INTO processing_jobs (
      id, session_id, job_type, state, priority,
      input_hash, input_version, model_version, attempt_count,
      next_retry_at, lease_owner, lease_expires_at, error_code,
      created_at, completed_at
    ) VALUES (
      @id, 's1', @jobType, @state, @priority,
      @inputHash, @inputVersion, @modelVersion, @attemptCount,
      @nextRetryAt, @leaseOwner, @leaseExpiresAt, @errorCode,
      @createdAt, @completedAt
    )
  `
  ).run({
    id: "lease-job",
    jobType: "transcribe_chunk",
    state: "pending",
    priority: 0,
    inputHash: "lease-input",
    inputVersion: 1,
    modelVersion: "model-v1",
    attemptCount: 0,
    nextRetryAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    createdAt: 100,
    completedAt: null,
    ...overrides,
  });
}

test("stores track state and gap lifecycle evidence", (t) => {
  const { db, store } = fixture(t);

  createTrack(store);
  store.setTrackState("t1", "ended", 50);
  store.openGap({
    id: "g1",
    trackId: "t1",
    startedAt: 20,
    reason: "device_lost",
    recoveryAttempts: 1,
  });
  store.closeGap("g1", 40, 2);

  assert.deepEqual(db.prepare("SELECT * FROM audio_tracks WHERE id = 't1'").get(), {
    id: "t1",
    session_id: "s1",
    source_type: "system",
    device_id: "device-1",
    device_label: "PC audio",
    strategy: "wasapi-loopback",
    sample_rate: 24_000,
    channels: 1,
    started_at: 10,
    ended_at: 50,
    state: "ended",
  });
  assert.deepEqual(db.prepare("SELECT * FROM audio_gaps WHERE id = 'g1'").get(), {
    id: "g1",
    track_id: "t1",
    started_at: 20,
    ended_at: 40,
    reason: "device_lost",
    recovery_attempts: 2,
    restored_device_id: null,
    restored_device_label: null,
    restored_strategy: null,
    average_level: null,
    peak_level: null,
  });
});

test("creates requested tracks atomically", (t) => {
  const { db, store } = fixture(t);
  const system = {
    id: "t1",
    sessionId: "s1",
    sourceType: "system",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
  };

  assert.throws(
    () => store.createTracks([system, { ...system, sourceType: "mic" }]),
    /audio_tracks\.id/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 0);
});

test("rolls back interruption when its gap cannot be persisted", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.openGap({ id: "g1", trackId: "t1", startedAt: 11, reason: "existing" });
  store.closeGap("g1", 12, 0);

  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
      }),
    /audio_gaps\.id/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "active",
    ended_at: null,
  });
});

test("rolls back gap closure when restoration track is missing", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  assert.throws(
    () => store.restoreTrack({ trackId: "missing", gapId: "g1", endedAt: 30 }),
    /track missing/i
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );
});

test("interrupt transition rolls back track and gap when its session status write fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  db.exec(`
    CREATE TRIGGER reject_interrupt_session_status
    BEFORE UPDATE ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session status unavailable');
    END;
  `);

  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        sessionId: "s1",
        sessionStatus: "recording",
        gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
      }),
    /session status unavailable/i
  );
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "active");
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("restoration transition rolls back gap track and metadata when session status write fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  db.prepare("UPDATE sessions SET status='paused' WHERE id='s1'").run();
  db.exec(`
    CREATE TRIGGER reject_restore_session_status
    BEFORE UPDATE ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session status unavailable');
    END;
  `);

  assert.throws(
    () =>
      store.restoreTrack({
        trackId: "t1",
        gapId: "g1",
        endedAt: 30,
        sessionId: "s1",
        sessionStatus: "recording",
        deviceId: "device-2",
        deviceLabel: "Replacement output",
        strategy: "renderer-loopback",
      }),
    /session status unavailable/i
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT state, ended_at, device_id, device_label, strategy FROM audio_tracks WHERE id='t1'"
      )
      .get(),
    {
      state: "recovering",
      ended_at: 20,
      device_id: "device-1",
      device_label: "PC audio",
      strategy: "wasapi-loopback",
    }
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
});

test("restoration preserves initial track identity and timestamps replacement metadata on the gap", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  store.restoreTrack({
    trackId: "t1",
    gapId: "g1",
    endedAt: 30,
    sessionId: "s1",
    sessionStatus: "recording",
    deviceId: "device-2",
    deviceLabel: "Replacement output",
    strategy: "renderer-loopback",
  });

  assert.deepEqual(
    db
      .prepare(
        "SELECT state, ended_at, device_id, device_label, strategy FROM audio_tracks WHERE id='t1'"
      )
      .get(),
    {
      state: "active",
      ended_at: null,
      device_id: "device-1",
      device_label: "PC audio",
      strategy: "wasapi-loopback",
    }
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT ended_at, restored_device_id, restored_device_label, restored_strategy FROM audio_gaps WHERE id='g1'"
      )
      .get(),
    {
      ended_at: 30,
      restored_device_id: "device-2",
      restored_device_label: "Replacement output",
      restored_strategy: "renderer-loopback",
    }
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("rejects invalid and stale interruption evidence without mutation", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);

  for (const [name, overrides, pattern] of [
    ["unsafe time", { startedAt: 10.5 }, /safe integer/i],
    ["reversed time", { startedAt: 9 }, /before.*track/i],
    ["missing id", { id: "" }, /gap id/i],
    ["unsafe id", { id: "../g1" }, /gap id/i],
    ["wrong track", { trackId: "other" }, /does not match/i],
    ["missing reason", { reason: "" }, /reason/i],
    ["negative attempts", { recoveryAttempts: -1 }, /recoveryAttempts/i],
  ]) {
    assert.throws(
      () =>
        store.interruptTrack({
          trackId: "t1",
          gap: {
            id: "g1",
            trackId: "t1",
            startedAt: 20,
            reason: "device-change",
            recoveryAttempts: 0,
            ...overrides,
          },
        }),
      pattern,
      name
    );
  }
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "active",
    ended_at: null,
  });
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 0);

  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  assert.throws(
    () =>
      store.interruptTrack({
        trackId: "t1",
        gap: { id: "g2", trackId: "t1", startedAt: 21, reason: "duplicate" },
      }),
    /active/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps").get().count, 1);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );
});

test("rejects invalid and stale restoration evidence without mutation", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  for (const [name, overrides, pattern] of [
    ["unsafe time", { endedAt: 20.5 }, /safe integer/i],
    ["reversed time", { endedAt: 19 }, /before.*gap/i],
    ["negative attempts", { recoveryAttempts: -1 }, /recoveryAttempts/i],
    ["unsafe attempts", { recoveryAttempts: 1.5 }, /recoveryAttempts/i],
  ]) {
    assert.throws(
      () =>
        store.restoreTrack({
          trackId: "t1",
          gapId: "g1",
          endedAt: 30,
          recoveryAttempts: 1,
          ...overrides,
        }),
      pattern,
      name
    );
  }
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(
    db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state,
    "recovering"
  );

  store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 30, recoveryAttempts: 1 });
  assert.throws(
    () => store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 40, recoveryAttempts: 2 }),
    /recovering|open/i
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, 30);
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "active");
});

test("restoration target state defaults active and accepts only active or paused", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  for (const [trackId, gapId] of [
    ["t1", "g1"],
    ["t2", "g2"],
  ]) {
    store.interruptTrack({
      trackId,
      gap: { id: gapId, trackId, startedAt: 20, reason: "device-change" },
    });
  }

  const active = store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 30 });
  const paused = store.restoreTrack({
    trackId: "t2",
    gapId: "g2",
    endedAt: 31,
    targetState: "paused",
  });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g3", trackId: "t1", startedAt: 32, reason: "device-change" },
  });
  assert.throws(
    () =>
      store.restoreTrack({
        trackId: "t1",
        gapId: "g3",
        endedAt: 33,
        targetState: "recovering",
      }),
    /target state/i
  );

  assert.equal(active.targetState, "active");
  assert.equal(paused.targetState, "paused");
  assert.deepEqual(db.prepare("SELECT id, state, ended_at FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering", ended_at: 32 },
    { id: "t2", state: "paused", ended_at: 31 },
  ]);
  assert.deepEqual(db.prepare("SELECT id, ended_at FROM audio_gaps ORDER BY id").all(), [
    { id: "g1", ended_at: 30 },
    { id: "g2", ended_at: 31 },
    { id: "g3", ended_at: null },
  ]);
});

test("finalizes gaps tracks and session atomically", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });
  db.exec(`
    CREATE TRIGGER reject_session_finalization
    BEFORE UPDATE OF status ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'session finalization blocked');
    END
  `);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: "g1" }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /session finalization blocked/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "recovering",
    ended_at: 20,
  });
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "recording",
    ended_at: null,
  });
});

test("finalization requires every session track and derives every open gap", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t2", gapId: null }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /every session track/i
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "active" },
  ]);

  store.finalizeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", gapId: null },
      { trackId: "t2", gapId: null },
    ],
    trackState: "failed",
    sessionStatus: "failed",
    at: 30,
  });
  assert.equal(
    db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get().count,
    0
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "failed" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "failed");
});

test("pauses every active track and the session atomically", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  db.exec(`
    CREATE TRIGGER reject_second_track_pause
    BEFORE UPDATE OF state ON audio_tracks
    WHEN NEW.id = 't2' AND NEW.state = 'paused'
    BEGIN
      SELECT RAISE(ABORT, 'second track pause blocked');
    END
  `);

  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 20,
      }),
    /second track pause blocked/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "active" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("pause requires exact ownership coverage chronology and current states", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });

  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", expectedState: "active" }],
        at: 20,
      }),
    /every session track/i
  );
  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 20,
      }),
    /expected state/i
  );
  assert.throws(
    () =>
      store.pauseCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 9,
      }),
    /session startedAt/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "active" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("resume rolls back all track activations when session persistence fails", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "active" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 20,
  });
  db.exec(`
    CREATE TRIGGER reject_session_resume
    BEFORE UPDATE OF status ON sessions
    WHEN NEW.status = 'recording'
    BEGIN
      SELECT RAISE(ABORT, 'session resume blocked');
    END
  `);

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "paused" },
        ],
        at: 30,
      }),
    /session resume blocked/i
  );
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [
    { state: "paused" },
  ]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
});

test("resume requires exact ownership coverage chronology and current states", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "active" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 20,
  });
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s2', 10, 'paused', 10)"
  ).run();
  createTrack(store, { id: "t3", sessionId: "s2", sourceType: "mic", deviceId: "other" });
  store.setTrackState("t3", "paused", 20);

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", expectedState: "paused" }],
        at: 30,
      }),
    /every session track/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "paused" },
        ],
        at: 19,
      }),
    /track endedAt/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 30,
      }),
    /expected state/i
  );
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "paused" },
          { trackId: "t3", expectedState: "paused" },
        ],
        at: 30,
      }),
    /does not belong/i
  );
  assert.deepEqual(
    db.prepare("SELECT id, state FROM audio_tracks WHERE session_id='s1' ORDER BY id").all(),
    [
      { id: "t1", state: "paused" },
      { id: "t2", state: "paused" },
    ]
  );

  store.resumeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "paused" },
      { trackId: "t2", expectedState: "paused" },
    ],
    at: 30,
  });
  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "active" },
          { trackId: "t2", expectedState: "active" },
        ],
        at: 40,
      }),
    /must be paused/i
  );
});

test("pause and resume retain recovering tracks and their open gaps", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  store.interruptTrack({
    trackId: "t1",
    gap: { id: "g1", trackId: "t1", startedAt: 20, reason: "device-change" },
  });

  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "active" },
    ],
    at: 30,
  });
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "paused" },
  ]);
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);

  store.resumeCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "paused" },
    ],
    at: 40,
  });
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "active" },
  ]);
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, null);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("resume rejects atomically when all tracks are recovering", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  createTrack(store, { id: "t2", sourceType: "mic", deviceId: "mic-1" });
  for (const [trackId, gapId] of [
    ["t1", "g1"],
    ["t2", "g2"],
  ]) {
    store.interruptTrack({
      trackId,
      gap: { id: gapId, trackId, startedAt: 20, reason: "device-change" },
    });
  }
  store.pauseCapture({
    sessionId: "s1",
    sources: [
      { trackId: "t1", expectedState: "recovering" },
      { trackId: "t2", expectedState: "recovering" },
    ],
    at: 30,
  });

  assert.throws(
    () =>
      store.resumeCapture({
        sessionId: "s1",
        sources: [
          { trackId: "t1", expectedState: "recovering" },
          { trackId: "t2", expectedState: "recovering" },
        ],
        at: 40,
      }),
    /paused track/i
  );
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "paused");
  assert.deepEqual(db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(), [
    { id: "t1", state: "recovering" },
    { id: "t2", state: "recovering" },
  ]);
  assert.deepEqual(db.prepare("SELECT id, ended_at FROM audio_gaps ORDER BY id").all(), [
    { id: "g1", ended_at: null },
    { id: "g2", ended_at: null },
  ]);
});

test("finalization rejects timestamps before session start without tracks", (t) => {
  const { db, store } = fixture(t);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [],
        trackState: "recovered",
        sessionStatus: "recovered",
        at: 9,
      }),
    /session startedAt/i
  );
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "recording",
    ended_at: null,
  });
});

test("finalization rejects timestamps before a prior track end", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.setTrackState("t1", "paused", 30);

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: null }],
        trackState: "ended",
        sessionStatus: "completed",
        at: 29,
      }),
    /track endedAt/i
  );
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "paused",
    ended_at: 30,
  });
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "recording");
});

test("finalization rejects stale repeated terminal transitions", (t) => {
  const { db, store } = fixture(t);
  createTrack(store);
  store.finalizeCapture({
    sessionId: "s1",
    sources: [{ trackId: "t1", gapId: null }],
    trackState: "ended",
    sessionStatus: "completed",
    at: 20,
  });

  assert.throws(
    () =>
      store.finalizeCapture({
        sessionId: "s1",
        sources: [{ trackId: "t1", gapId: null }],
        trackState: "failed",
        sessionStatus: "failed",
        at: 30,
      }),
    /already terminal/i
  );
  assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
    status: "completed",
    ended_at: 20,
  });
  assert.deepEqual(db.prepare("SELECT state, ended_at FROM audio_tracks WHERE id='t1'").get(), {
    state: "ended",
    ended_at: 20,
  });
});

for (const [sessionStatus, trackState] of [
  ["recovered", "recovered"],
  ["failed", "failed"],
]) {
  test(`finalization rejects an already ${sessionStatus} session`, (t) => {
    const { db, store } = fixture(t);
    createTrack(store);
    store.finalizeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", gapId: null }],
      trackState,
      sessionStatus,
      at: 20,
    });

    assert.throws(
      () =>
        store.finalizeCapture({
          sessionId: "s1",
          sources: [{ trackId: "t1", gapId: null }],
          trackState,
          sessionStatus,
          at: 30,
        }),
      /already terminal/i
    );
    assert.deepEqual(db.prepare("SELECT status, ended_at FROM sessions WHERE id='s1'").get(), {
      status: sessionStatus,
      ended_at: 20,
    });
  });
}

test("commits a chunk and one transcription job atomically", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  store.commitChunk(chunk());

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(
    db
      .prepare("SELECT count(*) count FROM processing_jobs WHERE job_type = 'transcribe_chunk'")
      .get().count,
    1
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT track_id, source_type, sequence_number, transcription_status, write_state FROM audio_chunks"
      )
      .get(),
    {
      track_id: "t1",
      source_type: "system",
      sequence_number: 0,
      transcription_status: "pending",
      write_state: "committed",
    }
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT session_id, track_id, chunk_id, job_type, state, priority, input_hash, created_at FROM processing_jobs"
      )
      .get(),
    {
      session_id: "s1",
      track_id: "t1",
      chunk_id: "c1",
      job_type: "transcribe_chunk",
      state: "pending",
      priority: 30,
      input_hash: "abc",
      created_at: 100,
    }
  );
});

test("rejects duplicate track sequence without a partial chunk or job", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(
    () =>
      store.commitChunk(
        chunk({
          id: "c2",
          sequenceNumber: 0,
          path: "c2.wav",
          startedAt: 20,
          endedAt: 30,
          sha256: "def",
          expiresAt: 40,
        })
      ),
    /sequence/i
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
  assert.equal(db.prepare("SELECT id FROM audio_chunks").get().id, "c1");
});

test("creates distinct jobs for time-positioned chunks with identical PCM hashes", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  store.commitChunk(
    chunk({
      id: "c2",
      sequenceNumber: 1,
      path: "c2.wav",
      startedAt: 20,
      endedAt: 30,
    })
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 2);
  assert.deepEqual(
    db
      .prepare("SELECT chunk_id FROM processing_jobs ORDER BY chunk_id")
      .all()
      .map((row) => row.chunk_id),
    ["c1", "c2"]
  );
});

test("rolls back transcription creation when the chunk insert fails", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(() =>
    store.commitChunk(
      chunk({
        id: "c2",
        sequenceNumber: 1,
        path: "c1.wav",
        sha256: "def",
      })
    )
  );

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("rolls back the inserted chunk when job creation fails", (t) => {
  const { store, db } = fixture(t, { createId: () => "job-fixed" });
  createTrack(store);
  db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state,
      input_hash, input_version, model_version, created_at
    ) VALUES (
      'job-fixed', 's1', 't1', NULL, 'seed_job', 'pending', 'seed', 1, '', 1
    )`
  ).run();

  assert.throws(() => store.commitChunk(chunk()), /processing_jobs\.id/i);

  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("enqueueChunkTranscription is idempotent by transcription input", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  db.prepare(
    `INSERT INTO audio_chunks (
      id, session_id, track_id, source_type, sequence_number, path,
      started_at, ended_at, duration_ms, sha256, expires_at,
      transcription_status, write_state
    ) VALUES (
      @id, @sessionId, @trackId, @sourceType, @sequenceNumber, @path,
      @startedAt, @endedAt, @durationMs, @sha256, @expiresAt,
      'pending', 'committed'
    )`
  ).run(chunk());

  const first = store.enqueueChunkTranscription(chunk());
  const duplicate = store.enqueueChunkTranscription(chunk());

  assert.equal(first.id, "job-1");
  assert.equal(duplicate.id, first.id);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("rejects every transcription enqueue after a chunk is tombstoned", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  store.tombstoneChunk("c1", 200);

  assert.throws(() => store.enqueueChunkTranscription(chunk()), /deleted/i);
  assert.throws(
    () =>
      store.enqueueChunkTranscription(
        chunk({ inputVersion: 2, modelVersion: "replacement-model" })
      ),
    /deleted/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE chunk_id = 'c1'").get().state,
    "audio_expired_before_processing"
  );
});

test("rejects chunks whose track session or source does not match", (t) => {
  const { store, db } = fixture(t);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s2', 10, 'recording', 10)"
  ).run();
  createTrack(store);

  assert.throws(() => store.commitChunk(chunk({ sessionId: "s2" })), /session/i);
  assert.throws(() => store.commitChunk(chunk({ sourceType: "mic" })), /source/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects a chunk that starts before its persisted track or session", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () => store.commitChunk(chunk({ startedAt: 9, endedAt: 19, durationMs: 10, expiresAt: 30 })),
    /before.*track or session/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects a chunk that ends after its persisted track or session", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.setTrackState("t1", "ended", 20);
  db.prepare("UPDATE sessions SET status='completed', ended_at=20 WHERE id='s1'").run();

  assert.throws(
    () => store.commitChunk(chunk({ startedAt: 20, endedAt: 21, durationMs: 1, expiresAt: 30 })),
    /after.*track or session/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects enqueue metadata that does not match the persisted chunk", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());

  assert.throws(() => store.enqueueChunkTranscription(chunk({ sessionId: "other" })), /session/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ trackId: "other" })), /track/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ sourceType: "mic" })), /source/i);
  assert.throws(() => store.enqueueChunkTranscription(chunk({ sha256: "other" })), /hash/i);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 1);
});

test("accepts only 24 kHz mono evidence tracks", (t) => {
  const { store, db } = fixture(t);

  assert.throws(() => createTrack(store, { sampleRate: 16_000 }), /24 kHz/i);
  assert.throws(() => createTrack(store, { channels: 2 }), /mono/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 0);
});

test("rejects invalid chunk duration and retention deadlines", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  assert.throws(() => store.commitChunk(chunk({ endedAt: 10, durationMs: 0 })), /positive/i);
  assert.throws(
    () =>
      store.commitChunk(
        chunk({ endedAt: 60_011, durationMs: 60_001, expiresAt: 60_011 + sevenDaysMs })
      ),
    /60000/i
  );
  assert.throws(() => store.commitChunk(chunk({ expiresAt: 20 + sevenDaysMs + 1 })), /seven days/i);
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("rejects an actual capture span over 60000 ms", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () =>
      store.commitChunk(
        chunk({ startedAt: 10, endedAt: 120_010, durationMs: 60_000, expiresAt: 120_020 })
      ),
    /capture span.*60000/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("requires durationMs to equal the integer capture span", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);

  assert.throws(
    () => store.commitChunk(chunk({ endedAt: 30, durationMs: 19, expiresAt: 40 })),
    /durationMs.*capture span/i
  );
  assert.equal(db.prepare("SELECT count(*) count FROM audio_chunks").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM processing_jobs").get().count, 0);
});

test("tombstones multiple chunks once while retaining evidence metadata", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  store.commitChunk(chunk({ id: "c2", sequenceNumber: 1, path: "c2.wav", sha256: "def" }));

  assert.equal(store.tombstoneChunk("c1", 200).changes, 1);
  assert.equal(store.tombstoneChunk("c2", 201).changes, 1);
  assert.equal(store.tombstoneChunk("c1", 300).changes, 0);

  const rows = db.prepare("SELECT * FROM audio_chunks ORDER BY id").all();
  assert.equal(rows[0].path, "tombstone:c1");
  assert.equal(rows[0].deleted_at, 200);
  assert.equal(rows[0].sha256, "abc");
  assert.equal(rows[0].started_at, 10);
  assert.equal(rows[1].path, "tombstone:c2");
  assert.equal(rows[1].deleted_at, 201);
});

test("tombstoning atomically expires unfinished chunk jobs without rewriting terminal jobs", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const inputs = [
    ["pending", "pending", null],
    ["running", "running", null],
    ["retry", "retry", null],
    ["completed", "completed", 88],
    ["failed", "failed", 89],
  ];
  inputs.forEach(([id], index) => {
    store.commitChunk(
      chunk({
        id: `c-${id}`,
        sequenceNumber: index,
        path: `${id}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: id,
        expiresAt: 100,
      })
    );
  });
  for (const [id, state, completedAt] of inputs) {
    db.prepare(
      `UPDATE processing_jobs
       SET state = ?, completed_at = ?, lease_owner = 'worker', lease_expires_at = 999,
           next_retry_at = 500
       WHERE chunk_id = ?`
    ).run(state, completedAt, `c-${id}`);
  }
  db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, track_id, chunk_id, job_type, state, input_hash, created_at
    ) VALUES ('diarize-pending', 's1', 't1', 'c-pending', 'diarize_chunk', 'pending', 'diarize', 1)`
  ).run();

  for (const [id] of inputs) store.tombstoneChunk(`c-${id}`, 200);

  const jobs = db
    .prepare(
      `SELECT chunk_id, state, error_code, completed_at, lease_owner, lease_expires_at,
              next_retry_at
       FROM processing_jobs ORDER BY chunk_id`
    )
    .all();
  for (const row of jobs.filter((job) =>
    ["c-pending", "c-retry", "c-running"].includes(job.chunk_id)
  )) {
    assert.equal(row.state, "audio_expired_before_processing");
    assert.equal(row.error_code, "audio_expired_before_processing");
    assert.equal(row.completed_at, 200);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.next_retry_at, null);
  }
  assert.equal(jobs.filter((job) => job.chunk_id === "c-pending").length, 2);
  assert.deepEqual(
    jobs.find((job) => job.chunk_id === "c-completed"),
    {
      chunk_id: "c-completed",
      state: "completed",
      error_code: null,
      completed_at: 88,
      lease_owner: "worker",
      lease_expires_at: 999,
      next_retry_at: 500,
    }
  );
  assert.equal(jobs.find((job) => job.chunk_id === "c-failed").state, "failed");
});

test("promotes only unfinished transcription jobs strictly inside the 24-hour urgency range", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  const expiries = [100, 101, 200, 201];
  expiries.forEach((expiresAt, index) => {
    store.commitChunk(
      chunk({
        id: `c${index}`,
        sequenceNumber: index,
        path: `c${index}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: `hash${index}`,
        expiresAt,
      })
    );
  });
  db.prepare(
    "UPDATE processing_jobs SET state = 'completed', completed_at = 50 WHERE chunk_id = 'c2'"
  ).run();

  assert.equal(store.promoteSoonExpiringAudioJobs(100, 200), 1);
  assert.equal(store.promoteSoonExpiringAudioJobs(100, 200), 0);
  assert.deepEqual(
    db.prepare("SELECT chunk_id, state, priority FROM processing_jobs ORDER BY chunk_id").all(),
    [
      { chunk_id: "c0", state: "pending", priority: 30 },
      { chunk_id: "c1", state: "retention_urgent", priority: 0 },
      { chunk_id: "c2", state: "completed", priority: 30 },
      { chunk_id: "c3", state: "pending", priority: 30 },
    ]
  );
});

test("promotes live WAV compression jobs for storage recovery idempotently", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  for (let index = 0; index < 4; index += 1) {
    store.commitChunk(
      chunk({
        id: `c${index}`,
        sequenceNumber: index,
        path: `c${index}.wav`,
        startedAt: 10 + index * 10,
        endedAt: 20 + index * 10,
        sha256: `hash${index}`,
        expiresAt: 1_000,
        encoderVersion: "flac-v1",
      })
    );
  }
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'retry', next_retry_at = 900, blocked_reason = 'resource_busy',
         error_code = 'PRIOR_FAILURE'
     WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'`
  ).run();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'running', lease_owner = 'worker-a', lease_expires_at = 900
     WHERE chunk_id = 'c2' AND job_type = 'compress_chunk'`
  ).run();
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 90
     WHERE chunk_id = 'c3' AND job_type = 'compress_chunk'`
  ).run();

  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 2);
  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 0);
  assert.deepEqual(
    db
      .prepare(
        `SELECT chunk_id, state, priority, next_retry_at, blocked_reason, error_code
         FROM processing_jobs
         WHERE job_type = 'compress_chunk'
         ORDER BY chunk_id`
      )
      .all(),
    [
      {
        chunk_id: "c0",
        state: "storage_recovery_compress",
        priority: 10,
        next_retry_at: 100,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c1",
        state: "storage_recovery_compress",
        priority: 10,
        next_retry_at: 100,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c2",
        state: "running",
        priority: 60,
        next_retry_at: null,
        blocked_reason: null,
        error_code: null,
      },
      {
        chunk_id: "c3",
        state: "completed",
        priority: 60,
        next_retry_at: null,
        blocked_reason: null,
        error_code: null,
      },
    ]
  );
});

test("storage pressure preserves backoff after an already-promoted job is deferred", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(
    chunk({
      expiresAt: 1_000,
      encoderVersion: "flac-v1",
    })
  );
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 50
     WHERE chunk_id = 'c1' AND job_type = 'transcribe_chunk'`
  ).run();

  assert.equal(store.promoteCompressionJobsForStoragePressure(100), 1);
  const [claimed] = store.claimJobs({ owner: "worker-a", at: 100, leaseMs: 100, limit: 1 });
  assert.equal(claimed.job_type, "compress_chunk");
  assert.equal(
    store.deferJob(claimed.id, {
      owner: "worker-a",
      at: 101,
      nextRetryAt: 116,
      reason: "cpu_load_high",
    }),
    true
  );

  assert.equal(store.promoteCompressionJobsForStoragePressure(102), 0);
  assert.deepEqual(
    db
      .prepare(
        `SELECT state, priority, next_retry_at, blocked_reason, error_code
         FROM processing_jobs WHERE id = ?`
      )
      .get(claimed.id),
    {
      state: "retry",
      priority: 10,
      next_retry_at: 116,
      blocked_reason: "cpu_load_high",
      error_code: null,
    }
  );
});

test("leased FLAC promotion rejects expiry and leaves terminal ownership to the runner", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk({ expiresAt: 1_000, encoderVersion: "flac-v1" }));
  db.prepare(
    `UPDATE processing_jobs
     SET state = 'completed', completed_at = 50
     WHERE chunk_id = 'c1' AND job_type = 'transcribe_chunk'`
  ).run();
  const compressionJob = db
    .prepare("SELECT id FROM processing_jobs WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'")
    .get();
  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 100, leaseMs: 100, limit: 1 })[0].id,
    compressionJob.id
  );
  const promotion = {
    chunkId: "c1",
    jobId: compressionJob.id,
    owner: "worker-a",
    encoderVersion: "flac-v1",
    pcmSha256: "abc",
    wavPath: "c1.wav",
    flacPath: "c1.flac",
    fileSha256: "def",
    fileBytes: 40,
    sampleRate: 24_000,
    channels: 1,
  };

  assert.equal(store.promoteLeasedChunkToFlac({ ...promotion, completedAt: 200 }), null);
  assert.deepEqual(db.prepare("SELECT path, format FROM audio_chunks WHERE id = 'c1'").get(), {
    path: "c1.wav",
    format: "wav",
  });

  assert.equal(store.recoverExpiredLeases(200), 1);
  assert.equal(
    store.claimJobs({ owner: "worker-a", at: 200, leaseMs: 100, limit: 1 })[0].id,
    compressionJob.id
  );
  const promoted = store.promoteLeasedChunkToFlac({ ...promotion, completedAt: 201 });
  assert.equal(promoted.format, "flac");
  assert.deepEqual(
    db
      .prepare("SELECT state, lease_owner, completed_at FROM processing_jobs WHERE id = ?")
      .get(compressionJob.id),
    { state: "running", lease_owner: "worker-a", completed_at: null }
  );
  assert.equal(
    store.completeJob(compressionJob.id, {
      owner: "worker-a",
      at: 202,
      executionDevice: "cpu",
    }),
    true
  );
  assert.equal(
    store.completeJob(compressionJob.id, {
      owner: "worker-a",
      at: 203,
      executionDevice: "cpu",
    }),
    false
  );
});

test("records idempotent signed storage growth and deletion telemetry in evidence transactions", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(
    chunk({
      expiresAt: 1_000,
      fileBytes: 144,
      encoderVersion: "test-flac-v1",
    })
  );
  const job = db
    .prepare("SELECT id FROM processing_jobs WHERE chunk_id = 'c1' AND job_type = 'compress_chunk'")
    .get();
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT job_type, priority
      FROM processing_jobs WHERE chunk_id = 'c1' ORDER BY job_type
    `
      )
      .all(),
    [
      { job_type: "compress_chunk", priority: 60 },
      { job_type: "transcribe_chunk", priority: 30 },
    ]
  );

  store.promoteChunkToFlac({
    chunkId: "c1",
    jobId: job.id,
    encoderVersion: "test-flac-v1",
    pcmSha256: "abc",
    wavPath: "c1.wav",
    flacPath: "c1.flac",
    fileSha256: "def",
    fileBytes: 40,
    sampleRate: 24_000,
    channels: 1,
    completedAt: 200,
  });
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, blocked_reason, error_code, execution_device
      FROM processing_jobs WHERE id = ?
    `
      )
      .get(job.id),
    {
      state: "completed",
      blocked_reason: null,
      error_code: null,
      execution_device: "cpu",
    }
  );
  db.prepare(
    `
    UPDATE audio_chunks
    SET retired_path = 'c1.wav', retired_format = 'wav',
        retired_file_sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    WHERE id = 'c1'
  `
  ).run();
  const retiredIdentity = {
    chunkId: "c1",
    retiredPath: "c1.wav",
    retiredFileSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    occurredAt: 201,
  };
  assert.equal(store.clearRetiredArtifact(retiredIdentity), 1);
  assert.equal(store.clearRetiredArtifact(retiredIdentity), 0);
  assert.equal(store.tombstoneChunk("c1", 202, { storageDeleted: true }).changes, 1);
  assert.equal(store.tombstoneChunk("c1", 203, { storageDeleted: true }).changes, 0);

  assert.deepEqual(
    db
      .prepare(
        `
      SELECT kind, chunk_id, bytes, delta_bytes, occurred_at
      FROM storage_usage_events ORDER BY occurred_at
    `
      )
      .all(),
    [
      { kind: "wav_written", chunk_id: "c1", bytes: 144, delta_bytes: 144, occurred_at: 20 },
      { kind: "flac_written", chunk_id: "c1", bytes: 40, delta_bytes: 40, occurred_at: 200 },
      {
        kind: "retired_deleted",
        chunk_id: "c1",
        bytes: 144,
        delta_bytes: -144,
        occurred_at: 201,
      },
      {
        kind: "retention_deleted",
        chunk_id: "c1",
        bytes: 40,
        delta_bytes: -40,
        occurred_at: 202,
      },
    ]
  );
});

test("rolls back a tombstone when unfinished job termination fails", (t) => {
  const { store, db } = fixture(t);
  createTrack(store);
  store.commitChunk(chunk());
  db.exec(`
    CREATE TRIGGER reject_retention_job_update
    BEFORE UPDATE ON processing_jobs
    BEGIN
      SELECT RAISE(ABORT, 'job update rejected');
    END;
  `);

  assert.throws(() => store.tombstoneChunk("c1", 200), /job update rejected/i);
  assert.deepEqual(db.prepare("SELECT path, deleted_at FROM audio_chunks WHERE id = 'c1'").get(), {
    path: "c1.wav",
    deleted_at: null,
  });
  assert.equal(
    db.prepare("SELECT state FROM processing_jobs WHERE chunk_id = 'c1'").get().state,
    "pending"
  );
});

test("JarvisRepository delegates the complete capture evidence interface", () => {
  const repository = new JarvisRepository(":memory:");
  try {
    repository.createSession({ id: "s1", startedAt: 10, micDeviceId: null });
    repository.createTrack({
      id: "t1",
      sessionId: "s1",
      sourceType: "system",
      strategy: "wasapi-loopback",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 10,
    });
    repository.createTracks([]);
    repository.interruptTrack({
      trackId: "t1",
      gap: { id: "g1", trackId: "t1", startedAt: 11, reason: "device_lost" },
    });
    repository.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 12, recoveryAttempts: 1 });
    repository.pauseCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", expectedState: "active" }],
      at: 12,
    });
    repository.resumeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", expectedState: "paused" }],
      at: 12,
    });
    repository.finalizeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", gapId: null }],
      trackState: "ended",
      sessionStatus: "completed",
      at: 20,
    });
    repository.commitChunk(chunk({ fileBytes: 144 }));
    const job = repository.enqueueChunkTranscription(chunk());
    repository.tombstoneChunk("c1", 200);

    assert.equal(repository.db.prepare("SELECT state FROM audio_tracks").get().state, "ended");
    assert.equal(repository.db.prepare("SELECT ended_at FROM audio_gaps").get().ended_at, 12);
    assert.equal(repository.getSession("s1").status, "completed");
    assert.equal(job.job_type, "transcribe_chunk");
    assert.equal(repository.getAudioChunk("c1").deleted_at, 200);
    assert.deepEqual(repository.getStorageUsageSince(20), {
      writtenBytes24h: 144,
      compressedBytes24h: 0,
      netGrowthBytes24h: 144,
    });
    assert.deepEqual(repository.getStorageUsageSince(21), {
      writtenBytes24h: 0,
      compressedBytes24h: 0,
      netGrowthBytes24h: 0,
    });
    assert.deepEqual(
      repository.listRetiredArtifactBacklog().map((row) => ({
        id: row.id,
        retired_path: row.retired_path,
        retired_file_sha256: row.retired_file_sha256,
      })),
      [{ id: "c1", retired_path: "c1.wav", retired_file_sha256: null }]
    );
    assert.equal(Object.hasOwn(repository.getAudioChunk("c1"), "retired_path"), false);
  } finally {
    repository.close();
  }
});

test("claims eligible jobs atomically in deterministic order without stealing leases", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, { id: "job-b", priority: 30, createdAt: 100 });
  seedProcessingJob(db, {
    id: "job-a",
    priority: 30,
    createdAt: 100,
    inputHash: "input-a",
  });
  seedProcessingJob(db, {
    id: "job-urgent",
    state: "retention_urgent",
    priority: 0,
    createdAt: 999,
    inputHash: "input-urgent",
  });
  seedProcessingJob(db, {
    id: "job-compress",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    createdAt: 50,
    inputHash: "input-compress",
  });
  seedProcessingJob(db, {
    id: "job-current",
    state: "running",
    inputHash: "input-current",
    leaseOwner: "worker-a",
    leaseExpiresAt: 501,
  });
  seedProcessingJob(db, {
    id: "job-later",
    state: "retry",
    inputHash: "input-later",
    nextRetryAt: 501,
  });

  const claimed = store.claimJobs({ owner: "worker-b", at: 500, leaseMs: 100, limit: 4 });

  assert.deepEqual(
    claimed.map((job) => job.id),
    ["job-urgent", "job-compress", "job-a", "job-b"]
  );
  for (const job of claimed) {
    assert.equal(job.state, "running");
    assert.equal(job.attempt_count, 1);
    assert.equal(job.lease_owner, "worker-b");
    assert.equal(job.lease_expires_at, 600);
  }
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, lease_owner, lease_expires_at
      FROM processing_jobs WHERE id IN ('job-current', 'job-later') ORDER BY id
    `
      )
      .all(),
    [
      { id: "job-current", state: "running", lease_owner: "worker-a", lease_expires_at: 501 },
      { id: "job-later", state: "retry", lease_owner: null, lease_expires_at: null },
    ]
  );
});

test("claims by durable priority even when a lower-priority state was deferred", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    id: "retention-first",
    state: "retry",
    priority: 0,
    nextRetryAt: 500,
    inputHash: "retention-input",
  });
  seedProcessingJob(db, {
    id: "storage-second",
    jobType: "compress_chunk",
    state: "storage_recovery_compress",
    priority: 10,
    nextRetryAt: 500,
    inputHash: "storage-input",
  });

  assert.deepEqual(
    store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 2 }).map((job) => job.id),
    ["retention-first", "storage-second"]
  );
});

test("rolls back every claim when a later lease update fails", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, { id: "job-a", inputHash: "input-a" });
  seedProcessingJob(db, { id: "job-b", inputHash: "input-b" });
  db.exec(`
    CREATE TRIGGER reject_second_job_claim
    BEFORE UPDATE OF state ON processing_jobs
    WHEN OLD.id = 'job-b' AND NEW.state = 'running'
    BEGIN
      SELECT RAISE(ABORT, 'second claim rejected');
    END;
  `);

  assert.throws(
    () => store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 2 }),
    /second claim rejected/i
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT id, state, attempt_count, lease_owner, lease_expires_at
      FROM processing_jobs ORDER BY id
    `
      )
      .all(),
    [
      {
        id: "job-a",
        state: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
      {
        id: "job-b",
        state: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
      },
    ]
  );
});

test("rejects stale lease owners and keeps terminal transitions idempotent", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "running",
    attemptCount: 1,
    leaseOwner: "worker-old",
    leaseExpiresAt: 150,
  });

  assert.equal(store.recoverExpiredLeases(200), 1);
  assert.equal(
    store.claimJobs({ owner: "worker-new", at: 200, leaseMs: 100, limit: 1 })[0].lease_owner,
    "worker-new"
  );
  assert.equal(store.completeJob("lease-job", { owner: "worker-old", at: 210 }), false);
  assert.equal(
    store.retryJob("lease-job", {
      owner: "worker-old",
      at: 210,
      nextRetryAt: 220,
      errorCode: "STALE",
    }),
    false
  );
  assert.equal(
    store.blockJob("lease-job", { owner: "worker-old", at: 210, errorCode: "STALE" }),
    false
  );
  assert.deepEqual(
    db.prepare("SELECT state, lease_owner FROM processing_jobs WHERE id = 'lease-job'").get(),
    { state: "running", lease_owner: "worker-new" }
  );

  assert.equal(store.completeJob("lease-job", { owner: "worker-new", at: 230 }), true);
  assert.equal(store.completeJob("lease-job", { owner: "worker-new", at: 231 }), false);
  assert.equal(
    store.retryJob("lease-job", {
      owner: "worker-new",
      at: 231,
      nextRetryAt: 231,
      errorCode: "TOO_LATE",
    }),
    false
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, completed_at, lease_owner, lease_expires_at, error_code
      FROM processing_jobs WHERE id = 'lease-job'
    `
      )
      .get(),
    {
      state: "completed",
      completed_at: 230,
      lease_owner: null,
      lease_expires_at: null,
      error_code: null,
    }
  );
});

test("resource deferral releases the lease without consuming an attempt or retaining an error", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db, {
    state: "retry",
    attemptCount: 2,
    nextRetryAt: 400,
    errorCode: "PRIOR_FAILURE",
  });
  const before = db
    .prepare(
      `SELECT input_hash, input_version, model_version, priority FROM processing_jobs WHERE id = ?`
    )
    .get("lease-job");
  const [claimed] = store.claimJobs({ owner: "worker-a", at: 500, leaseMs: 100, limit: 1 });
  assert.equal(claimed.attempt_count, 3);

  assert.equal(
    store.deferJob("lease-job", {
      owner: "worker-a",
      at: 510,
      reason: "external_gpu_busy",
    }),
    true
  );
  assert.deepEqual(
    db
      .prepare(
        `
      SELECT state, attempt_count, next_retry_at, blocked_reason, error_code,
             lease_owner, lease_expires_at, completed_at,
             input_hash, input_version, model_version, priority
      FROM processing_jobs WHERE id = 'lease-job'
    `
      )
      .get(),
    {
      state: "retry",
      attempt_count: 2,
      next_retry_at: 15_510,
      blocked_reason: "external_gpu_busy",
      error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: null,
      ...before,
    }
  );
  assert.equal(
    store.deferJob("lease-job", {
      owner: "worker-a",
      at: 511,
      reason: "external_gpu_busy",
    }),
    false
  );
});

test("validates processing-job lease boundaries before touching durable state", (t) => {
  const { db, store } = fixture(t);
  seedProcessingJob(db);

  assert.throws(
    () => store.claimJobs({ owner: "", at: 100, leaseMs: 10, limit: 1 }),
    /owner.*safe identifier/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: -1, leaseMs: 10, limit: 1 }),
    /at.*non-negative/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: 100, leaseMs: 0, limit: 1 }),
    /leaseMs.*positive/i
  );
  assert.throws(
    () => store.claimJobs({ owner: "worker", at: 100, leaseMs: 10, limit: 0 }),
    /limit.*positive/i
  );
  assert.throws(
    () =>
      store.retryJob("lease-job", {
        owner: "worker",
        at: 100,
        nextRetryAt: 99,
        errorCode: "FAILED",
      }),
    /nextRetryAt.*before/i
  );
  assert.throws(
    () => store.retryJob("lease-job", { owner: "worker", at: 100 }),
    /errorCode.*safe identifier/i
  );
  assert.deepEqual(
    db.prepare("SELECT state, attempt_count FROM processing_jobs WHERE id = 'lease-job'").get(),
    { state: "pending", attempt_count: 0 }
  );
});
