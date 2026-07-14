const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisTranscriptionWorker = require("../../src/jarvis/main/JarvisTranscriptionWorker");

const MODEL_VERSION = "large-v3-turbo";
const COMPLETED_AT = 500_000;

function seedChunk(t, { format = "wav", sourceType = "system", id = "chunk-1" } = {}) {
  const repository = new JarvisRepository(":memory:");
  t.after(() => repository.close());
  repository.createSession({
    id: "session-1",
    startedAt: 1_000,
    micDeviceId: sourceType === "mic" ? "physical-mic" : null,
    captureMode: sourceType,
  });
  repository.createTrack({
    id: "track-1",
    sessionId: "session-1",
    sourceType,
    deviceId: sourceType === "mic" ? "physical-mic" : null,
    deviceLabel: sourceType === "mic" ? "Desk microphone" : "PC audio",
    strategy: sourceType === "mic" ? "media-recorder" : "wasapi-loopback",
    sampleRate: 24_000,
    channels: 1,
    startedAt: 1_000,
  });
  repository.commitChunk({
    id,
    sessionId: "session-1",
    trackId: "track-1",
    sourceType,
    sequenceNumber: 0,
    path: `${id}.wav`,
    startedAt: 10_000,
    endedAt: 20_000,
    durationMs: 10_000,
    sha256: "a".repeat(64),
    expiresAt: 600_000,
  });
  if (format === "flac") {
    repository.db
      .prepare("UPDATE audio_chunks SET path = ?, format = 'flac' WHERE id = ?")
      .run(`${id}.flac`, id);
  }
  return repository;
}

function workerFixture(repository, transcribeWav, { reader } = {}) {
  const calls = [];
  const audioEvidenceReader = reader ?? {
    async withVerifiedWav(chunk, consume) {
      calls.push(chunk);
      return consume(`verified-${chunk.format}.wav`, new AbortController().signal);
    },
  };
  const worker = new JarvisTranscriptionWorker({
    repository,
    audioEvidenceReader,
    transcribeWav,
    modelVersion: MODEL_VERSION,
    now: () => COMPLETED_AT,
  });
  return { worker, calls };
}

for (const format of ["wav", "flac"]) {
  test(`stores a final source-aware segment from verified ${format.toUpperCase()} evidence`, async (t) => {
    const repository = seedChunk(t, { format });
    repository.upsertTranscriptSegments("session-1", [
      {
        id: "prior",
        startedAt: 1_100,
        endedAt: 2_000,
        personId: null,
        speakerLabel: "mic",
        text: "明天 review 产品 roadmap",
        confidence: 0.8,
        isStable: true,
      },
    ]);
    let transcriptionInput;
    const { worker, calls } = workerFixture(repository, async (input) => {
      transcriptionInput = input;
      return { text: "今天 review 一个 roadmap", confidence: 0.91 };
    });

    await worker.handle({ chunk_id: "chunk-1" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].format, format);
    assert.equal(transcriptionInput.path, `verified-${format}.wav`);
    assert.equal(transcriptionInput.language, null);
    assert.match(transcriptionInput.initialPrompt, /review 产品 roadmap/u);
    assert.ok(Array.from(transcriptionInput.initialPrompt).length <= 1_024);
    const segment = repository
      .listTranscriptSegments("session-1")
      .find((row) => row.chunk_id === "chunk-1");
    assert.deepEqual(
      {
        session_id: segment.session_id,
        track_id: segment.track_id,
        chunk_id: segment.chunk_id,
        source_type: segment.source_type,
        started_at: segment.started_at,
        ended_at: segment.ended_at,
        text: segment.text,
        confidence: segment.confidence,
        result_kind: segment.result_kind,
        model_version: segment.model_version,
        completed_at: segment.completed_at,
      },
      {
        session_id: "session-1",
        track_id: "track-1",
        chunk_id: "chunk-1",
        source_type: "system",
        started_at: 10_000,
        ended_at: 20_000,
        text: "今天 review 一个 roadmap",
        confidence: 0.91,
        result_kind: "final",
        model_version: MODEL_VERSION,
        completed_at: COMPLETED_AT,
      }
    );
    assert.equal(repository.getAudioChunk("chunk-1").transcription_status, "completed");
  });
}

