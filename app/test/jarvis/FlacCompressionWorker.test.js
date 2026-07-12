const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const Database = require("better-sqlite3");
const CaptureEvidenceStore = require("../../src/jarvis/main/CaptureEvidenceStore");
const { applyJarvisMigrations } = require("../../src/jarvis/main/JarvisMigrations");
const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");
const {
  FfmpegPcmDecoder,
  isTransientIoError,
  parsePcmWav,
} = require("../../src/jarvis/main/AudioEvidenceReader");
const FlacCompressionWorker = require("../../src/jarvis/main/FlacCompressionWorker");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");
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

for (const retired of ["expired", "tombstoned"]) {
  test(`completed compression replay is an immediate no-op when audio is ${retired}`, async (t) => {
    const { db, store, worker, job } = fixture(t);
    const first = await worker.run(job);
    if (retired === "expired") {
      db.prepare("UPDATE audio_chunks SET expires_at = 100 WHERE id = 'c1'").run();
    } else {
      store.tombstoneChunk("c1", 100);
    }

    const replay = await worker.run(job);

    assert.equal(replay.replayed, true);
    assert.equal(replay.chunk.id, first.chunk.id);
  });
}

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

for (const damage of ["missing", "corrupt"]) {
  test(`startup rolls ${damage} authoritative FLAC back to a verified WAV and retries`, async (t) => {
    const { db, store, pcm, wavPath, worker, makeWorker, job } = fixture(t);
    const compressed = await worker.run(job);
    fs.writeFileSync(wavPath, wavFor(pcm));
    if (damage === "missing") fs.unlinkSync(compressed.chunk.path);
    else fs.writeFileSync(compressed.chunk.path, "corrupt-flac");

    const recovered = await makeWorker().recoverStartup();

    const chunk = store.getChunk("c1");
    const retried = db
      .prepare("SELECT state, completed_at, error_code FROM processing_jobs WHERE id = ?")
      .get(job.id);
    assert.equal(chunk.format, "wav");
    assert.equal(chunk.path, wavPath);
    assert.deepEqual(retried, {
      state: "retry",
      completed_at: null,
      error_code: "flac_authority_invalid_recovered",
    });
    assert.equal(recovered.rolledBack, 1);
  });
}

