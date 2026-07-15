const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const ProcessingJobRunner = require("../../src/jarvis/main/ProcessingJobRunner");
const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");
const JarvisTranscriptionWorker = require("../../src/jarvis/main/JarvisTranscriptionWorker");
const { JarvisProcessingRuntime } = require("../../src/jarvis/main/JarvisProcessingRuntime");
const SpeakerProcessingPolicy = require("../../src/jarvis/main/SpeakerProcessingPolicy");
const TranscriptReconciler = require("../../src/jarvis/main/TranscriptReconciler");
const DualTrackTranscriptDeduper = require("../../src/jarvis/main/DualTrackTranscriptDeduper");
const { backfillLegacyRecordings } = require("../../src/jarvis/main/LegacyRecordingBackfill");

const NOW = 2_000;
const TEST_TRANSCRIPTION_MODEL = "fixture-no-speech";

function addLegacyChunk(repository, { id, sessionId, filePath, startedAt, format }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const pcm = Buffer.alloc(480, format === "wav" ? 1 : 2);
  const bytes =
    format === "wav"
      ? AudioEvidenceReader.wavForPcm({ bytes: pcm, sampleRate: 24_000, channels: 1 })
      : Buffer.concat([Buffer.from("fLaC"), pcm]);
  fs.writeFileSync(filePath, bytes);
  repository.insertAudioChunk({
    id,
    sessionId,
    path: filePath,
    startedAt,
    endedAt: startedAt + 500,
    durationMs: 500,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    expiresAt: 100_000,
  });
  repository.db.prepare("UPDATE audio_chunks SET format = ? WHERE id = ?").run(format, id);
}

function createSourceFixture(sourceRoot) {
  const databasePath = path.join(sourceRoot, "jarvis.db");
  const recordingsRoot = path.join(sourceRoot, "recordings");
  fs.mkdirSync(recordingsRoot, { recursive: true });
  const repository = new JarvisRepository(databasePath);
  try {
    repository.createSession({
      id: "ready-session",
      startedAt: 100,
      micDeviceId: null,
    });
    repository.setSessionStatus("ready-session", "completed", 1_000);
    repository.createSession({
      id: "blocked-session",
      startedAt: 200,
      micDeviceId: null,
    });
    repository.setSessionStatus("blocked-session", "recovered", 1_100);
    addLegacyChunk(repository, {
      id: "ready-chunk",
      sessionId: "ready-session",
      filePath: path.join(recordingsRoot, "ready-session", "speech.wav"),
      startedAt: 300,
      format: "wav",
    });
    addLegacyChunk(repository, {
      id: "blocked-chunk",
      sessionId: "blocked-session",
      filePath: path.join(recordingsRoot, "blocked-session", "speech.flac"),
      startedAt: 400,
      format: "flac",
    });
    repository.checkpointForMigration();
  } finally {
    repository.close();
  }
}

function createRuntime(repository, recordingsRoot, owner) {
  const transcriptionWorker = new JarvisTranscriptionWorker({
    repository,
    audioEvidenceReader: new AudioEvidenceReader({
      recordingsRoot,
      now: () => NOW,
    }),
    transcribeWav: async () => ({ noSpeech: true }),
    modelVersion: TEST_TRANSCRIPTION_MODEL,
    now: () => NOW,
  });
  const runner = new ProcessingJobRunner({
    store: repository.captureEvidenceStore,
    owner,
    now: () => NOW,
  });
  runner.register("transcribe_chunk", (job) => transcriptionWorker.handle(job));
  return new JarvisProcessingRuntime({
    runner,
    repository,
    reconciler: new TranscriptReconciler({ repository }),
    deduper: new DualTrackTranscriptDeduper({ repository }),
    speakerProcessingPolicy: new SpeakerProcessingPolicy({
      transcriptionInputVersion: 1,
      transcriptionModelVersion: TEST_TRANSCRIPTION_MODEL,
    }),
    prepareTranscriptionJobs: () =>
      repository.enqueueCurrentModelTranscriptionJobs({
        inputVersion: 1,
        modelVersion: TEST_TRANSCRIPTION_MODEL,
        at: NOW,
      }),
    now: () => NOW,
    maxJobsPerDrain: 10,
    maxSessionsPerDrain: 10,
  });
}