test("keeps MIC lineage and replaying the same input and model is idempotent", async (t) => {
  const repository = seedChunk(t, { sourceType: "mic" });
  const { worker } = workerFixture(repository, async () => ({
    success: true,
    text: "Call Alice after standup",
  }));

  await worker.handle({ chunk_id: "chunk-1" });
  await worker.handle({ chunk_id: "chunk-1" });

  const rows = repository
    .listTranscriptSegments("session-1")
    .filter((row) => row.chunk_id === "chunk-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_type, "mic");
  assert.equal(rows[0].track_id, "track-1");
});

test("records explicit no-speech as a terminal chunk state without fabricated text", async (t) => {
  const repository = seedChunk(t);
  const { worker } = workerFixture(repository, async () => ({
    success: false,
    message: "No audio detected",
  }));

  await worker.handle({ chunk_id: "chunk-1" });

  assert.equal(repository.listTranscriptSegments("session-1").length, 0);
  assert.equal(repository.getAudioChunk("chunk-1").transcription_status, "no_speech");
});

test("rejects missing, tombstoned, and uncommitted evidence before transcription", async (t) => {
  const repository = seedChunk(t);
  let transcribeCalls = 0;
  const { worker } = workerFixture(repository, async () => {
    transcribeCalls += 1;
    return { text: "must not run" };
  });

  await assert.rejects(worker.handle({ chunk_id: "missing" }), { code: "AUDIO_UNAVAILABLE" });
  repository.db
    .prepare("UPDATE audio_chunks SET deleted_at = ?, path = ? WHERE id = ?")
    .run(100, "tombstone:chunk-1", "chunk-1");
  await assert.rejects(worker.handle({ chunk_id: "chunk-1" }), { code: "AUDIO_UNAVAILABLE" });
  repository.db
    .prepare(
      "UPDATE audio_chunks SET deleted_at = NULL, path = ?, write_state = 'writing' WHERE id = ?"
    )
    .run("chunk-1.wav", "chunk-1");
  await assert.rejects(worker.handle({ chunk_id: "chunk-1" }), { code: "AUDIO_UNAVAILABLE" });
  assert.equal(transcribeCalls, 0);
});

test("maps expired or unreadable verified evidence to a stable unavailable code", async (t) => {
  const repository = seedChunk(t);
  const expired = Object.assign(new Error("audio_expired"), { code: "audio_expired" });
  const { worker } = workerFixture(repository, async () => ({ text: "must not run" }), {
    reader: {
      async withVerifiedWav() {
        throw expired;
      },
    },
  });

  await assert.rejects(worker.handle({ chunk_id: "chunk-1" }), {
    code: "AUDIO_UNAVAILABLE",
  });
});

test("rejects malformed and non-silence Whisper failures without committing a segment", async (t) => {
  const repository = seedChunk(t);
  const malformed = workerFixture(repository, async () => ({ success: true })).worker;
  await assert.rejects(malformed.handle({ chunk_id: "chunk-1" }), {
    code: "TRANSCRIPTION_INVALID_RESULT",
  });
  assert.equal(repository.listTranscriptSegments("session-1").length, 0);

  const failed = workerFixture(repository, async () => ({
    success: false,
    error: "local inference failed",
  })).worker;
  await assert.rejects(failed.handle({ chunk_id: "chunk-1" }), {
    code: "TRANSCRIPTION_FAILED",
  });
  assert.equal(repository.listTranscriptSegments("session-1").length, 0);
});

test("passes admission context through verified evidence and returns only the proven device", async (t) => {
  const repository = seedChunk(t);
  const context = {
    action: "run_cpu",
    device: "cpu",
    cpuThreads: 4,
    lowPriority: true,
    selectedGpuUuid: null,
  };
  let input;
  const { worker } = workerFixture(repository, async (value) => {
    input = value;
    return { text: "local CPU result", confidence: 0.8, executionDevice: "cpu" };
  });

  assert.deepEqual(await worker.handle({ chunk_id: "chunk-1" }, context), {
    executionDevice: "cpu",
  });
  assert.deepEqual(input.executionContext, context);

  const secondRepository = seedChunk(t, { id: "chunk-2" });
  const mismatched = workerFixture(secondRepository, async () => ({
    text: "must not commit",
    executionDevice: "cuda",
  })).worker;
  await assert.rejects(mismatched.handle({ chunk_id: "chunk-2" }, context), {
    code: "EXECUTION_DEVICE_MISMATCH",
  });
  assert.equal(secondRepository.listTranscriptSegments("session-1").length, 0);
});

test("the IPC adapter keeps verified WAV bytes local and uses auto language", async () => {
  const ipcHandlersPath = path.resolve(__dirname, "../../src/helpers/ipcHandlers.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: {},
        app: {},
        shell: {},
        BrowserWindow: {},
        systemPreferences: {},
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let createAdapter;
  try {
    delete require.cache[ipcHandlersPath];
    ({ createJarvisTranscribeWavAdapter: createAdapter } = require(ipcHandlersPath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[ipcHandlersPath];
  }

  const calls = [];
  const adapter = createAdapter({
    whisperManager: {
      async transcribeLocalWhisper(bytes, options) {
        calls.push({ bytes, options });
        return { success: true, text: "local only" };
      },
    },
    model: MODEL_VERSION,
    readFile: async (wavPath) => {
      assert.equal(wavPath, "verified.wav");
      return Buffer.from("verified-local-wav");
    },
  });

  assert.deepEqual(
    await adapter({ path: "verified.wav", language: null, initialPrompt: "中英 context" }),
    { success: true, text: "local only" }
  );
  assert.deepEqual(calls, [
    {
      bytes: Buffer.from("verified-local-wav"),
      options: {
        model: MODEL_VERSION,
        language: null,
        initialPrompt: "中英 context",
      },
    },
  ]);
});

test("the IPC adapter maps CPU admission to explicit bounded Whisper options", async () => {
  const ipcHandlersPath = path.resolve(__dirname, "../../src/helpers/ipcHandlers.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: {},
        app: {},
        shell: {},
        BrowserWindow: {},
        systemPreferences: {},
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let createAdapter;
  try {
    delete require.cache[ipcHandlersPath];
    ({ createJarvisTranscribeWavAdapter: createAdapter } = require(ipcHandlersPath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[ipcHandlersPath];
  }
  const calls = [];
  const adapter = createAdapter({
    whisperManager: {
      async transcribeLocalWhisper(_bytes, options) {
        calls.push(options);
        return { success: true, text: "local only", executionDevice: "cpu" };
      },
    },
    model: MODEL_VERSION,
    readFile: async () => Buffer.from("verified-local-wav"),
  });

  const result = await adapter({
    path: "verified.wav",
    language: null,
    initialPrompt: "context",
    executionContext: {
      action: "run_cpu",
      device: "cpu",
      cpuThreads: 4,
      lowPriority: true,
      selectedGpuUuid: null,
    },
  });

  assert.equal(result.executionDevice, "cpu");
  assert.deepEqual(calls, [
    {
      model: MODEL_VERSION,
      language: null,
      initialPrompt: "context",
      useCuda: false,
      requireCuda: false,
      gpuUuid: null,
      threads: 4,
      lowPriority: true,
    },
  ]);
});