test("corrupt FLAC rollback deletes its proven retired file before immediate retry", async (t) => {
  const { db, store, pcm, wavPath, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  fs.writeFileSync(wavPath, wavFor(pcm));
  fs.writeFileSync(compressed.chunk.path, "corrupt-flac-for-retry");

  await makeWorker().recoverStartup();
  const retried = db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(job.id);
  const result = await makeWorker().run(retried);

  assert.equal(result.chunk.format, "flac");
  assert.equal(fs.existsSync(wavPath), false);
  assert.equal(store.getChunkForMaintenance("c1").retired_path, null);
});

test("failed corrupt-FLAC deletion persists exact provenance for expiry startup retry", async (t) => {
  const { db, pcm, wavPath, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  fs.writeFileSync(wavPath, wavFor(pcm));
  fs.writeFileSync(compressed.chunk.path, "corrupt-flac-held-open");
  const actualFileSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(compressed.chunk.path))
    .digest("hex");
  const fsImpl = Object.create(fs.promises);
  fsImpl.unlink = async (candidate) => {
    if (candidate === compressed.chunk.path) {
      const error = new Error("simulated sharing violation");
      error.code = "EPERM";
      throw error;
    }
    return fs.promises.unlink(candidate);
  };

  await makeWorker({ fsImpl }).recoverStartup();

  assert.deepEqual(
    db
      .prepare(
        "SELECT format, retired_path, retired_format, retired_file_sha256 FROM audio_chunks WHERE id = 'c1'"
      )
      .get(),
    {
      format: "wav",
      retired_path: compressed.chunk.path,
      retired_format: "flac",
      retired_file_sha256: actualFileSha256,
    }
  );
  db.prepare("UPDATE audio_chunks SET expires_at = 100 WHERE id = 'c1'").run();

  await makeWorker({ now: () => 100 }).recoverStartup();

  assert.equal(fs.existsSync(compressed.chunk.path), false);
  assert.deepEqual(
    db
      .prepare(
        "SELECT retired_path, retired_format, retired_file_sha256 FROM audio_chunks WHERE id = 'c1'"
      )
      .get(),
    { retired_path: null, retired_format: null, retired_file_sha256: null }
  );
});

test("transiently locked authoritative FLAC stays authoritative until maintenance verifies it", async (t) => {
  const { db, store, pcm, wavPath, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  fs.writeFileSync(wavPath, wavFor(pcm));
  let locked = true;
  const fsImpl = Object.create(fs.promises);
  fsImpl.readFile = async (candidate, ...args) => {
    if (locked && candidate === compressed.chunk.path) {
      const error = new Error("simulated sharing violation");
      error.code = "EBUSY";
      throw error;
    }
    return fs.promises.readFile(candidate, ...args);
  };
  const maintenanceWorker = makeWorker({ fsImpl });

  await maintenanceWorker.recoverStartup();

  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(store.getChunk("c1").path, compressed.chunk.path);
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(store.getChunkForMaintenance("c1").retired_path, null);
  assert.deepEqual(
    db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
    { state: "retry", error_code: "flac_authority_temporarily_unreadable" }
  );

  locked = false;
  await maintenanceWorker.runMaintenance(100);

  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(fs.existsSync(wavPath), false);
  assert.deepEqual(
    db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
    { state: "completed", error_code: null }
  );
});

for (const code of ["EBUSY", "EPERM", "EMFILE"]) {
  test(`a ${code} decoder second-read keeps FLAC authoritative until maintenance retries`, async (t) => {
    const { db, store, pcm, wavPath, reader, worker, makeWorker, job } = fixture(t);
    const compressed = await worker.run(job);
    fs.writeFileSync(wavPath, wavFor(pcm));
    let locked = true;
    const transientReader = {
      async readVerifiedPcm(chunk) {
        if (locked && chunk.format === "flac" && chunk.path === compressed.chunk.path) {
          const error = new Error(`simulated decoder ${code}`);
          error.code = code;
          throw error;
        }
        return reader.readVerifiedPcm(chunk);
      },
    };
    const maintenanceWorker = makeWorker({ reader: transientReader });

    await maintenanceWorker.recoverStartup();

    assert.equal(store.getChunk("c1").format, "flac");
    assert.equal(store.getChunk("c1").path, compressed.chunk.path);
    assert.equal(fs.existsSync(wavPath), true);
    assert.deepEqual(
      db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
      { state: "retry", error_code: "flac_authority_temporarily_unreadable" }
    );

    locked = false;
    await maintenanceWorker.runMaintenance(100);

    assert.equal(store.getChunk("c1").format, "flac");
    assert.equal(fs.existsSync(wavPath), false);
    assert.deepEqual(
      db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
      { state: "completed", error_code: null }
    );
  });
}

test("FFmpeg decoder spawn errors preserve safe transient diagnostics", async () => {
  const original = new Error("cannot open C:\\private\\meeting.flac");
  original.code = "EBUSY";
  const decoder = new FfmpegPcmDecoder({
    getPath: () => "C:\\tools\\ffmpeg.exe",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => child.emit("error", original));
      return child;
    },
  });

  await assert.rejects(
    decoder.decode("C:\\private\\meeting.flac", "flac"),
    (error) => {
      assert.equal(error.code, "EBUSY");
      assert.equal(error.cause, original);
      assert.equal(error.classification, "transient_io");
      assert.equal(error.message.includes("C:\\private"), false);
      return true;
    }
  );
});

test("FFmpeg input-open resource failures are classified without exposing stderr", async () => {
  const decoder = new FfmpegPcmDecoder({
    getPath: () => "C:\\tools\\ffmpeg.exe",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stderr.end("C:\\private\\meeting.flac: Device or resource busy");
        child.emit("close", 1);
      });
      return child;
    },
  });

  await assert.rejects(
    decoder.decode("C:\\private\\meeting.flac", "flac"),
    (error) => {
      assert.equal(error.code, "FFMPEG_INPUT_TRANSIENT");
      assert.equal(error.exitCode, 1);
      assert.equal(error.classification, "transient_io");
      assert.equal(error.message.includes("C:\\private"), false);
      return true;
    }
  );
});

test("transient I/O classification traverses causes and aggregate errors", () => {
  const locked = new Error("locked");
  locked.code = "EACCES";
  const nested = new Error("decoder wrapper", { cause: new AggregateError([locked]) });

  assert.equal(isTransientIoError(nested), true);
  assert.equal(isTransientIoError(new Error("pcm_hash_mismatch")), false);
});

