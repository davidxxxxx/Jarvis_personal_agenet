const PcmRingBuffer = require("./PcmRingBuffer");
const { splitEntry } = PcmRingBuffer;
const { assertSourceType } = require("../shared/captureModes");

const RETENTION_MODES = new Set(["speech_triggered", "continuous", "continuous_fallback"]);

function assertDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function measurePcm(pcm) {
  let squaredTotal = 0;
  let peak = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const absolute = Math.abs(pcm.readInt16LE(offset));
    const normalized = absolute / 32_768;
    squaredTotal += normalized * normalized;
    peak = Math.max(peak, absolute);
  }
  return {
    squaredTotal,
    sampleCount: samples,
    averageLevel: samples === 0 ? 0 : Math.sqrt(squaredTotal / samples),
    peakLevel: peak / 32_768,
  };
}

function decision(sourceType) {
  return {
    sourceType,
    retain: false,
    writes: [],
    gapsToCommit: [],
    state: "armed",
  };
}

class SpeechTriggeredCaptureGate {
  constructor({
    sampleRate = 24_000,
    bytesPerFrame = 2,
    preRollMs = 2_000,
    postRollMs = 3_000,
    mergeGapMs = 3_000,
    speechThreshold = 0.5,
    mode = "speech_triggered",
  } = {}) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a positive safe integer");
    }
    if (!Number.isSafeInteger(bytesPerFrame) || bytesPerFrame <= 0) {
      throw new TypeError("bytesPerFrame must be a positive safe integer");
    }
    for (const [name, value] of Object.entries({ preRollMs, postRollMs, mergeGapMs })) {
      assertDuration(value, name);
    }
    if (typeof speechThreshold !== "number" || speechThreshold < 0 || speechThreshold > 1) {
      throw new RangeError("speechThreshold must be between zero and one");
    }
    if (!RETENTION_MODES.has(mode) || mode === "continuous_fallback") {
      throw new TypeError("invalid configured retention mode");
    }

    this.sampleRate = sampleRate;
    this.bytesPerFrame = bytesPerFrame;
    this.preRollMs = preRollMs;
    this.postRollMs = postRollMs;
    this.mergeGapMs = mergeGapMs;
    this.speechThreshold = speechThreshold;
    this.requestedMode = mode;
    this.mode = mode;
    this.degradedReason = null;
    this.lastSpeechProbability = null;
    this.sources = new Map();
  }

  accept(input) {
    const entry = this._entry(input);
    const state = this._source(entry.sourceType);
    if (state.lastProcessedAt !== null && entry.startedAt < state.lastProcessedAt) {
      throw new RangeError("PCM frames must be accepted in timestamp order per source");
    }
    state.lastProcessedAt = entry.endedAt;
    this.lastSpeechProbability = input.speechProbability;
    const output = decision(entry.sourceType);

    if (this.mode === "continuous" || this.mode === "continuous_fallback") {
      this._retain(output, entry);
      if (this.mode === "continuous_fallback") {
        state.degradedStart ??= entry.startedAt;
        this._accumulate(state, "degraded", entry);
      }
      output.state = this.mode;
      return output;
    }

    const isSpeech = input.speechProbability >= this.speechThreshold;
    if (isSpeech) {
      this._commitSuppression(output, state);
      for (const buffered of state.ring.drain()) this._retain(output, buffered);
      this._retain(output, entry);
      const retainedBridgeMs = Math.max(this.postRollMs, this.mergeGapMs);
      state.retainUntil = Math.max(
        state.retainUntil ?? entry.endedAt,
        entry.endedAt + retainedBridgeMs
      );
      output.state = "speech";
      return output;
    }

    if (state.retainUntil !== null && entry.startedAt < state.retainUntil) {
      if (entry.endedAt <= state.retainUntil) {
        this._retain(output, entry);
        output.state = "post_roll";
        return output;
      }
      const totalFrames = entry.pcm.length / this.bytesPerFrame;
      const retainedFrames = Math.max(
        1,
        Math.min(
          totalFrames - 1,
          Math.round(
            (totalFrames * (state.retainUntil - entry.startedAt)) /
              (entry.endedAt - entry.startedAt)
          )
        )
      );
      const [retained, buffered] = splitEntry(entry, retainedFrames, this.bytesPerFrame);
      this._retain(output, retained);
      state.retainUntil = null;
      this._buffer(state, buffered);
      output.state = "armed";
      return output;
    }

    state.retainUntil = null;
    this._buffer(state, entry);
    output.state = "armed";
    return output;
  }

  finish(sourceType, at) {
    const type = assertSourceType(sourceType);
    assertDuration(at, "at");
    const state = this._source(type);
    const output = decision(type);
    if (this.mode === "speech_triggered") {
      for (const buffered of state.ring.drain()) this._accumulate(state, "suppressed", buffered);
      this._commitSuppression(output, state);
    } else if (this.mode === "continuous_fallback") {
      this._commitDegraded(output, state, at);
    }
    state.retainUntil = null;
    output.state = this.mode;
    return output;
  }

  reportVadFailure(sourceType, _error, at) {
    const type = assertSourceType(sourceType);
    assertDuration(at, "at");
    const state = this._source(type);
    const output = decision(type);
    if (this.mode === "speech_triggered") {
      this._commitSuppression(output, state);
      for (const buffered of state.ring.drain()) this._retain(output, buffered);
    }
    state.degradedStart ??= at;
    state.retainUntil = null;
    this.mode = "continuous_fallback";
    this.degradedReason = "vad_unavailable";
    output.retain = output.writes.length > 0;
    output.state = this.mode;
    return output;
  }

  reportVadRecovered(sourceType, at) {
    const type = assertSourceType(sourceType);
    assertDuration(at, "at");
    const state = this._source(type);
    const output = decision(type);
    this._commitDegraded(output, state, at);
    this.mode = this.requestedMode;
    this.degradedReason = null;
    state.retainUntil = null;
    output.state = this.mode;
    return output;
  }

  switchMode(sourceType, mode, at) {
    const type = assertSourceType(sourceType);
    assertDuration(at, "at");
    if (mode !== "speech_triggered" && mode !== "continuous") {
      throw new TypeError("invalid retention mode");
    }
    const state = this._source(type);
    const output = decision(type);
    if (mode === "continuous" && this.mode === "speech_triggered") {
      this._commitSuppression(output, state);
      for (const buffered of state.ring.drain()) this._retain(output, buffered);
    } else if (this.mode === "continuous_fallback") {
      this._commitDegraded(output, state, at);
    }
    this.mode = mode;
    this.requestedMode = mode;
    this.degradedReason = null;
    state.retainUntil = null;
    output.state = mode;
    return output;
  }

  bufferedFrames(sourceType) {
    return this._source(assertSourceType(sourceType)).ring.frameCount;
  }

  status() {
    return {
      mode: this.mode,
      requestedMode: this.requestedMode,
      degradedReason: this.degradedReason,
      lastSpeechProbability: this.lastSpeechProbability,
    };
  }

  _source(sourceType) {
    let state = this.sources.get(sourceType);
    if (!state) {
      state = {
        ring: new PcmRingBuffer({
          capacityFrames: Math.round((this.sampleRate * this.preRollMs) / 1_000),
          bytesPerFrame: this.bytesPerFrame,
        }),
        retainUntil: null,
        lastProcessedAt: null,
        suppressed: null,
        degraded: null,
        degradedStart: null,
      };
      this.sources.set(sourceType, state);
    }
    return state;
  }

  _entry(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("capture gate input is required");
    }
    const sourceType = assertSourceType(input.sourceType);
    const pcm = Buffer.isBuffer(input.pcm) ? input.pcm : Buffer.from(input.pcm ?? []);
    if (pcm.length === 0 || pcm.length % this.bytesPerFrame !== 0) {
      throw new RangeError("PCM must contain complete non-empty frames");
    }
    if (!Number.isSafeInteger(input.capturedAt)) {
      throw new TypeError("capturedAt must be a safe integer");
    }
    if (
      typeof input.speechProbability !== "number" ||
      !Number.isFinite(input.speechProbability) ||
      input.speechProbability < 0 ||
      input.speechProbability > 1
    ) {
      throw new RangeError("speechProbability must be between zero and one");
    }
    const frameCount = pcm.length / this.bytesPerFrame;
    const durationMs = Math.round((frameCount * 1_000) / this.sampleRate);
    return {
      sourceType,
      pcm: Buffer.from(pcm),
      startedAt: input.capturedAt,
      endedAt: input.capturedAt + durationMs,
    };
  }

  _buffer(state, entry) {
    for (const evicted of state.ring.push(entry)) {
      this._accumulate(state, "suppressed", evicted);
    }
  }

  _retain(output, entry) {
    output.retain = true;
    output.writes.push(entry);
  }

  _accumulate(state, key, entry) {
    const level = measurePcm(entry.pcm);
    if (!state[key]) {
      state[key] = {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        squaredTotal: level.squaredTotal,
        sampleCount: level.sampleCount,
        peakLevel: level.peakLevel,
      };
      return;
    }
    state[key].endedAt = entry.endedAt;
    state[key].squaredTotal += level.squaredTotal;
    state[key].sampleCount += level.sampleCount;
    state[key].peakLevel = Math.max(state[key].peakLevel, level.peakLevel);
  }

  _gap(reason, aggregate, endedAt = aggregate.endedAt) {
    return {
      reason,
      startedAt: aggregate.startedAt,
      endedAt,
      averageLevel:
        aggregate.sampleCount === 0 ? 0 : Math.sqrt(aggregate.squaredTotal / aggregate.sampleCount),
      peakLevel: aggregate.peakLevel,
    };
  }

  _commitSuppression(output, state) {
    if (!state.suppressed) return;
    output.gapsToCommit.push(this._gap("silence_suppressed", state.suppressed));
    state.suppressed = null;
  }

  _commitDegraded(output, state, at) {
    if (state.degradedStart === null) return;
    const aggregate = state.degraded ?? {
      startedAt: state.degradedStart,
      endedAt: at,
      squaredTotal: 0,
      sampleCount: 0,
      peakLevel: 0,
    };
    aggregate.startedAt = state.degradedStart;
    output.gapsToCommit.push(this._gap("vad_degraded", aggregate, at));
    state.degraded = null;
    state.degradedStart = null;
  }
}

module.exports = SpeechTriggeredCaptureGate;
