const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const {
  backfillLegacyRecordings,
  runLegacyRecordingBackfillAtStartup,
} = require("../../src/jarvis/main/LegacyRecordingBackfill");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-backfill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repository(t) {
  const value = new JarvisRepository(":memory:");
  t.after(() => value.close());
  return value;
}

function addLegacyChunk(repo, { id, sessionId, filePath, startedAt, sha256 = id }) {
  fs.writeFileSync(filePath, id);
  repo.insertAudioChunk({
    id,
    sessionId,
    path: filePath,
    startedAt,
    endedAt: startedAt + 10,
    durationMs: 10,
    sha256,
    expiresAt: startedAt + 1_000,
  });
}

test("missing recordings root is an empty no-op and is not created", (t) => {
  const root = path.join(tempRoot(t), "missing");
  const repo = repository(t);

  assert.deepEqual(backfillLegacyRecordings({ repository: repo, recordingsRoot: root }), {
    linked: 0,
    orphaned: [],
    jobsCreated: 0,
  });
  assert.equal(fs.existsSync(root), false);
});

test("enumerates only direct real directories and reports conservative orphans deterministically", (t) => {
  const root = tempRoot(t);
  const repo = repository(t);
  repo.createSession({ id: "valid", startedAt: 10, micDeviceId: null });
  fs.mkdirSync(path.join(root, "valid", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "z-orphan"));
  fs.mkdirSync(path.join(root, "bad session"));
  fs.writeFileSync(path.join(root, "ordinary.wav"), "audio");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-legacy-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, "linked-session"), "junction");
  } catch {}

  const result = backfillLegacyRecordings({ repository: repo, recordingsRoot: root });

  assert.deepEqual(result.orphaned, [
    path.join(root, "bad session"),
    path.join(root, "z-orphan"),
  ]);
  assert.equal(result.linked, 0);
  assert.equal(result.jobsCreated, 0);
  assert.equal(repo.db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 1);
});

test("links only in-folder WAV and FLAC rows in stable chronology and fills only missing jobs", (t) => {
  const root = tempRoot(t);
  const repo = repository(t);
  const sessionDir = path.join(root, "s1");
  const otherDir = path.join(root, "s2");
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(otherDir);
  repo.createSession({ id: "s1", startedAt: 10, micDeviceId: null });
  repo.createSession({ id: "s2", startedAt: 20, micDeviceId: null });
  repo.createTrack({
    id: "system-track",
    sessionId: "s1",
    sourceType: "system",
    strategy: "wasapi-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
  });
  addLegacyChunk(repo, {
    id: "later",
    sessionId: "s1",
    filePath: path.join(sessionDir, "later.flac"),
    startedAt: 50,
  });
  addLegacyChunk(repo, {
    id: "earlier",
    sessionId: "s1",
    filePath: path.join(sessionDir, "earlier.wav"),
    startedAt: 30,
  });
  addLegacyChunk(repo, {
    id: "cross-folder",
    sessionId: "s1",
    filePath: path.join(otherDir, "wrong.wav"),
    startedAt: 40,
  });
  addLegacyChunk(repo, {
    id: "unsupported",
    sessionId: "s1",
    filePath: path.join(sessionDir, "unsupported.mp3"),
    startedAt: 60,
  });
  repo.db.prepare(
    `INSERT INTO processing_jobs (
      id, session_id, chunk_id, job_type, state, input_hash, created_at
    ) VALUES ('existing-job', 's1', 'earlier', 'transcribe_chunk', 'pending', 'earlier', 1)`
  ).run();

  const first = backfillLegacyRecordings({ repository: repo, recordingsRoot: root });
  const second = backfillLegacyRecordings({ repository: repo, recordingsRoot: root });

  assert.deepEqual(first, { linked: 2, orphaned: [], jobsCreated: 1 });
  assert.deepEqual(second, { linked: 0, orphaned: [], jobsCreated: 0 });
  assert.deepEqual(
    repo.db
      .prepare(
        `SELECT id, source_type, strategy, sample_rate, channels, state
         FROM audio_tracks WHERE session_id = 's1' ORDER BY source_type`
      )
      .all(),
    [
      {
        id: repo.db.prepare("SELECT id FROM audio_tracks WHERE source_type = 'mic'").get().id,
        source_type: "mic",
        strategy: "legacy_backfill",
        sample_rate: 24_000,
        channels: 1,
        state: "active",
      },
      {
        id: "system-track",
        source_type: "system",
        strategy: "wasapi-loopback",
        sample_rate: 24_000,
        channels: 1,
        state: "active",
      },
    ]
  );
  const micTrackId = repo.db
    .prepare("SELECT id FROM audio_tracks WHERE session_id = 's1' AND source_type = 'mic'")
    .get().id;
  assert.match(micTrackId, /^legacy_mic_[a-f0-9]{24}$/);
  assert.deepEqual(
    repo.db
      .prepare("SELECT id, track_id, sequence_number FROM audio_chunks ORDER BY id")
      .all(),
    [
      { id: "cross-folder", track_id: null, sequence_number: 0 },
      { id: "earlier", track_id: micTrackId, sequence_number: 0 },
      { id: "later", track_id: micTrackId, sequence_number: 1 },
      { id: "unsupported", track_id: null, sequence_number: 0 },
    ]
  );
  assert.deepEqual(
    repo.db
      .prepare("SELECT chunk_id, track_id FROM processing_jobs ORDER BY chunk_id")
      .all(),
    [
      { chunk_id: "earlier", track_id: micTrackId },
      { chunk_id: "later", track_id: micTrackId },
    ]
  );
});