test("a non-transient decoder PCM hash mismatch still rolls FLAC authority back", async (t) => {
  const { db, store, pcm, wavPath, reader, worker, makeWorker, job } = fixture(t);
  await worker.run(job);
  fs.writeFileSync(wavPath, wavFor(pcm));
  const mismatchingReader = {
    async readVerifiedPcm(chunk) {
      if (chunk.format === "flac") throw new Error("pcm_hash_mismatch");
      return reader.readVerifiedPcm(chunk);
    },
  };

  const recovered = await makeWorker({ reader: mismatchingReader }).recoverStartup();

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(store.getChunk("c1").path, wavPath);
  assert.equal(recovered.rolledBack, 1);
  assert.deepEqual(
    db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
    { state: "retry", error_code: "flac_authority_invalid_recovered" }
  );
});

test("maintenance hashes and removes a readable legacy null-hash retired FLAC", async (t) => {
  const { db, store, worker, job } = fixture(t);
  const compressed = await worker.run(job);
  store.tombstoneChunk("c1", 100);
  db.prepare("UPDATE audio_chunks SET retired_file_sha256 = NULL WHERE id = 'c1'").run();

  const removed = await worker.cleanupRetiredChunk(store.getChunk("c1"), 100);

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(compressed.chunk.path), false);
  assert.deepEqual(
    db
      .prepare(
        "SELECT retired_path, retired_format, retired_file_sha256 FROM audio_chunks WHERE id = 'c1'"
      )
      .get(),
    { retired_path: null, retired_format: null, retired_file_sha256: null }
  );
});

