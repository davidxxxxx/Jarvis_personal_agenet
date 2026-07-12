const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");
const FlacCompressionWorker = require("../../src/jarvis/main/FlacCompressionWorker");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const ENCODER_VERSION = "ffmpeg-flac-v1";

function wavFor(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function parseWav(wav) {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  return {
    bytes: wav.subarray(44),
    sampleRate: wav.readUInt32LE(24),
    channels: wav.readUInt16LE(22),
    sampleCount: wav.readUInt32LE(40) / (wav.readUInt16LE(22) * 2),
  };
}

class LosslessFixtureCodec {
  constructor() {
    this.decodeMutation = null;
  }

  async encode(inputPath, outputPath) {
    const decoded = parseWav(await fs.promises.readFile(inputPath));
    const metadata = Buffer.alloc(12);
    metadata.writeUInt32LE(decoded.sampleRate, 0);
    metadata.writeUInt32LE(decoded.channels, 4);
    metadata.writeUInt32LE(decoded.sampleCount, 8);
    await fs.promises.writeFile(
      outputPath,
      Buffer.concat([Buffer.from("fLaC"), metadata, decoded.bytes])
    );
  }

  async decode(inputPath, format) {
    if (format === "wav") return parseWav(await fs.promises.readFile(inputPath));
    const encoded = await fs.promises.readFile(inputPath);
    assert.equal(encoded.toString("ascii", 0, 4), "fLaC");
    const decoded = {
      bytes: Buffer.from(encoded.subarray(16)),
      sampleRate: encoded.readUInt32LE(4),
      channels: encoded.readUInt32LE(8),
      sampleCount: encoded.readUInt32LE(12),
    };
    if (this.decodeMutation) this.decodeMutation(decoded);
    return decoded;
  }
}

function fixture(t, { now = 100, expiresAt = 7 * 24 * 60 * 60 * 1_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flac-"));
  const db = new Database(":memory:");
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  applyJarvisMigrations(db);
  db.prepare(
    "INSERT INTO sessions (id, started_at, status, created_at) VALUES ('s1', 0, 'recording', 0)"
  ).run();
  const store = new CaptureEvidenceStore(db, {
    createId: (() => {
      let id = 0;
      return (prefix) => `${prefix}-${++id}`;
    })(),
    now: () => now,
  });
  store.createTrack({
    id: "t1",
    sessionId: "s1",
    sourceType: "mic",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    startedAt: 0,
  });
  const pcm = Buffer.alloc(SAMPLE_RATE * 2, 0x5a);
  const wavPath = path.join(root, "speech.wav");
  fs.writeFileSync(wavPath, wavFor(pcm));
  store.commitChunk({
    id: "c1",
    sessionId: "s1",
    trackId: "t1",
    sourceType: "mic",
    sequenceNumber: 0,
    path: wavPath,
    startedAt: 0,
    endedAt: 1_000,
    durationMs: 1_000,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    expiresAt,
    format: "wav",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    encoderVersion: ENCODER_VERSION,
  });
  const codec = new LosslessFixtureCodec();
  const reader = new AudioEvidenceReader({ decoder: codec });
  const makeWorker = (overrides = {}) =>
    new FlacCompressionWorker({
      store,
      recordingsRoot: root,
      encoder: codec,
      reader,
      now: () => now,
      ...overrides,
    });
  const worker = makeWorker();
  const job = db.prepare("SELECT * FROM processing_jobs WHERE job_type = 'compress_chunk'").get();
  return { root, db, store, pcm, wavPath, codec, reader, worker, makeWorker, job };
}

test("switches authority only after decoded PCM verification", async (t) => {
  const { store, pcm, wavPath, worker, job } = fixture(t);

  const result = await worker.run(job);

  assert.equal(result.chunk.format, "flac");
  assert.equal(result.chunk.pcm_sha256, crypto.createHash("sha256").update(pcm).digest("hex"));
  assert.equal(fs.existsSync(wavPath), false);
  assert.equal(fs.existsSync(result.chunk.path), true);
  assert.equal(store.getChunk("c1").format, "flac");
});

test("keeps WAV authoritative when FLAC verification fails", async (t) => {
  const { store, wavPath, codec, worker, job } = fixture(t);
  codec.decodeMutation = (decoded) => {
    decoded.bytes[0] ^= 0xff;
  };

  await assert.rejects(worker.run(job), /pcm_hash_mismatch/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac.partial")), false);
});

test("keeps transcription and compression jobs independently idempotent", (t) => {
  const { db, job } = fixture(t);

  const jobs = db
    .prepare("SELECT job_type, input_hash, model_version FROM processing_jobs ORDER BY job_type")
    .all();
  assert.deepEqual(
    jobs.map((entry) => entry.job_type),
    ["compress_chunk", "transcribe_chunk"]
  );
  assert.equal(job.input_hash, jobs[1].input_hash);
  assert.equal(job.model_version, ENCODER_VERSION);
});

test("completed compression replay is a no-op", async (t) => {
  const { worker, job } = fixture(t);
  const first = await worker.run(job);

  const replay = await worker.run(job);

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.chunk, first.chunk);
});

test("startup completes a verified partial left by a crash before rename", async (t) => {
  const { store, wavPath, makeWorker, job } = fixture(t);
  const worker = makeWorker({
    faultInjector(point) {
      if (point === "before_rename") throw new Error("simulated crash before rename");
    },
  });

  await assert.rejects(worker.run(job), /simulated crash before rename/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac")), false);
  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac.partial")), true);

  const recovered = await makeWorker().recoverStartup();

  assert.equal(recovered.promoted, 1);
  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(fs.existsSync(wavPath), false);
});

test("startup completes a verified double-file state after rename crash", async (t) => {
  const { store, wavPath, makeWorker, job } = fixture(t);
  const crashing = makeWorker({
    faultInjector(point) {
      if (point === "after_rename") throw new Error("simulated crash after rename");
    },
  });
  await assert.rejects(crashing.run(job), /simulated crash after rename/);
  const flacPath = wavPath.replace(/\.wav$/, ".flac");
  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(flacPath), true);

  const recovered = await makeWorker().recoverStartup();

  assert.equal(recovered.promoted, 1);
  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(fs.existsSync(wavPath), false);
  assert.equal(fs.existsSync(flacPath), true);
});

test("startup finishes WAV cleanup after authority transaction crash", async (t) => {
  const { store, wavPath, makeWorker, job } = fixture(t);
  const crashing = makeWorker({
    faultInjector(point) {
      if (point === "before_wav_delete") throw new Error("simulated crash before WAV delete");
    },
  });
  await assert.rejects(crashing.run(job), /simulated crash before WAV delete/);
  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(fs.existsSync(wavPath), true);

  const recovered = await makeWorker().recoverStartup();

  assert.equal(recovered.deletedWavs, 1);
  assert.equal(fs.existsSync(wavPath), false);
  assert.equal(store.getChunk("c1").format, "flac");
});

test("startup removes invalid partial and temporary FLAC files", async (t) => {
  const { wavPath, makeWorker } = fixture(t);
  const partialPath = wavPath.replace(/\.wav$/, ".flac.partial");
  const tmpPath = wavPath.replace(/\.wav$/, ".flac.tmp");
  fs.writeFileSync(partialPath, "invalid");
  fs.writeFileSync(tmpPath, "invalid");

  const recovered = await makeWorker().recoverStartup();

  assert.equal(recovered.removedInvalid, 2);
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(tmpPath), false);
});

test("startup rolls back a conflicting FLAC double-file state", async (t) => {
  const { store, wavPath, makeWorker, job } = fixture(t);
  const crashing = makeWorker({
    faultInjector(point) {
      if (point === "after_rename") throw new Error("simulated crash after rename");
    },
  });
  await assert.rejects(crashing.run(job));
  const flacPath = wavPath.replace(/\.wav$/, ".flac");
  const corrupt = fs.readFileSync(flacPath);
  corrupt[corrupt.length - 1] ^= 0xff;
  fs.writeFileSync(flacPath, corrupt);

  const recovered = await makeWorker().recoverStartup();

  assert.equal(recovered.rolledBack, 1);
  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(fs.existsSync(flacPath), false);
});

test("startup continues with valid siblings after one cleanup operation fails", async (t) => {
  const { root, db, store, pcm, wavPath, codec, reader, makeWorker } = fixture(t);
  const secondWavPath = path.join(root, "second.wav");
  fs.writeFileSync(secondWavPath, wavFor(pcm));
  store.commitChunk({
    id: "c2",
    sessionId: "s1",
    trackId: "t1",
    sourceType: "mic",
    sequenceNumber: 1,
    path: secondWavPath,
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    expiresAt: 7 * 24 * 60 * 60 * 1_000,
    format: "wav",
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    encoderVersion: ENCODER_VERSION,
  });
  fs.writeFileSync(wavPath.replace(/\.wav$/, ".flac.tmp"), "invalid");
  await codec.encode(secondWavPath, secondWavPath.replace(/\.wav$/, ".flac"));
  const fsImpl = Object.create(fs.promises);
  fsImpl.unlink = async (candidate) => {
    if (candidate === wavPath.replace(/\.wav$/, ".flac.tmp")) {
      throw new Error("simulated cleanup failure");
    }
    return fs.promises.unlink(candidate);
  };
  const worker = makeWorker({ fsImpl, reader });

  await worker.recoverStartup();

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(store.getChunk("c2").format, "flac");
  assert.equal(
    db
      .prepare(
        "SELECT state FROM processing_jobs WHERE chunk_id = 'c2' AND job_type = 'compress_chunk'"
      )
      .get().state,
    "completed"
  );
});

test("a leased transcription reads a verified temporary WAV across authority switch", async (t) => {
  const { store, wavPath, pcm, reader, worker, job } = fixture(t);
  let releaseConsume;
  let signalReady;
  const ready = new Promise((resolve) => {
    signalReady = resolve;
  });
  const release = new Promise((resolve) => {
    releaseConsume = resolve;
  });
  let leasedPath;
  const consuming = reader.withVerifiedWav(store.getChunk("c1"), async (temporaryPath) => {
    leasedPath = temporaryPath;
    signalReady();
    await release;
    return fs.promises.readFile(temporaryPath);
  });
  await ready;

  await worker.run(job);

  assert.equal(fs.existsSync(wavPath), false);
  assert.equal(fs.existsSync(leasedPath), true);
  releaseConsume();
  const leasedWav = await consuming;
  assert.deepEqual(parseWav(leasedWav).bytes, pcm);
  assert.equal(fs.existsSync(leasedPath), false);
});

test("readPlayableWav supports legacy committed rows that expose only sha256", async (t) => {
  const { wavPath, pcm, reader } = fixture(t);

  const playable = await reader.readPlayableWav({
    path: wavPath,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
  });

  assert.deepEqual(parseWav(playable).bytes, pcm);
});

test("never compresses tombstoned audio", async (t) => {
  const { store, wavPath, worker, job } = fixture(t);
  store.tombstoneChunk("c1", 200);

  await assert.rejects(worker.run(job), /audio_deleted/);

  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac")), false);
});

test("never compresses audio at its retention deadline", async (t) => {
  const { store, wavPath, worker, job } = fixture(t, { now: 1_000, expiresAt: 1_000 });

  await assert.rejects(worker.run(job), /audio_expired/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac")), false);
});

test("rejects authoritative paths outside the controlled recordings root", async (t) => {
  const { db, store, worker, job } = fixture(t);
  const outside = path.join(os.tmpdir(), `jarvis-outside-${crypto.randomUUID()}.wav`);
  fs.writeFileSync(outside, wavFor(Buffer.alloc(SAMPLE_RATE * 2, 0x5a)));
  t.after(() => fs.rmSync(outside, { force: true }));
  db.prepare("UPDATE audio_chunks SET path = ? WHERE id = 'c1'").run(outside);

  await assert.rejects(worker.run(job), /escapes recordings root/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(outside), true);
});

for (const [name, mutate, expected] of [
  ["sample rate", (decoded) => (decoded.sampleRate = 16_000), /sample_rate_mismatch/],
  ["channel count", (decoded) => (decoded.channels = 2), /channels_mismatch/],
  ["duration", (decoded) => (decoded.sampleCount += 2), /duration_mismatch/],
]) {
  test(`keeps WAV authoritative on FLAC ${name} mismatch`, async (t) => {
    const { store, wavPath, codec, worker, job } = fixture(t);
    codec.decodeMutation = mutate;

    await assert.rejects(worker.run(job), expected);

    assert.equal(store.getChunk("c1").format, "wav");
    assert.equal(fs.existsSync(wavPath), true);
  });
}

test(
  "uses bundled FFmpeg for a real lossless FLAC round trip",
  { skip: getFFmpegPath() ? false : "ffmpeg-static binary is not present in this worktree" },
  async (t) => {
    const { root, store, pcm, wavPath, job } = fixture(t);
    const reader = new AudioEvidenceReader();
    const worker = new FlacCompressionWorker({
      store,
      recordingsRoot: root,
      reader,
      now: () => 100,
    });

    const result = await worker.run(job);
    const decoded = await reader.readVerifiedPcm(result.chunk);

    assert.deepEqual(decoded.bytes, pcm);
    assert.equal(result.chunk.file_sha256.length, 64);
    assert.equal(fs.existsSync(wavPath), false);
  }
);

test("JarvisService commits production WAV metadata with a durable compression job", (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flac-service-"));
  const repository = new JarvisRepository(":memory:");
  t.after(() => {
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  repository.createSession({ id: "s1", startedAt: 0, micDeviceId: null });
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  let clock = 0;
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    now: () => clock,
    fsImpl,
  });
  t.after(() => service.shutdown());

  service.startCapture({ sessionId: "s1", startedAt: 0, micDeviceId: null });
  service.appendMicPcm("s1", Buffer.alloc(4_800, 7));
  clock = 100;
  service.finishCapture("s1", clock);

  const chunk = repository.db.prepare("SELECT * FROM audio_chunks").get();
  const jobs = repository.db
    .prepare("SELECT job_type, input_hash, model_version FROM processing_jobs ORDER BY job_type")
    .all();
  assert.equal(chunk.format, "wav");
  assert.equal(chunk.sample_rate, SAMPLE_RATE);
  assert.equal(chunk.channels, CHANNELS);
  assert.equal(chunk.file_sha256, null);
  assert.deepEqual(
    jobs.map((entry) => entry.job_type),
    ["compress_chunk", "transcribe_chunk"]
  );
  assert.equal(jobs[0].input_hash, chunk.sha256);
  assert.equal(jobs[0].model_version, ENCODER_VERSION);
});

test("JarvisService converts committed WAVs only after the capture callback returns", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flac-background-"));
  const recordingsDir = path.join(userDataDir, "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  const repository = new JarvisRepository(":memory:");
  t.after(() => {
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  repository.createSession({ id: "s1", startedAt: 0, micDeviceId: null });
  const codec = new LosslessFixtureCodec();
  const reader = new AudioEvidenceReader({ decoder: codec });
  const flacCompressionWorker = new FlacCompressionWorker({
    store: repository.captureEvidenceStore,
    recordingsRoot: recordingsDir,
    encoder: codec,
    reader,
    now: () => 100,
  });
  const fsImpl = Object.create(fs);
  fsImpl.statfsSync = () => ({ bsize: 1, blocks: 200 * 1024 ** 3, bavail: 20 * 1024 ** 3 });
  let clock = 0;
  const service = new JarvisService({
    repository,
    userDataDir,
    recordingsDir,
    broadcast() {},
    now: () => clock,
    fsImpl,
    flacCompressionWorker,
  });
  t.after(() => service.shutdown());

  service.startCapture({ sessionId: "s1", startedAt: 0, micDeviceId: null });
  service.appendMicPcm("s1", Buffer.alloc(4_800, 7));
  clock = 100;
  service.finishCapture("s1", clock);
  assert.equal(repository.db.prepare("SELECT format FROM audio_chunks").get().format, "wav");

  await service.waitForCompressionIdle();

  const compressed = repository.db.prepare("SELECT format, path FROM audio_chunks").get();
  assert.equal(compressed.format, "flac");
  assert.equal(fs.existsSync(compressed.path), true);
});

test("JarvisService starts and exposes asynchronous FLAC startup recovery", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flac-recovery-"));
  const repository = new JarvisRepository(":memory:");
  t.after(() => {
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const flacCompressionWorker = {
    async recoverStartup() {
      await pending;
      return { promoted: 1, deletedWavs: 0, removedInvalid: 0, rolledBack: 0 };
    },
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    flacCompressionWorker,
  });
  t.after(() => service.shutdown());

  const recoveredSessions = service.recoverOpenSessions(100);
  release();
  const compression = await service.waitForCompressionRecovery();

  assert.deepEqual(recoveredSessions, []);
  assert.equal(compression.promoted, 1);
});

test("rejects committed chunks whose evidence format does not match 24 kHz mono WAV", (t) => {
  const { root, store } = fixture(t);
  for (const invalid of [
    { id: "c-format", sequenceNumber: 1, format: "flac" },
    { id: "c-rate", sequenceNumber: 1, sampleRate: 16_000 },
    { id: "c-channels", sequenceNumber: 1, channels: 2 },
  ]) {
    assert.throws(
      () =>
        store.commitChunk({
          id: invalid.id,
          sessionId: "s1",
          trackId: "t1",
          sourceType: "mic",
          sequenceNumber: invalid.sequenceNumber,
          path: path.join(root, `${invalid.id}.wav`),
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          sha256: "hash",
          expiresAt: 2_000,
          format: "wav",
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          encoderVersion: ENCODER_VERSION,
          ...invalid,
        }),
      /WAV|24 kHz|mono/
    );
  }
});

test("rejects a chunk whose stored duration disagrees with decoded WAV samples", async (t) => {
  const { db, store, wavPath, worker, job } = fixture(t);
  db.prepare("UPDATE audio_chunks SET duration_ms = 999 WHERE id = 'c1'").run();

  await assert.rejects(worker.run(job), /duration_mismatch/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
});

test("rejects a junction that redirects an authoritative path outside recordings root", async (t) => {
  const { root, db, store, worker, job } = fixture(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flac-outside-dir-"));
  const junction = path.join(root, "redirect");
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(outsideDir, "speech.wav"),
    wavFor(Buffer.alloc(SAMPLE_RATE * 2, 0x5a))
  );
  try {
    fs.symlinkSync(outsideDir, junction, "junction");
  } catch (error) {
    t.skip(`junction unavailable: ${error.code}`);
    return;
  }
  db.prepare("UPDATE audio_chunks SET path = ? WHERE id = 'c1'").run(
    path.join(junction, "speech.wav")
  );

  await assert.rejects(worker.run(job), /escapes recordings root|symbolic link/);

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(path.join(outsideDir, "speech.wav")), true);
});

test("refuses a pre-existing partial hard link instead of overwriting external evidence", async (t) => {
  const { wavPath, worker, job } = fixture(t);
  const outside = path.join(os.tmpdir(), `jarvis-flac-target-${crypto.randomUUID()}`);
  const partialPath = wavPath.replace(/\.wav$/, ".flac.partial");
  fs.writeFileSync(outside, "preserve-me");
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.linkSync(outside, partialPath);

  await assert.rejects(worker.run(job), /partial_already_exists/);

  assert.equal(fs.readFileSync(outside, "utf8"), "preserve-me");
});