test("reuses an existing microphone track and maps new legacy track lifecycle from session status", (t) => {
  const root = tempRoot(t);
  const repo = repository(t);
  const cases = [
    ["recording", "recording", "active", null],
    ["paused", "paused", "paused", null],
    ["completed", "completed", "ended", 500],
    ["recovered", "recovered", "recovered", 500],
    ["failed", "failed", "failed", 500],
  ];
  for (const [sessionId, status] of cases) {
    repo.createSession({ id: sessionId, startedAt: 10, micDeviceId: null });
    if (status !== "recording") repo.setSessionStatus(sessionId, status, 500);
    const sessionDir = path.join(root, sessionId);
    fs.mkdirSync(sessionDir);
    addLegacyChunk(repo, {
      id: `chunk-${sessionId}`,
      sessionId,
      filePath: path.join(sessionDir, `${sessionId}.wav`),
      startedAt: 20,
    });
  }
  repo.createTrack({
    id: "existing-mic",
    sessionId: "recording",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 10,
  });
  repo.commitChunk({
    id: "existing-tracked",
    sessionId: "recording",
    trackId: "existing-mic",
    sourceType: "mic",
    sequenceNumber: 7,
    path: path.join(root, "already-tracked.wav"),
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    sha256: "existing",
    expiresAt: 100,
  });

  const result = backfillLegacyRecordings({ repository: repo, recordingsRoot: root });

  assert.equal(result.linked, cases.length);
  assert.equal(result.jobsCreated, cases.length);
  assert.equal(
    repo.db.prepare("SELECT track_id FROM audio_chunks WHERE id = 'chunk-recording'").get().track_id,
    "existing-mic"
  );
  assert.deepEqual(
    repo.db
      .prepare(
        "SELECT id, sequence_number FROM audio_chunks WHERE track_id = 'existing-mic' ORDER BY sequence_number"
      )
      .all(),
    [
      { id: "existing-tracked", sequence_number: 7 },
      { id: "chunk-recording", sequence_number: 8 },
    ]
  );
  for (const [sessionId, _status, state, endedAt] of cases) {
    const track = repo.db
      .prepare("SELECT state, ended_at FROM audio_tracks WHERE session_id = ? AND source_type = 'mic'")
      .get(sessionId);
    assert.deepEqual(track, { state, ended_at: endedAt });
  }
});

test("rolls back track and links when legacy job creation fails, then retries cleanly", (t) => {
  const root = tempRoot(t);
  const repo = repository(t);
  const sessionDir = path.join(root, "transactional");
  fs.mkdirSync(sessionDir);
  repo.createSession({ id: "transactional", startedAt: 10, micDeviceId: null });
  addLegacyChunk(repo, {
    id: "transactional-chunk",
    sessionId: "transactional",
    filePath: path.join(sessionDir, "capture.wav"),
    startedAt: 20,
  });
  repo.db.exec(`
    CREATE TRIGGER reject_legacy_job_insert
    BEFORE INSERT ON processing_jobs
    BEGIN
      SELECT RAISE(ABORT, 'legacy job rejected');
    END;
  `);

  assert.throws(
    () => backfillLegacyRecordings({ repository: repo, recordingsRoot: root }),
    /legacy job rejected/i
  );
  assert.equal(repo.db.prepare("SELECT count(*) count FROM audio_tracks").get().count, 0);
  assert.equal(
    repo.db.prepare("SELECT track_id FROM audio_chunks WHERE id = 'transactional-chunk'").get()
      .track_id,
    null
  );
  repo.db.exec("DROP TRIGGER reject_legacy_job_insert");

  assert.deepEqual(backfillLegacyRecordings({ repository: repo, recordingsRoot: root }), {
    linked: 1,
    orphaned: [],
    jobsCreated: 1,
  });
});

test("startup wrapper contains failures and logs only a stable code", () => {
  const logs = [];
  const secret = "private audio path and transcript";

  const result = runLegacyRecordingBackfillAtStartup({
    repository: {},
    recordingsRoot: "X:\\recordings",
    backfillImpl: () => {
      throw new Error(secret);
    },
    log: (message, details) => logs.push({ message, details }),
  });

  assert.equal(result, null);
  assert.deepEqual(logs, [
    {
      message: "Jarvis legacy recording backfill failed",
      details: { code: "legacy_backfill_failed" },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test("startup wrapper contains logger failures after either backfill outcome", () => {
  const throwingLog = () => {
    throw new Error("logger unavailable");
  };
  assert.doesNotThrow(() =>
    runLegacyRecordingBackfillAtStartup({
      repository: {},
      recordingsRoot: "X:\\recordings",
      backfillImpl: () => ({ linked: 0, orphaned: [], jobsCreated: 0 }),
      log: throwingLog,
    })
  );
  assert.doesNotThrow(() =>
    runLegacyRecordingBackfillAtStartup({
      repository: {},
      recordingsRoot: "X:\\recordings",
      backfillImpl: () => {
        throw new Error("backfill unavailable");
      },
      log: throwingLog,
    })
  );
});