test("retired cleanup cannot unlink a same-path authority promoted by concurrent run", async (t) => {
  const { db, store, pcm, wavPath, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  const flacPath = compressed.chunk.path;
  const flacHash = compressed.chunk.file_sha256;
  fs.writeFileSync(wavPath, wavFor(pcm));
  db.prepare(
    `UPDATE audio_chunks
     SET path = ?, format = 'wav', file_sha256 = NULL,
         retired_path = ?, retired_format = 'flac', retired_file_sha256 = ?
     WHERE id = 'c1'`
  ).run(wavPath, flacPath, flacHash);
  db.prepare(
    "UPDATE processing_jobs SET state = 'retry', completed_at = NULL WHERE id = ?"
  ).run(job.id);
  const retried = db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(job.id);

  let releaseFirstUnlink;
  const firstUnlinkReleased = new Promise((resolve) => {
    releaseFirstUnlink = resolve;
  });
  let markFirstUnlinkStarted;
  const firstUnlinkStarted = new Promise((resolve) => {
    markFirstUnlinkStarted = resolve;
  });
  let first = true;
  const fsImpl = Object.create(fs.promises);
  fsImpl.unlink = async (candidate) => {
    if (candidate === flacPath && first) {
      first = false;
      markFirstUnlinkStarted();
      await firstUnlinkReleased;
    }
    return fs.promises.unlink(candidate);
  };
  let markPromoted;
  const promoted = new Promise((resolve) => {
    markPromoted = resolve;
  });
  const originalPromote = store.promoteChunkToFlac.bind(store);
  store.promoteChunkToFlac = (input) => {
    const result = originalPromote(input);
    markPromoted();
    return result;
  };
  const maintenanceWorker = makeWorker({ fsImpl });

  const cleaning = maintenanceWorker.cleanupRetiredBacklog();
  await firstUnlinkStarted;
  const running = maintenanceWorker.run(retried);
  const prematurePromotion = await Promise.race([
    promoted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  releaseFirstUnlink();
  await Promise.all([cleaning, running]);

  assert.equal(prematurePromotion, false);
  assert.equal(store.getChunk("c1").format, "flac");
  assert.equal(fs.existsSync(flacPath), true);
});

test("retired cleanup waits while a run is between rename and promotion", async (t) => {
  const { store, makeWorker, job } = fixture(t);
  let releaseRun;
  const runReleased = new Promise((resolve) => {
    releaseRun = resolve;
  });
  let markRenamed;
  const renamed = new Promise((resolve) => {
    markRenamed = resolve;
  });
  const worker = makeWorker({
    async faultInjector(point) {
      if (point !== "after_rename") return;
      markRenamed();
      await runReleased;
    },
  });

  const running = worker.run(job);
  await renamed;
  let cleanupSettled = false;
  const cleaning = worker.cleanupRetiredBacklog().finally(() => {
    cleanupSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const prematureCleanup = cleanupSettled;
  releaseRun();
  await Promise.all([running, cleaning]);

  assert.equal(prematureCleanup, false);
  assert.equal(store.getChunk("c1").format, "flac");
});

test("retired cleanup revalidates locator and current authority after its hash read", async (t) => {
  const { db, store, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  const flacPath = compressed.chunk.path;
  store.tombstoneChunk("c1", 100);
  db.prepare(
    "UPDATE audio_chunks SET path = ?, format = 'wav', deleted_at = NULL, retired_path = ?, retired_format = 'flac' WHERE id = 'c1'"
  ).run(path.join(path.dirname(flacPath), "replacement.wav"), flacPath);
  let changedAuthority = false;
  const fsImpl = Object.create(fs.promises);
  fsImpl.readFile = async (candidate, ...args) => {
    const bytes = await fs.promises.readFile(candidate, ...args);
    if (candidate === flacPath && !changedAuthority) {
      changedAuthority = true;
      db.prepare("UPDATE audio_chunks SET path = ?, format = 'flac' WHERE id = 'c1'").run(
        flacPath
      );
    }
    return bytes;
  };

  const cleaned = await makeWorker({ fsImpl }).cleanupRetiredBacklog();

  assert.deepEqual(cleaned, { removed: 0, retry: 0 });
  assert.equal(fs.existsSync(flacPath), true);
  assert.equal(store.getChunk("c1").path, flacPath);
});

test("retired locator clear is conditional on chunk path and hash, not format metadata", async (t) => {
  const { db, store, worker, job } = fixture(t);
  const compressed = await worker.run(job);
  store.tombstoneChunk("c1", 100);
  db.prepare("UPDATE audio_chunks SET retired_format = 'wav' WHERE id = 'c1'").run();

  const cleared = store.clearRetiredArtifact({
    chunkId: "c1",
    retiredPath: compressed.chunk.path,
    retiredFormat: "flac",
    retiredFileSha256: compressed.chunk.file_sha256,
  });

  assert.equal(cleared, 1);
  assert.equal(store.getChunkForMaintenance("c1").retired_path, null);
});

test("a rejected authority operation does not poison the serial tail", async (t) => {
  const { store, worker, job } = fixture(t);

  await assert.rejects(
    worker.run({ ...job, id: "missing-job", chunk_id: "missing" }),
    /does not exist/
  );
  const result = await worker.run(job);
  await worker.waitForIdle();

  assert.equal(result.chunk.format, "flac");
  assert.equal(store.getChunk("c1").format, "flac");
});

test("queued runPending and recoverStartup use non-reentrant private operations", async (t) => {
  const { store, worker } = fixture(t);

  await Promise.race([
    Promise.all([worker.runPending(), worker.recoverStartup()]),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("authority operation queue deadlocked")), 1_000)
    ),
  ]);

  assert.equal(store.getChunk("c1").format, "flac");
});

test("maintenance preserves a locked legacy null-hash retired FLAC for retry", async (t) => {
  const { db, store, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  store.tombstoneChunk("c1", 100);
  db.prepare("UPDATE audio_chunks SET retired_file_sha256 = NULL WHERE id = 'c1'").run();
  const fsImpl = Object.create(fs.promises);
  fsImpl.readFile = async (candidate, ...args) => {
    if (candidate === compressed.chunk.path) {
      const error = new Error("simulated sharing violation");
      error.code = "EBUSY";
      throw error;
    }
    return fs.promises.readFile(candidate, ...args);
  };

  await assert.rejects(
    makeWorker({ fsImpl }).cleanupRetiredChunk(store.getChunk("c1"), 100),
    { code: "EBUSY" }
  );

  assert.equal(fs.existsSync(compressed.chunk.path), true);
  assert.deepEqual(
    db
      .prepare("SELECT retired_path, retired_file_sha256 FROM audio_chunks WHERE id = 'c1'")
      .get(),
    { retired_path: compressed.chunk.path, retired_file_sha256: null }
  );
});

test("maintenance clears a missing legacy null-hash retired locator", async (t) => {
  const { db, store, worker, job } = fixture(t);
  const compressed = await worker.run(job);
  store.tombstoneChunk("c1", 100);
  db.prepare("UPDATE audio_chunks SET retired_file_sha256 = NULL WHERE id = 'c1'").run();
  fs.unlinkSync(compressed.chunk.path);

  assert.equal(await worker.cleanupRetiredChunk(store.getChunk("c1"), 100), 1);
  assert.deepEqual(
    db
      .prepare("SELECT retired_path, retired_file_sha256 FROM audio_chunks WHERE id = 'c1'")
      .get(),
    { retired_path: null, retired_file_sha256: null }
  );
});

test("online maintenance retries a tombstoned retired FLAC in the next cycle", async (t) => {
  const { db, store, pcm, wavPath, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  fs.writeFileSync(wavPath, wavFor(pcm));
  db.prepare(
    `UPDATE audio_chunks
     SET path = ?, format = 'wav', file_sha256 = NULL, expires_at = 100,
         retired_path = ?, retired_format = 'flac', retired_file_sha256 = ?
     WHERE id = 'c1'`
  ).run(wavPath, compressed.chunk.path, compressed.chunk.file_sha256);
  let locked = true;
  const fsImpl = Object.create(fs.promises);
  fsImpl.unlink = async (candidate) => {
    if (locked && candidate === compressed.chunk.path) {
      const error = new Error("simulated sharing violation");
      error.code = "EBUSY";
      throw error;
    }
    return fs.promises.unlink(candidate);
  };
  const maintenanceWorker = makeWorker({ fsImpl, now: () => 100 });
  const repository = {
    promoteSoonExpiringAudioJobs: (after, before) =>
      store.promoteSoonExpiringAudioJobs(after, before),
    listExpiredAudioChunks: (at) =>
      db
        .prepare("SELECT id FROM audio_chunks WHERE expires_at <= ? AND deleted_at IS NULL")
        .all(at)
        .map(({ id }) => store.getChunk(id)),
    tombstoneChunk: (id, at) => store.tombstoneChunk(id, at),
    getAudioChunk: (id) => store.getChunk(id),
  };
  const logs = [];
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: path.dirname(wavPath),
    deleteBatch: async (_root, paths) => {
      await Promise.all(paths.map((candidate) => fs.promises.unlink(candidate)));
      return paths.map(() => ({ status: "deleted", code: "deleted" }));
    },
    artifactCleaner: maintenanceWorker,
    log: (entry) => logs.push(entry),
  });

  assert.deepEqual(await cleaner.clean(100), { deleted: 1, missing: 0, retry: 0 });
  assert.equal(store.getChunk("c1").deleted_at, 100);
  assert.equal(store.getChunkForMaintenance("c1").retired_path, compressed.chunk.path);
  assert.equal(fs.existsSync(compressed.chunk.path), true);

  locked = false;
  assert.deepEqual(await cleaner.clean(101), { deleted: 0, missing: 0, retry: 0 });
  assert.equal(fs.existsSync(compressed.chunk.path), false);
  assert.equal(store.getChunkForMaintenance("c1").retired_path, null);
  assert.ok(logs.some((entry) => entry.retiredArtifactRetry >= 1));
  assert.ok(logs.some((entry) => entry.retiredArtifactRemoved >= 1));
});

test("retired provenance cleanup never deletes the current authoritative file", async (t) => {
  const { db, store, wavPath, makeWorker } = fixture(t);
  db.prepare(
    `UPDATE audio_chunks
     SET expires_at = 100,
         retired_path = path,
         retired_format = format,
         retired_file_sha256 = NULL
     WHERE id = 'c1'`
  ).run();

  await makeWorker({ now: () => 100 }).cleanupRetiredChunk(
    store.getChunkForMaintenance("c1"),
    100
  );

  assert.equal(fs.existsSync(wavPath), true);
});

test("retired provenance is private to the maintenance chunk API", (t) => {
  const { db, store, wavPath } = fixture(t);
  db.prepare(
    `UPDATE audio_chunks
     SET retired_path = ?, retired_format = 'flac', retired_file_sha256 = ?
     WHERE id = 'c1'`
  ).run(`${wavPath}.retired`, "b".repeat(64));

  const publicChunk = store.getChunk("c1");
  assert.equal(Object.hasOwn(publicChunk, "retired_path"), false);
  assert.equal(Object.hasOwn(publicChunk, "retired_format"), false);
  assert.equal(Object.hasOwn(publicChunk, "retired_file_sha256"), false);
  assert.deepEqual(
    {
      retired_path: store.getChunkForMaintenance("c1").retired_path,
      retired_format: store.getChunkForMaintenance("c1").retired_format,
      retired_file_sha256: store.getChunkForMaintenance("c1").retired_file_sha256,
    },
    {
      retired_path: `${wavPath}.retired`,
      retired_format: "flac",
      retired_file_sha256: "b".repeat(64),
    }
  );
});

test("startup records a diagnostic failure when neither FLAC nor sibling WAV is valid", async (t) => {
  const { db, store, worker, makeWorker, job } = fixture(t);
  const compressed = await worker.run(job);
  fs.writeFileSync(compressed.chunk.path, "corrupt-flac");

  await makeWorker().recoverStartup();

  assert.equal(store.getChunk("c1").format, "flac");
  assert.deepEqual(
    db.prepare("SELECT state, error_code FROM processing_jobs WHERE id = ?").get(job.id),
    { state: "failed", error_code: "flac_authority_invalid" }
  );
});

test("promotion rejection after retention wins removes the renamed non-authoritative FLAC", async (t) => {
  const { root, db, store, wavPath, makeWorker, job } = fixture(t);
  let clock = 100;
  let worker;
  let retentionCleanup;
  const repository = {
    promoteSoonExpiringAudioJobs: () => 0,
    listExpiredAudioChunks: (at) =>
      db.prepare("SELECT * FROM audio_chunks WHERE expires_at <= ? AND deleted_at IS NULL").all(at),
    tombstoneChunk: (id, at) => store.tombstoneChunk(id, at),
  };
  const cleaner = new RetentionCleaner({
    repository,
    recordingsRoot: root,
    deleteBatch: async (_root, paths) => {
      await Promise.all(paths.map((candidate) => fs.promises.unlink(candidate)));
      return paths.map(() => ({ status: "deleted" }));
    },
    artifactCleaner: {
      cleanupRetiredChunk: (chunk, at) => worker.cleanupRetiredChunk(chunk, at),
    },
  });
  db.prepare("UPDATE audio_chunks SET expires_at = 200 WHERE id = 'c1'").run();
  worker = makeWorker({
    now: () => clock,
    async faultInjector(point) {
      if (point !== "after_rename") return;
      clock = 200;
      retentionCleanup = cleaner.clean(clock);
      while (store.getChunk("c1").deleted_at === null) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  });

  await assert.rejects(worker.run(job), /audio is deleted|authority changed|audio_expired|ENOENT/);
  await retentionCleanup;

  assert.equal(store.getChunk("c1").deleted_at, 200);
  assert.equal(fs.existsSync(wavPath.replace(/\.wav$/, ".flac")), false);
});

test("startup removes a verified orphan final FLAC after a rename crash later expires", async (t) => {
  const { db, store, wavPath, makeWorker, job } = fixture(t);
  const crashing = makeWorker({
    faultInjector(point) {
      if (point === "after_rename") throw new Error("simulated rename crash");
    },
  });
  await assert.rejects(crashing.run(job), /simulated rename crash/);
  const flacPath = wavPath.replace(/\.wav$/, ".flac");
  db.prepare("UPDATE audio_chunks SET expires_at = 200 WHERE id = 'c1'").run();

  const recovered = await makeWorker({ now: () => 200 }).recoverStartup();

  assert.equal(store.getChunk("c1").format, "wav");
  assert.equal(fs.existsSync(wavPath), true);
  assert.equal(fs.existsSync(flacPath), false);
  assert.equal(recovered.removedInvalid, 1);
});

test("startup uses retired database authority to clean a tombstoned rename-crash FLAC", async (t) => {
  const { store, wavPath, makeWorker, job } = fixture(t);
  const crashing = makeWorker({
    faultInjector(point) {
      if (point === "after_rename") throw new Error("simulated rename crash");
    },
  });
  await assert.rejects(crashing.run(job), /simulated rename crash/);
  const flacPath = wavPath.replace(/\.wav$/, ".flac");
  store.tombstoneChunk("c1", 200);
  fs.rmSync(wavPath, { force: true });

  const recovered = await makeWorker({ now: () => 200 }).recoverStartup();

  assert.equal(fs.existsSync(flacPath), false);
  assert.equal(recovered.removedInvalid, 1);
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
  const recoveryErrors = [];
  const worker = makeWorker({
    fsImpl,
    reader,
    onRecoveryError: (entry) => recoveryErrors.push(entry),
  });

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
  assert.deepEqual(recoveryErrors, [
    { chunkId: "c1", jobId: "job-2", code: "flac_recovery_failed" },
  ]);
  assert.deepEqual(Object.keys(recoveryErrors[0]).sort(), ["chunkId", "code", "jobId"]);
});

test("a leased transcription reads a verified temporary WAV across authority switch", async (t) => {
  const { root, store, wavPath, pcm, codec, worker, job } = fixture(t);
  const reader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => 100,
  });
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

test("withVerifiedWav rejects an already-expired lease before decoding", async (t) => {
  const { root, store, codec } = fixture(t, { expiresAt: 1_100 });
  let decoded = false;
  const reader = new AudioEvidenceReader({
    decoder: {
      async decode(...args) {
        decoded = true;
        return codec.decode(...args);
      },
    },
    recordingsRoot: root,
    now: () => 1_100,
  });

  await assert.rejects(
    reader.withVerifiedWav(store.getChunk("c1"), async () => undefined, { deadline: 2_000 }),
    { message: "audio_expired", code: "audio_expired" }
  );

  assert.equal(decoded, false);
  assert.equal(fs.existsSync(path.join(root, ".evidence-tmp")), false);
});

test("withVerifiedWav aborts and removes a lease when its deadline crosses", async (t) => {
  const { root, store, codec } = fixture(t, { expiresAt: 1_200 });
  let now = 1_100;
  let deadlineCallback;
  let cleared = false;
  let leasedPath;
  let leaseSignal;
  let signalReady;
  const ready = new Promise((resolve) => {
    signalReady = resolve;
  });
  const reader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      assert.equal(delay, 100);
      deadlineCallback = callback;
      return { deadline: 1_200 };
    },
    clearTimeoutImpl: () => {
      cleared = true;
    },
  });

  const consuming = reader.withVerifiedWav(store.getChunk("c1"), async (temporaryPath, signal) => {
    leasedPath = temporaryPath;
    leaseSignal = signal;
    signalReady();
    return new Promise(() => {});
  });
  await ready;
  assert.equal(leaseSignal.aborted, false);
  assert.equal(fs.existsSync(leasedPath), true);

  now = 1_200;
  deadlineCallback();

  await assert.rejects(consuming, { message: "audio_expired", code: "audio_expired" });
  assert.equal(leaseSignal.aborted, true);
  assert.equal(fs.existsSync(leasedPath), false);
  assert.equal(cleared, true);
  assert.equal(
    await reader.cleanupStaleTemporaryEvidence({ getChunk: (id) => store.getChunk(id) }),
    0
  );
});

test("withVerifiedWav preserves audio_expired when deadline cleanup is locked", async (t) => {
  const { root, store, codec } = fixture(t, { expiresAt: 1_200 });
  let now = 1_100;
  let deadlineCallback;
  let signalReady;
  const ready = new Promise((resolve) => {
    signalReady = resolve;
  });
  const cleanupError = new Error("simulated lease sharing violation");
  cleanupError.code = "EBUSY";
  const reader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => now,
    setTimeoutImpl: (callback) => {
      deadlineCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
    temporaryWav: {
      async write() {
        return {
          path: path.join(root, ".evidence-tmp", "locked.wav"),
          async remove() {
            throw cleanupError;
          },
        };
      },
    },
  });
  const consuming = reader.withVerifiedWav(
    store.getChunk("c1"),
    async (_temporaryPath, signal) => {
      signalReady(signal);
      return new Promise(() => {});
    }
  );
  const signal = await ready;
  now = 1_200;
  deadlineCallback();

  await assert.rejects(consuming, (error) => {
    assert.equal(error.code, "audio_expired");
    assert.equal(error.cause, cleanupError);
    return true;
  });
  assert.equal(signal.aborted, true);
});

