const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DataRootRelocator = require("../../src/jarvis/main/DataRootRelocator");
const AudioEvidenceReader = require("../../src/jarvis/main/AudioEvidenceReader");
const FlacCompressionWorker = require("../../src/jarvis/main/FlacCompressionWorker");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");
const RetentionCleaner = require("../../src/jarvis/main/RetentionCleaner");
const { copyLegacyTreeSync } = require("../../src/jarvis/main/recordingStorage");

function pcmWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class LosslessFixtureCodec {
  async encode(inputPath, outputPath) {
    const wav = await fsp.readFile(inputPath);
    const pcm = wav.subarray(44);
    const metadata = Buffer.alloc(12);
    metadata.writeUInt32LE(24_000, 0);
    metadata.writeUInt32LE(1, 4);
    metadata.writeUInt32LE(pcm.length / 2, 8);
    await fsp.writeFile(outputPath, Buffer.concat([Buffer.from("fLaC"), metadata, pcm]));
  }

  async decode(inputPath, format) {
    const bytes = await fsp.readFile(inputPath);
    if (format === "wav") {
      return {
        bytes: bytes.subarray(44),
        sampleRate: 24_000,
        channels: 1,
        sampleCount: bytes.readUInt32LE(40) / 2,
      };
    }
    return {
      bytes: bytes.subarray(16),
      sampleRate: bytes.readUInt32LE(4),
      channels: bytes.readUInt32LE(8),
      sampleCount: bytes.readUInt32LE(12),
    };
  }
}

