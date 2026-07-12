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
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "recovering");
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
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "recovering");
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
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "recovering");

  store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 30, recoveryAttempts: 1 });
  assert.throws(
    () => store.restoreTrack({ trackId: "t1", gapId: "g1", endedAt: 40, recoveryAttempts: 2 }),
    /recovering|open/i
  );
  assert.equal(db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, 30);
  assert.equal(db.prepare("SELECT state FROM audio_tracks WHERE id='t1'").get().state, "active");
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
  assert.deepEqual(
    db.prepare("SELECT id, state FROM audio_tracks ORDER BY id").all(),
    [
      { id: "t1", state: "recovering" },
      { id: "t2", state: "active" },
    ]
  );

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
  assert.equal(db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get().count, 0);
  assert.deepEqual(db.prepare("SELECT DISTINCT state FROM audio_tracks").all(), [{ state: "failed" }]);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='s1'").get().status, "failed");
});

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
        "SELECT session_id, track_id, chunk_id, job_type, state, input_hash, created_at FROM processing_jobs"
      )
      .get(),
    {
      session_id: "s1",
      track_id: "t1",
      chunk_id: "c1",
      job_type: "transcribe_chunk",
      state: "pending",
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

  assert.throws(
    () => store.commitChunk(chunk({ endedAt: 10, durationMs: 0 })),
    /positive/i
  );
  assert.throws(
    () =>
      store.commitChunk(
        chunk({ endedAt: 60_011, durationMs: 60_001, expiresAt: 60_011 + sevenDaysMs })
      ),
    /60000/i
  );
  assert.throws(
    () => store.commitChunk(chunk({ expiresAt: 20 + sevenDaysMs + 1 })),
    /seven days/i
  );
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
  store.commitChunk(
    chunk({ id: "c2", sequenceNumber: 1, path: "c2.wav", sha256: "def" })
  );

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
    repository.finalizeCapture({
      sessionId: "s1",
      sources: [{ trackId: "t1", gapId: null }],
      trackState: "ended",
      sessionStatus: "completed",
      at: 13,
    });
    repository.commitChunk(chunk());
    const job = repository.enqueueChunkTranscription(chunk());
    repository.tombstoneChunk("c1", 200);

    assert.equal(repository.db.prepare("SELECT state FROM audio_tracks").get().state, "ended");
    assert.equal(repository.db.prepare("SELECT ended_at FROM audio_gaps").get().ended_at, 12);
    assert.equal(repository.getSession("s1").status, "completed");
    assert.equal(job.job_type, "transcribe_chunk");
    assert.equal(repository.getAudioChunk("c1").deleted_at, 200);
  } finally {
    repository.close();
  }
});