test("withVerifiedWav preserves a consumer error when cleanup also fails", async (t) => {
  const { root, store, codec } = fixture(t);
  const consumerError = new Error("consumer failed");
  consumerError.code = "consumer_failed";
  const cleanupError = new Error("simulated lease sharing violation");
  cleanupError.code = "EPERM";
  const reader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => 100,
    temporaryWav: {
      async write() {
        return {
          path: path.join(root, ".evidence-tmp", "locked.wav"),
          async remove() {
            throw cleanupError;
          },
        };
      },
    },
  });

  await assert.rejects(
    reader.withVerifiedWav(store.getChunk("c1"), async () => {
      throw consumerError;
    }),
    (error) => {
      assert.equal(error, consumerError);
      assert.equal(error.cause, cleanupError);
      return true;
    }
  );
});

test("startup removes only proven stale WAV leases inside the controlled direct child", async (t) => {
  const { root, store, codec } = fixture(t);
  const crashedReader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => 100,
  });
  let leasePath;
  let signalLease;
  let releaseLease;
  const leased = new Promise((resolve) => {
    signalLease = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLease = resolve;
  });
  const abandoned = crashedReader.withVerifiedWav(store.getChunk("c1"), async (candidate) => {
    leasePath = candidate;
    signalLease();
    await release;
  });
  await leased;
  const outside = path.join(root, "do-not-delete.wav");
  fs.writeFileSync(outside, "unrelated");
  const startupReader = new AudioEvidenceReader({
    decoder: codec,
    recordingsRoot: root,
    now: () => 100,
  });

  const removed = await startupReader.cleanupStaleTemporaryEvidence({
    getChunk: (id) => store.getChunk(id),
  });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(path.dirname(path.dirname(leasePath)), root);
  assert.equal(path.basename(path.dirname(leasePath)), ".evidence-tmp");
  releaseLease();
  await abandoned;
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