function assertTerminalAndTruthful(repository) {
  const rows = repository.db
    .prepare(
      `
      SELECT chunk.id AS chunk_id, chunk.path, chunk.format,
             chunk.track_id, chunk.transcription_status,
             job.job_type, job.state AS job_state, job.error_code,
             session.processing_state
      FROM audio_chunks AS chunk
      JOIN sessions AS session ON session.id = chunk.session_id
       LEFT JOIN processing_jobs AS job
         ON job.chunk_id = chunk.id AND job.state <> 'superseded'
      ORDER BY chunk.id
    `
    )
    .all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.track_id !== null));
  assert.ok(rows.every((row) => ["completed", "blocked"].includes(row.job_state)));
  assert.equal(rows.filter((row) => row.job_state === "blocked" && !row.error_code).length, 0);
  assert.deepEqual(
    rows.map(
      ({
        chunk_id,
        format,
        transcription_status,
        job_type,
        job_state,
        error_code,
        processing_state,
      }) => ({
        chunk_id,
        format,
        transcription_status,
        job_type,
        job_state,
        error_code,
        processing_state,
      })
    ),
    [
      {
        chunk_id: "blocked-chunk",
        format: "flac",
        transcription_status: "pending",
        job_type: "test_unsupported_transcription",
        job_state: "blocked",
        error_code: "HANDLER_MISSING",
        processing_state: "processing",
      },
      {
        chunk_id: "ready-chunk",
        format: "wav",
        transcription_status: "no_speech",
        job_type: "transcribe_chunk",
        job_state: "completed",
        error_code: null,
        processing_state: "processing",
      },
    ]
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT job_type, state, error_code
         FROM processing_jobs
         WHERE session_id = 'ready-session'
           AND job_type = 'diarize_track'`
      )
      .get(),
    {
      job_type: "diarize_track",
      state: "blocked",
      error_code: "HANDLER_MISSING",
    }
  );
  const untruthfulReady = repository.db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM sessions AS session
      JOIN processing_jobs AS job ON job.session_id = session.id
      WHERE session.processing_state = 'ready'
        AND job.chunk_id IS NOT NULL
        AND job.state NOT IN ('completed', 'superseded')
    `
    )
    .get().count;
  assert.equal(untruthfulReady, 0);
}

function assertIdempotentBackfill(result) {
  assert.equal(result.linked, 0);
  assert.equal(result.jobsCreated, 0);
  assert.ok(result.orphaned.every((candidate) => path.basename(candidate) === ".evidence-tmp"));
}

test("a copied legacy database reaches terminal truthful transcription states idempotently", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-existing-recordings-"));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  let repository;
  let runtime;
  t.after(async () => {
    await runtime?.stop();
    repository?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  createSourceFixture(sourceRoot);
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });

  const copiedDatabasePath = path.join(destinationRoot, "jarvis.db");
  const copiedRecordingsRoot = path.join(destinationRoot, "recordings");
  repository = new JarvisRepository(copiedDatabasePath);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM audio_chunks WHERE track_id IS NULL").get()
      .count,
    2
  );
  const relocateCopiedChunk = repository.db.prepare(
    "UPDATE audio_chunks SET path = ? WHERE id = ?"
  );
  relocateCopiedChunk.run(
    path.join(copiedRecordingsRoot, "ready-session", "speech.wav"),
    "ready-chunk"
  );
  relocateCopiedChunk.run(
    path.join(copiedRecordingsRoot, "blocked-session", "speech.flac"),
    "blocked-chunk"
  );
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  assert.equal(fs.existsSync(sourceRoot), false);

  const backfill = backfillLegacyRecordings({
    repository,
    recordingsRoot: copiedRecordingsRoot,
  });
  assert.deepEqual(backfill, { linked: 2, orphaned: [], jobsCreated: 2 });
  repository.db
    .prepare(
      `
      UPDATE processing_jobs
      SET job_type = 'test_unsupported_transcription'
      WHERE chunk_id = 'blocked-chunk'
    `
    )
    .run();

  runtime = createRuntime(repository, copiedRecordingsRoot, "copied-fixture-worker");
  assert.equal(await runtime.drainOnce(), 2);
  assert.equal(await runtime.drainOnce(), 1);
  assertTerminalAndTruthful(repository);
  assertIdempotentBackfill(
    backfillLegacyRecordings({ repository, recordingsRoot: copiedRecordingsRoot })
  );
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM audio_tracks").get().count, 2);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count,
    4
  );
  assert.deepEqual(
    repository.db
      .prepare(
        `SELECT job_type, state, model_version
         FROM processing_jobs
         WHERE chunk_id = 'ready-chunk' OR job_type = 'diarize_track'
         ORDER BY job_type, model_version`
      )
      .all(),
    [
      {
        job_type: "diarize_track",
        state: "blocked",
        model_version: "jarvis-session-diarization-v1",
      },
      { job_type: "transcribe_chunk", state: "superseded", model_version: "" },
      {
        job_type: "transcribe_chunk",
        state: "completed",
        model_version: TEST_TRANSCRIPTION_MODEL,
      },
    ]
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM transcript_segments").get().count,
    0
  );
  await runtime.stop();
  repository.close();

  repository = new JarvisRepository(copiedDatabasePath);
  assertIdempotentBackfill(
    backfillLegacyRecordings({ repository, recordingsRoot: copiedRecordingsRoot })
  );
  runtime = createRuntime(repository, copiedRecordingsRoot, "copied-fixture-reopen-worker");
  assert.equal(await runtime.drainOnce(), 0);
  assertTerminalAndTruthful(repository);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM audio_tracks").get().count, 2);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count,
    4
  );
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM transcript_segments").get().count,
    0
  );
  await runtime.stop();
  repository.close();
});