test("relocates SQLite and recovery sidecar locators before the old root is deleted", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-root-relocate-"));
  const oldRoot = path.join(base, "old");
  const newRoot = path.join(base, "new");
  const relativeWav = path.join("recordings", "s1", "mic", "chunk-c1.wav");
  const relativeRecoveryWav = path.join(
    "recordings",
    "s1",
    "mic",
    "recovery",
    "chunk-recovery.wav"
  );
  const oldWav = path.join(oldRoot, relativeWav);
  const newWav = path.join(newRoot, relativeWav);
  const oldRecoveryWav = path.join(oldRoot, relativeRecoveryWav);
  const newRecoveryWav = path.join(newRoot, relativeRecoveryWav);
  await fsp.mkdir(path.dirname(oldWav), { recursive: true });
  await fsp.mkdir(path.dirname(oldRecoveryWav), { recursive: true });
  const pcm = Buffer.alloc(48, 0x31);
  await fsp.writeFile(oldWav, pcmWav(pcm));
  await fsp.writeFile(oldRecoveryWav, pcmWav(pcm));
  const repo = new JarvisRepository(path.join(oldRoot, "jarvis.db"));
  repo.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repo.createTrack({
    id: "track-c1",
    sessionId: "s1",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repo.commitChunk({
    id: "c1",
    sessionId: "s1",
    trackId: "track-c1",
    sourceType: "mic",
    sequenceNumber: 0,
    path: oldWav,
    startedAt: 1_000,
    endedAt: 1_001,
    durationMs: 1,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    expiresAt: 10_000,
    format: "wav",
    sampleRate: 24_000,
    channels: 1,
    encoderVersion: "fixture-flac-v1",
  });
  repo.checkpointForMigration();
  repo.close();
  await fsp.writeFile(
    `${oldRecoveryWav}.recovery.json`,
    JSON.stringify({
      id: "chunk-recovery",
      sessionId: "s1",
      trackId: "track-c1",
      sourceType: "mic",
      sequenceNumber: 1,
      path: oldRecoveryWav,
      startedAt: 1_001,
      endedAt: 1_002,
      durationMs: 1,
      sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    })
  );
  await fsp.cp(oldRoot, newRoot, { recursive: true, errorOnExist: true, force: false });
  t.after(() => fsp.rm(base, { recursive: true, force: true }));

  const result = await new DataRootRelocator().relocate({ oldRoot, newRoot });
  await fsp.rm(oldRoot, { recursive: true, force: true });

  assert.deepEqual(result, { databaseLocators: 1, recoverySidecars: 1 });
  const migrated = new JarvisRepository(path.join(newRoot, "jarvis.db"));
  const migratedChunk = migrated.getAudioChunk("c1");
  assert.equal(migratedChunk.path, newWav);
  const codec = new LosslessFixtureCodec();
  const reader = new AudioEvidenceReader({
    recordingsRoot: path.join(newRoot, "recordings"),
    decoder: codec,
  });
  const playable = await reader.readPlayableWav(migratedChunk);
  assert.deepEqual(playable.subarray(44), pcm);
  const worker = new FlacCompressionWorker({
    store: migrated.captureEvidenceStore,
    recordingsRoot: path.join(newRoot, "recordings"),
    encoder: codec,
    reader,
    now: () => 2_000,
  });
  const compressionJob = migrated.db
    .prepare("SELECT * FROM processing_jobs WHERE chunk_id = ? AND job_type = 'compress_chunk'")
    .get("c1");
  await worker.run(compressionJob);
  const compressed = migrated.getAudioChunk("c1");
  assert.equal(compressed.format, "flac");
  assert.equal(compressed.path.startsWith(path.join(newRoot, "recordings")), true);
  assert.equal(fs.existsSync(compressed.path), true);
  const sidecar = JSON.parse(await fsp.readFile(`${newRecoveryWav}.recovery.json`, "utf8"));
  assert.equal(sidecar.path, newRecoveryWav);
  assert.equal(fs.existsSync(sidecar.path), true);

  const cleaner = new RetentionCleaner({
    repository: migrated,
    recordingsRoot: path.join(newRoot, "recordings"),
    deleteBatch: async (_root, paths) =>
      Promise.all(
        paths.map(async (filePath) => {
          await fsp.rm(filePath, { force: true });
          return { status: "deleted" };
        })
      ),
    artifactCleaner: worker,
    temporaryEvidenceCleaner: reader,
    now: () => 10_000,
  });
  assert.deepEqual(await cleaner.clean(10_000), { deleted: 1, retry: 0, missing: 0 });
  assert.equal(migrated.getAudioChunk("c1").path, "tombstone:c1");

  const service = new JarvisService({
    repository: migrated,
    userDataDir: newRoot,
    recordingsDir: path.join(newRoot, "recordings"),
    flacCompressionWorker: null,
    broadcast() {},
    now: () => 3_000,
  });
  const recovered = service.recoverOpenSessions(3_000);
  assert.deepEqual(recovered.map((session) => session.id), ["s1"]);
  assert.equal(migrated.getAudioChunk("chunk-recovery").path, newRecoveryWav);
  assert.equal(fs.existsSync(`${newRecoveryWav}.recovery.json`), false);
  service.shutdown();
  migrated.close();
});

test("adopts a custom recordings root into unified storage before deleting the old tree", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-custom-recordings-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const customRecordings = path.join(base, "custom-audio");
  const unifiedRoot = path.join(base, "custom-audio-data");
  const unifiedRecordings = path.join(unifiedRoot, "recordings");
  const relativeWav = path.join("s1", "mic", "chunk-c1.wav");
  const relativeRecovery = path.join("s1", "mic", "recovery", "chunk-recovery.wav");
  const oldWav = path.join(customRecordings, relativeWav);
  const oldRecoveryWav = path.join(customRecordings, relativeRecovery);
  await fsp.mkdir(path.dirname(oldWav), { recursive: true });
  await fsp.mkdir(path.dirname(oldRecoveryWav), { recursive: true });
  const pcm = Buffer.alloc(48, 0x42);
  await fsp.writeFile(oldWav, pcmWav(pcm));
  await fsp.writeFile(oldRecoveryWav, pcmWav(pcm));
  await fsp.mkdir(unifiedRoot, { recursive: true });
  const repository = new JarvisRepository(path.join(unifiedRoot, "jarvis.db"));
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repository.createTrack({
    id: "track-c1",
    sessionId: "s1",
    sourceType: "mic",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repository.commitChunk({
    id: "c1",
    sessionId: "s1",
    trackId: "track-c1",
    sourceType: "mic",
    sequenceNumber: 0,
    path: oldWav,
    startedAt: 1_000,
    endedAt: 1_001,
    durationMs: 1,
    sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    expiresAt: 10_000,
  });
  repository.checkpointForMigration();
  repository.close();
  await fsp.writeFile(
    `${oldRecoveryWav}.recovery.json`,
    JSON.stringify({
      id: "chunk-recovery",
      sessionId: "s1",
      trackId: "track-c1",
      sourceType: "mic",
      sequenceNumber: 1,
      path: oldRecoveryWav,
      startedAt: 1_001,
      endedAt: 1_002,
      durationMs: 1,
      sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    })
  );

  copyLegacyTreeSync({ from: customRecordings, to: unifiedRecordings });
  const relocated = await new DataRootRelocator().relocateRecordings({
    databasePath: path.join(unifiedRoot, "jarvis.db"),
    oldRecordingsRoot: customRecordings,
    newRecordingsRoot: unifiedRecordings,
  });
  await fsp.rm(customRecordings, { recursive: true, force: true });

  assert.deepEqual(relocated, { databaseLocators: 1, recoverySidecars: 1 });
  const migrated = new JarvisRepository(path.join(unifiedRoot, "jarvis.db"));
  const chunk = migrated.getAudioChunk("c1");
  assert.equal(chunk.path, path.join(unifiedRecordings, relativeWav));
  const reader = new AudioEvidenceReader({
    recordingsRoot: unifiedRecordings,
    decoder: new LosslessFixtureCodec(),
  });
  assert.deepEqual((await reader.readPlayableWav(chunk)).subarray(44), pcm);
  const sidecar = JSON.parse(
    await fsp.readFile(`${path.join(unifiedRecordings, relativeRecovery)}.recovery.json`, "utf8")
  );
  assert.equal(sidecar.path, path.join(unifiedRecordings, relativeRecovery));
  assert.equal(fs.existsSync(sidecar.path), true);
  migrated.close();
});