test("JarvisService cleans stale verified WAV leases before FLAC startup recovery", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lease-recovery-"));
  const repository = new JarvisRepository(":memory:");
  t.after(() => {
    repository.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  const calls = [];
  const audioEvidenceReader = {
    async cleanupStaleTemporaryEvidence({ getChunk }) {
      calls.push("leases");
      assert.equal(typeof getChunk, "function");
      return 1;
    },
  };
  const flacCompressionWorker = {
    async recoverStartup() {
      calls.push("flac");
      return { promoted: 0, deletedWavs: 0, removedInvalid: 0, rolledBack: 0 };
    },
  };
  const service = new JarvisService({
    repository,
    userDataDir,
    broadcast() {},
    audioEvidenceReader,
    flacCompressionWorker,
  });

  service.recoverOpenSessions(100);
  await service.waitForCompressionRecovery();

  assert.deepEqual(calls, ["leases", "flac"]);
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

test("rejects a recordings root that is itself a junction", async (t) => {
  const { root, db, store, codec, reader, wavPath } = fixture(t);
  const junctionRoot = `${root}-junction`;
  t.after(() => fs.rmSync(junctionRoot, { recursive: true, force: true }));
  try {
    fs.symlinkSync(root, junctionRoot, "junction");
  } catch (error) {
    t.skip(`root junction unavailable: ${error.code}`);
    return;
  }
  db.prepare("UPDATE audio_chunks SET path = ? WHERE id = 'c1'").run(
    path.join(junctionRoot, "speech.wav")
  );
  const flacPath = path.join(junctionRoot, "speech.flac");
  await codec.encode(wavPath, path.join(root, "speech.flac"));
  db.prepare("UPDATE audio_chunks SET expires_at = 100 WHERE id = 'c1'").run();
  const worker = new FlacCompressionWorker({
    store,
    recordingsRoot: junctionRoot,
    encoder: codec,
    reader,
    now: () => 100,
  });

  await assert.rejects(
    worker.cleanupRetiredChunk(store.getChunk("c1"), 100),
    /recordings root|symbolic link|junction/
  );
  assert.equal(fs.existsSync(flacPath), true);
});

test("rejects a hard-linked authoritative WAV", async (t) => {
  const { wavPath, worker, job } = fixture(t);
  const outside = path.join(os.tmpdir(), `jarvis-authority-link-${crypto.randomUUID()}.wav`);
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.linkSync(wavPath, outside);
  } catch (error) {
    t.skip(`hard link unavailable: ${error.code}`);
    return;
  }

  await assert.rejects(worker.run(job), /single-link|hard link/);

  assert.equal(fs.existsSync(outside), true);
});

test("playable reader rejects a hard-linked authoritative file before decoding", async (t) => {
  const { root, store, codec, wavPath } = fixture(t);
  const outside = path.join(os.tmpdir(), `jarvis-reader-link-${crypto.randomUUID()}.wav`);
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.linkSync(wavPath, outside);
  } catch (error) {
    t.skip(`hard link unavailable: ${error.code}`);
    return;
  }
  const reader = new AudioEvidenceReader({ decoder: codec, recordingsRoot: root });

  await assert.rejects(reader.readPlayableWav(store.getChunk("c1")), /single-link|hard link/);
});

test("WAV parser rejects RIFF and data chunks that declare bytes beyond the file", () => {
  const pcm = Buffer.alloc(100, 1);
  const truncatedRiff = wavFor(pcm);
  truncatedRiff.writeUInt32LE(truncatedRiff.length + 100, 4);
  assert.throws(() => parsePcmWav(truncatedRiff), /invalid_pcm_wav/);

  const truncatedData = wavFor(pcm);
  truncatedData.writeUInt32LE(pcm.length + 2, 40);
  assert.throws(() => parsePcmWav(truncatedData), /invalid_pcm_wav/);

  const missingPadding = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVEJUNK"),
    Buffer.from([1, 0, 0, 0, 7]),
    wavFor(pcm).subarray(12),
  ]);
  missingPadding.writeUInt32LE(missingPadding.length - 8, 4);
  assert.throws(() => parsePcmWav(missingPadding), /invalid_pcm_wav/);
});

test("refuses a pre-existing partial hard link instead of overwriting external evidence", async (t) => {
  const { wavPath, worker, job } = fixture(t);
  const outside = path.join(os.tmpdir(), `jarvis-flac-target-${crypto.randomUUID()}`);
  const partialPath = wavPath.replace(/\.wav$/, ".flac.partial");
  fs.writeFileSync(outside, "preserve-me");
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.linkSync(outside, partialPath);

  await assert.rejects(worker.run(job), /partial_already_exists|single-link/);

  assert.equal(fs.readFileSync(outside, "utf8"), "preserve-me");
});
