const WINDOW_SIZE = 512;
const TARGET_SAMPLE_RATE = 16_000;
const DEFAULT_STATE_SHAPE = Object.freeze([2, 1, 64]);
const DEFAULT_MAX_STREAMS = 64;

function normalizeShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) return [...DEFAULT_STATE_SHAPE];
  return shape.map((dimension) => (typeof dimension === "number" && dimension > 0 ? dimension : 1));
}

function normalizedStateName(name) {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function appendFloat32(left, right) {
  if (left.length === 0) return new Float32Array(right);
  if (right.length === 0) return left;
  const output = new Float32Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function pcm16To16kFloat32(samplesBuffer, sampleRate) {
  if (!(samplesBuffer instanceof ArrayBuffer)) {
    throw new TypeError("samplesBuffer must be an ArrayBuffer");
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError("sampleRate must be a positive safe integer");
  }
  if (samplesBuffer.byteLength % 2 !== 0) {
    throw new RangeError("PCM must contain complete signed 16-bit samples");
  }
  const input = new Int16Array(samplesBuffer);
  const outputLength = Math.floor((input.length * TARGET_SAMPLE_RATE) / sampleRate);
  const output = new Float32Array(outputLength);
  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const lower = Math.floor(sourceIndex);
    const fraction = sourceIndex - lower;
    const left = input[lower] ?? 0;
    const right = input[Math.min(lower + 1, input.length - 1)] ?? left;
    output[index] = (left + fraction * (right - left)) / 32_768;
  }
  return output;
}

class SileroVadRuntime {
  constructor({ ort, maxStreams = DEFAULT_MAX_STREAMS }) {
    if (!ort?.InferenceSession || typeof ort.Tensor !== "function") {
      throw new TypeError("ONNX runtime is required");
    }
    if (!Number.isSafeInteger(maxStreams) || maxStreams <= 0) {
      throw new TypeError("maxStreams must be a positive safe integer");
    }
    this.ort = ort;
    this.maxStreams = maxStreams;
    this.session = null;
    this.modelPath = null;
    this.stateInputNames = [];
    this.stateOutputNames = [];
    this.streams = new Map();
    this.operationTail = Promise.resolve();
    this.healthSequence = 0;
  }

  get streamCount() {
    return this.streams.size;
  }

  hasStream(streamId) {
    return this.streams.has(streamId);
  }

  async load(modelPath, sessionOptions) {
    return this._enqueue(() => this._load(modelPath, sessionOptions));
  }

  async reload(modelPath, sessionOptions) {
    return this._enqueue(() => this._reload(modelPath, sessionOptions));
  }

  async _load(modelPath, sessionOptions) {
    this._assertModelPath(modelPath);
    if (this.session && this.modelPath === modelPath) return { ok: true };
    const loaded = await this._createSession(modelPath, sessionOptions);
    this._commitSession(loaded);
    return { ok: true };
  }

  async _reload(modelPath, sessionOptions) {
    this._assertModelPath(modelPath);
    const loaded = await this._createSession(modelPath, sessionOptions);
    const previous = this._snapshotRuntime();
    this._commitSession(loaded);
    try {
      return await this._health();
    } catch (error) {
      this._restoreRuntime(previous);
      throw error;
    }
  }

  _assertModelPath(modelPath) {
    if (typeof modelPath !== "string" || modelPath.length === 0) {
      throw new TypeError("modelPath is required");
    }
  }

  async _createSession(modelPath, sessionOptions) {
    const session = await this.ort.InferenceSession.create(modelPath, {
      ...(sessionOptions || {}),
      intraOpNumThreads: 1,
      executionMode: "sequential",
    });
    return {
      session,
      modelPath,
      stateInputNames: (session.inputNames || []).filter((name) => /state|^h$|^c$/i.test(name)),
      stateOutputNames: (session.outputNames || []).filter((name) => /state|^h|^c/i.test(name)),
    };
  }

  _commitSession({ session, modelPath, stateInputNames, stateOutputNames }) {
    this.session = session;
    this.modelPath = modelPath;
    this.stateInputNames = stateInputNames;
    this.stateOutputNames = stateOutputNames;
    this.streams = new Map();
  }

  _snapshotRuntime() {
    return {
      session: this.session,
      modelPath: this.modelPath,
      stateInputNames: this.stateInputNames,
      stateOutputNames: this.stateOutputNames,
      streams: this.streams,
      healthSequence: this.healthSequence,
    };
  }

  _restoreRuntime(snapshot) {
    this.session = snapshot.session;
    this.modelPath = snapshot.modelPath;
    this.stateInputNames = snapshot.stateInputNames;
    this.stateOutputNames = snapshot.stateOutputNames;
    this.streams = snapshot.streams;
    this.healthSequence = snapshot.healthSequence;
  }

  async reset(streamId = null) {
    return this._enqueue(() => this._reset(streamId));
  }

  _reset(streamId = null) {
    if (streamId === null || streamId === undefined) {
      this.streams.clear();
      return { ok: true };
    }
    this._assertStreamId(streamId);
    this.streams.delete(streamId);
    return { ok: true };
  }

  async resetSession(sessionId) {
    return this._enqueue(() => this._resetSession(sessionId));
  }

  _resetSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) {
      throw new TypeError("sessionId must be a non-empty string");
    }
    const streamPrefix = `${sessionId}:`;
    for (const [streamId, stream] of this.streams) {
      if (stream.sessionId === sessionId || streamId.startsWith(streamPrefix)) {
        this.streams.delete(streamId);
      }
    }
    return { ok: true };
  }

  async classify({ sessionId = null, streamId, samplesBuffer, sampleRate }) {
    return this._enqueue(() => this._classify({ sessionId, streamId, samplesBuffer, sampleRate }));
  }

  async _classify({ sessionId = null, streamId, samplesBuffer, sampleRate }) {
    if (!this.session) throw new Error("VAD session not loaded");
    this._assertStreamId(streamId);
    const stream = this._stream(streamId, sessionId);
    stream.remainder = appendFloat32(
      stream.remainder,
      pcm16To16kFloat32(samplesBuffer, sampleRate)
    );
    let probability = 0;
    let windowCount = 0;
    while (stream.remainder.length >= WINDOW_SIZE) {
      const window = new Float32Array(stream.remainder.subarray(0, WINDOW_SIZE));
      stream.remainder = stream.remainder.slice(WINDOW_SIZE);
      probability = Math.max(probability, await this._classifyWindow(stream, window));
      windowCount += 1;
    }
    return { probability, windowCount };
  }

  async health() {
    return this._enqueue(() => this._health());
  }

  async _health() {
    if (!this.session) throw new Error("VAD session not loaded");
    const streamId = `__vad_health__:${++this.healthSequence}`;
    const captureStreams = this.streams;
    this.streams = new Map(captureStreams);
    try {
      const result = await this._classify({
        sessionId: "__vad_health__",
        streamId,
        sampleRate: TARGET_SAMPLE_RATE,
        samplesBuffer: new ArrayBuffer(WINDOW_SIZE * 2),
      });
      if (
        result.windowCount < 1 ||
        !Number.isFinite(result.probability) ||
        result.probability < 0 ||
        result.probability > 1
      ) {
        throw new Error("VAD health inference returned an invalid result");
      }
      return { ok: true, probability: result.probability };
    } finally {
      this.streams = captureStreams;
    }
  }

  _enqueue(operation) {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  _assertStreamId(streamId) {
    if (typeof streamId !== "string" || streamId.length === 0 || streamId.length > 512) {
      throw new TypeError("streamId must be a non-empty string");
    }
  }

  _stream(streamId, sessionId) {
    let stream = this.streams.get(streamId);
    if (stream) {
      this.streams.delete(streamId);
      this.streams.set(streamId, stream);
      return stream;
    }
    const states = new Map();
    for (const name of this.stateInputNames) {
      const shape = normalizeShape(
        this.session.inputMetadata?.[name]?.dimensions || this.session.inputMetadata?.[name]?.shape
      );
      states.set(name, new Float32Array(shape.reduce((total, value) => total * value, 1)));
    }
    stream = {
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
      remainder: new Float32Array(0),
      states,
    };
    while (this.streams.size >= this.maxStreams) {
      this.streams.delete(this.streams.keys().next().value);
    }
    this.streams.set(streamId, stream);
    return stream;
  }

  async _classifyWindow(stream, window) {
    const inputNames = this.session.inputNames || [];
    const audioInputName = inputNames.find(
      (name) => !this.stateInputNames.includes(name) && !/sr|sample.?rate/i.test(name)
    );
    if (!audioInputName) throw new Error("VAD audio input is missing");
    const feeds = {
      [audioInputName]: new this.ort.Tensor("float32", window, [1, window.length]),
    };
    const sampleRateInputName = inputNames.find((name) => /sr|sample.?rate/i.test(name));
    if (sampleRateInputName) {
      feeds[sampleRateInputName] = new this.ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(TARGET_SAMPLE_RATE)]),
        [1]
      );
    }
    for (const stateName of this.stateInputNames) {
      const shape = normalizeShape(
        this.session.inputMetadata?.[stateName]?.dimensions ||
          this.session.inputMetadata?.[stateName]?.shape
      );
      feeds[stateName] = new this.ort.Tensor("float32", stream.states.get(stateName), shape);
    }

    const results = await this.session.run(feeds);
    for (const inputName of this.stateInputNames) {
      const expected = normalizedStateName(inputName);
      const outputName = this.stateOutputNames.find((name) =>
        normalizedStateName(name).startsWith(expected)
      );
      const output = (outputName && results[outputName]) || results[inputName];
      if (output?.data) stream.states.set(inputName, new Float32Array(output.data));
    }
    const probabilityOutputName = (this.session.outputNames || []).find(
      (name) => !this.stateOutputNames.includes(name)
    );
    const output =
      (probabilityOutputName && results[probabilityOutputName]) || Object.values(results)[0];
    const value = Number(output?.data?.[0]);
    if (!Number.isFinite(value)) throw new Error("VAD probability output is invalid");
    return Math.max(0, Math.min(1, value));
  }
}

module.exports = SileroVadRuntime;
