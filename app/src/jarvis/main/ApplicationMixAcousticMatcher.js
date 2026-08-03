const FRAME_MS = 20;
const MAX_DRIFT_MS = 5_000;
const MIN_OVERLAP_MS = 1_000;
const MIN_ACTIVE_MS = 800;
const MIN_CORRELATION = 0.88;
const MIN_WINNER_MARGIN = 0.08;
const MIN_VOICED_COVERAGE = 0.8;
const MIN_MIXED_COVERAGE = 0.98;
const MAX_UNMATCHED_MIXED_MS = 250;
const MIN_WAVEFORM_CORRELATION = 0.92;
const MIN_FEATURE_STDDEV = 0.12;
const ENERGY_SCALE = 100_000;
const ACTIVE_RMS = 0.002;
const ACTIVE_FEATURE = Math.log1p(ACTIVE_RMS * ACTIVE_RMS * ENERGY_SCALE);
const DEFAULT_CACHE_ENTRIES = 24;
const WAVEFORM_SAMPLE_RATE = 4_000;
const WAVEFORM_SEARCH_STEP_MS = 1;

function assertFiniteInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return value;
}

function energyEnvelope(pcm, { frameMs = FRAME_MS } = {}) {
  if (!pcm || !Buffer.isBuffer(pcm.bytes)) throw new TypeError("PCM bytes are required");
  const sampleRate = assertFiniteInteger(pcm.sampleRate, "PCM sampleRate");
  const channels = assertFiniteInteger(pcm.channels, "PCM channels");
  if (sampleRate <= 0 || channels <= 0 || pcm.bytes.length % (channels * 2) !== 0) {
    throw new RangeError("PCM format is invalid");
  }
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1_000));
  const sampleCount = pcm.bytes.length / (channels * 2);
  const frameCount = Math.floor(sampleCount / samplesPerFrame);
  const values = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sumSquares = 0;
    const firstSample = frame * samplesPerFrame;
    for (let sample = 0; sample < samplesPerFrame; sample += 1) {
      const byteOffset = (firstSample + sample) * channels * 2;
      let mono = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        mono += pcm.bytes.readInt16LE(byteOffset + channel * 2) / 32_768;
      }
      mono /= channels;
      sumSquares += mono * mono;
    }
    values[frame] = Math.log1p((sumSquares / samplesPerFrame) * ENERGY_SCALE);
  }
  return values;
}

function downsampleMono(pcm, { targetSampleRate = WAVEFORM_SAMPLE_RATE } = {}) {
  if (!pcm || !Buffer.isBuffer(pcm.bytes)) throw new TypeError("PCM bytes are required");
  const sampleRate = assertFiniteInteger(pcm.sampleRate, "PCM sampleRate");
  const channels = assertFiniteInteger(pcm.channels, "PCM channels");
  if (
    sampleRate <= 0 ||
    channels <= 0 ||
    !Number.isSafeInteger(targetSampleRate) ||
    targetSampleRate <= 0 ||
    pcm.bytes.length % (channels * 2) !== 0
  ) {
    throw new RangeError("PCM format is invalid");
  }
  const outputSampleRate = Math.min(sampleRate, targetSampleRate);
  const inputSampleCount = pcm.bytes.length / (channels * 2);
  const outputSampleCount = Math.floor((inputSampleCount * outputSampleRate) / sampleRate);
  const values = new Float64Array(outputSampleCount);
  for (let outputIndex = 0; outputIndex < outputSampleCount; outputIndex += 1) {
    const firstInput = Math.floor((outputIndex * sampleRate) / outputSampleRate);
    const lastInput = Math.max(
      firstInput + 1,
      Math.floor(((outputIndex + 1) * sampleRate) / outputSampleRate)
    );
    let sum = 0;
    let count = 0;
    for (let inputIndex = firstInput; inputIndex < lastInput; inputIndex += 1) {
      const byteOffset = inputIndex * channels * 2;
      let mono = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        mono += pcm.bytes.readInt16LE(byteOffset + channel * 2) / 32_768;
      }
      sum += mono / channels;
      count += 1;
    }
    values[outputIndex] = count === 0 ? 0 : sum / count;
  }
  return { values, sampleRate: outputSampleRate };
}

function activeFrameCount(values) {
  let count = 0;
  for (const value of values) {
    if (value >= ACTIVE_FEATURE) count += 1;
  }
  return count;
}

function alignmentScore(mixed, application, shiftFrames) {
  const start = Math.max(0, shiftFrames);
  const end = Math.min(mixed.length, application.length + shiftFrames);
  const count = end - start;
  if (count <= 0) return null;

  let sumMixed = 0;
  let sumApplication = 0;
  let sumMixedSquares = 0;
  let sumApplicationSquares = 0;
  let sumProduct = 0;
  let activeFrames = 0;
  let coveredActiveFrames = 0;
  for (let mixedIndex = start; mixedIndex < end; mixedIndex += 1) {
    const applicationIndex = mixedIndex - shiftFrames;
    const mixedValue = mixed[mixedIndex];
    const applicationValue = application[applicationIndex];
    sumMixed += mixedValue;
    sumApplication += applicationValue;
    sumMixedSquares += mixedValue * mixedValue;
    sumApplicationSquares += applicationValue * applicationValue;
    sumProduct += mixedValue * applicationValue;
    if (applicationValue >= ACTIVE_FEATURE) {
      activeFrames += 1;
      if (mixedValue >= ACTIVE_FEATURE) coveredActiveFrames += 1;
    }
  }

  const mixedVariance = sumMixedSquares - (sumMixed * sumMixed) / count;
  const applicationVariance = sumApplicationSquares - (sumApplication * sumApplication) / count;
  if (mixedVariance <= Number.EPSILON || applicationVariance <= Number.EPSILON) return null;
  const covariance = sumProduct - (sumMixed * sumApplication) / count;
  const correlation = covariance / Math.sqrt(mixedVariance * applicationVariance);
  if (!Number.isFinite(correlation)) return null;
  return {
    correlation,
    frameCount: count,
    activeFrames,
    coveredActiveFrames,
    voicedCoverage: activeFrames === 0 ? 0 : coveredActiveFrames / activeFrames,
    mixedStddev: Math.sqrt(mixedVariance / count),
    applicationStddev: Math.sqrt(applicationVariance / count),
  };
}

function bestAlignment(
  mixed,
  application,
  {
    mixedStartedAt,
    applicationStartedAt,
    frameMs = FRAME_MS,
    maxDriftMs = MAX_DRIFT_MS,
    minMixedCoverage = MIN_MIXED_COVERAGE,
    maxUnmatchedMixedMs = MAX_UNMATCHED_MIXED_MS,
  }
) {
  const baseShiftFrames = Math.round((applicationStartedAt - mixedStartedAt) / frameMs);
  const maxDriftFrames = Math.floor(maxDriftMs / frameMs);
  const totalMixedActiveFrames = activeFrameCount(mixed);
  let best = null;
  for (
    let shiftFrames = baseShiftFrames - maxDriftFrames;
    shiftFrames <= baseShiftFrames + maxDriftFrames;
    shiftFrames += 1
  ) {
    const score = alignmentScore(mixed, application, shiftFrames);
    if (!score) continue;
    const mixedCoverage = mixed.length === 0 ? 0 : score.frameCount / mixed.length;
    const unmatchedMixedMs = (mixed.length - score.frameCount) * frameMs;
    const mixedActiveCoverage =
      totalMixedActiveFrames === 0 ? 0 : score.coveredActiveFrames / totalMixedActiveFrames;
    if (
      mixedCoverage >= minMixedCoverage &&
      unmatchedMixedMs <= maxUnmatchedMixedMs &&
      (!best ||
        mixedCoverage > best.mixedCoverage ||
        (mixedCoverage === best.mixedCoverage &&
          (score.correlation > best.correlation ||
            (score.correlation === best.correlation &&
              Math.abs(shiftFrames - baseShiftFrames) <
                Math.abs(best.shiftFrames - baseShiftFrames)))))
    ) {
      best = {
        ...score,
        mixedCoverage,
        unmatchedMixedMs,
        mixedActiveCoverage,
        shiftFrames,
        lagMs: (shiftFrames - baseShiftFrames) * frameMs,
      };
    }
  }
  return best;
}

function waveformCorrelation(mixed, application, shiftSamples) {
  const start = Math.max(0, shiftSamples);
  const end = Math.min(mixed.length, application.length + shiftSamples);
  const count = end - start;
  if (count <= 1) return null;
  let sumMixed = 0;
  let sumApplication = 0;
  let sumMixedSquares = 0;
  let sumApplicationSquares = 0;
  let sumProduct = 0;
  for (let mixedIndex = start; mixedIndex < end; mixedIndex += 1) {
    const applicationIndex = mixedIndex - shiftSamples;
    const mixedValue = mixed[mixedIndex];
    const applicationValue = application[applicationIndex];
    sumMixed += mixedValue;
    sumApplication += applicationValue;
    sumMixedSquares += mixedValue * mixedValue;
    sumApplicationSquares += applicationValue * applicationValue;
    sumProduct += mixedValue * applicationValue;
  }
  const mixedVariance = sumMixedSquares - (sumMixed * sumMixed) / count;
  const applicationVariance = sumApplicationSquares - (sumApplication * sumApplication) / count;
  if (mixedVariance <= Number.EPSILON || applicationVariance <= Number.EPSILON) return null;
  const covariance = sumProduct - (sumMixed * sumApplication) / count;
  const correlation = covariance / Math.sqrt(mixedVariance * applicationVariance);
  if (!Number.isFinite(correlation)) return null;
  return { correlation, sampleCount: count };
}

function bestWaveformAlignment(
  mixed,
  application,
  {
    coarseShiftMs,
    frameMs = FRAME_MS,
    searchStepMs = WAVEFORM_SEARCH_STEP_MS,
    minMixedCoverage = MIN_MIXED_COVERAGE,
    maxUnmatchedMixedMs = MAX_UNMATCHED_MIXED_MS,
  }
) {
  if (
    !mixed ||
    !application ||
    mixed.sampleRate !== application.sampleRate ||
    mixed.values.length === 0 ||
    application.values.length === 0
  ) {
    return null;
  }
  const sampleRate = mixed.sampleRate;
  const coarseShiftSamples = Math.round((coarseShiftMs * sampleRate) / 1_000);
  const radiusSamples = Math.max(1, Math.ceil((frameMs * sampleRate) / 1_000));
  const stepSamples = Math.max(1, Math.round((searchStepMs * sampleRate) / 1_000));
  let best = null;
  const consider = (shiftSamples) => {
    const score = waveformCorrelation(mixed.values, application.values, shiftSamples);
    if (!score) return;
    const mixedCoverage = score.sampleCount / mixed.values.length;
    const unmatchedMixedMs = ((mixed.values.length - score.sampleCount) * 1_000) / sampleRate;
    if (mixedCoverage < minMixedCoverage || unmatchedMixedMs > maxUnmatchedMixedMs) {
      return;
    }
    if (
      !best ||
      mixedCoverage > best.mixedCoverage ||
      (mixedCoverage === best.mixedCoverage &&
        (score.correlation > best.correlation ||
          (score.correlation === best.correlation &&
            Math.abs(shiftSamples - coarseShiftSamples) <
              Math.abs(best.shiftSamples - coarseShiftSamples))))
    ) {
      best = { ...score, mixedCoverage, unmatchedMixedMs, shiftSamples };
    }
  };
  for (
    let shiftSamples = coarseShiftSamples - radiusSamples;
    shiftSamples <= coarseShiftSamples + radiusSamples;
    shiftSamples += stepSamples
  ) {
    consider(shiftSamples);
  }
  if (!best) return null;
  const coarseBest = best.shiftSamples;
  for (
    let shiftSamples = coarseBest - stepSamples + 1;
    shiftSamples < coarseBest + stepSamples;
    shiftSamples += 1
  ) {
    consider(shiftSamples);
  }
  return {
    ...best,
    shiftMs: (best.shiftSamples * 1_000) / sampleRate,
  };
}

function stableApplicationKey(segment) {
  return segment.application_key || segment.track_id || segment.id;
}

class ApplicationMixAcousticMatcher {
  constructor({
    audioEvidenceReader,
    getAudioChunk,
    frameMs = FRAME_MS,
    maxDriftMs = MAX_DRIFT_MS,
    minOverlapMs = MIN_OVERLAP_MS,
    minActiveMs = MIN_ACTIVE_MS,
    minCorrelation = MIN_CORRELATION,
    minWinnerMargin = MIN_WINNER_MARGIN,
    minVoicedCoverage = MIN_VOICED_COVERAGE,
    minMixedCoverage = MIN_MIXED_COVERAGE,
    maxUnmatchedMixedMs = MAX_UNMATCHED_MIXED_MS,
    minWaveformCorrelation = MIN_WAVEFORM_CORRELATION,
    cacheEntries = DEFAULT_CACHE_ENTRIES,
    log = () => {},
  } = {}) {
    if (!audioEvidenceReader || typeof audioEvidenceReader.readVerifiedPcm !== "function") {
      throw new TypeError("audioEvidenceReader.readVerifiedPcm must be a function");
    }
    if (typeof getAudioChunk !== "function") {
      throw new TypeError("getAudioChunk must be a function");
    }
    this.audioEvidenceReader = audioEvidenceReader;
    this.getAudioChunk = getAudioChunk;
    this.frameMs = frameMs;
    this.maxDriftMs = maxDriftMs;
    this.minOverlapFrames = Math.ceil(minOverlapMs / frameMs);
    this.minActiveFrames = Math.ceil(minActiveMs / frameMs);
    this.minCorrelation = minCorrelation;
    this.minWinnerMargin = minWinnerMargin;
    this.minVoicedCoverage = minVoicedCoverage;
    this.minMixedCoverage = minMixedCoverage;
    this.maxUnmatchedMixedMs = maxUnmatchedMixedMs;
    this.minWaveformCorrelation = minWaveformCorrelation;
    this.cacheEntries = Math.max(1, cacheEntries);
    this.log = log;
    this.cache = new Map();
  }

  async _features(chunk) {
    if (!chunk || chunk.deleted_at != null || typeof chunk.path !== "string") return null;
    const hash = chunk.pcm_sha256 ?? chunk.sha256;
    if (typeof hash !== "string" || !hash) return null;
    const key = `${chunk.id}:${hash}:${this.frameMs}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pcm = await this.audioEvidenceReader.readVerifiedPcm(chunk);
    const features = {
      envelope: energyEnvelope(pcm, { frameMs: this.frameMs }),
      waveform: downsampleMono(pcm),
    };
    this.cache.set(key, features);
    while (this.cache.size > this.cacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return features;
  }

  async _candidate(mixed, mixedFeatures, application) {
    if (application?.attribution_state !== "exact" || typeof application?.chunk_id !== "string") {
      return null;
    }
    const chunk = this.getAudioChunk(application.chunk_id);
    if (!chunk) return null;
    const applicationFeatures = await this._features(chunk);
    if (!applicationFeatures?.envelope?.length) return null;
    const score = bestAlignment(mixedFeatures.envelope, applicationFeatures.envelope, {
      mixedStartedAt: mixed.started_at,
      applicationStartedAt: application.started_at,
      frameMs: this.frameMs,
      maxDriftMs: this.maxDriftMs,
      minMixedCoverage: this.minMixedCoverage,
      maxUnmatchedMixedMs: this.maxUnmatchedMixedMs,
    });
    if (
      !score ||
      score.frameCount < this.minOverlapFrames ||
      score.activeFrames < this.minActiveFrames ||
      score.correlation < this.minCorrelation ||
      score.voicedCoverage < this.minVoicedCoverage ||
      score.mixedCoverage < this.minMixedCoverage ||
      score.mixedStddev < MIN_FEATURE_STDDEV ||
      score.applicationStddev < MIN_FEATURE_STDDEV
    ) {
      return null;
    }
    const waveform = bestWaveformAlignment(mixedFeatures.waveform, applicationFeatures.waveform, {
      coarseShiftMs: score.shiftFrames * this.frameMs,
      frameMs: this.frameMs,
      minMixedCoverage: this.minMixedCoverage,
      maxUnmatchedMixedMs: this.maxUnmatchedMixedMs,
    });
    if (!waveform || waveform.correlation < this.minWaveformCorrelation) return null;
    return {
      segment: application,
      ...score,
      envelopeCorrelation: score.correlation,
      correlation: waveform.correlation,
      waveformShiftMs: waveform.shiftMs,
    };
  }

  async findWinner(mixed, applications) {
    if (!mixed || typeof mixed.chunk_id !== "string" || !Array.isArray(applications)) return null;
    const mixedChunk = this.getAudioChunk(mixed.chunk_id);
    if (!mixedChunk) return null;
    let mixedFeatures;
    try {
      mixedFeatures = await this._features(mixedChunk);
    } catch (error) {
      this.log({ phase: "application_mix_acoustic_read", segmentId: mixed.id, error });
      return null;
    }
    if (!mixedFeatures?.envelope?.length) return null;

    const byApplication = new Map();
    for (const application of applications) {
      try {
        const candidate = await this._candidate(mixed, mixedFeatures, application);
        if (!candidate) continue;
        const key = stableApplicationKey(application);
        const existing = byApplication.get(key);
        if (!existing || candidate.correlation > existing.correlation) {
          byApplication.set(key, candidate);
        }
      } catch (error) {
        this.log({
          phase: "application_mix_acoustic_candidate",
          segmentId: mixed.id,
          applicationSegmentId: application?.id ?? null,
          error,
        });
      }
    }
    const ranked = [...byApplication.values()].sort(
      (left, right) =>
        right.correlation - left.correlation ||
        String(left.segment.id).localeCompare(String(right.segment.id))
    );
    if (!ranked[0]) return null;
    if (ranked[1] && ranked[0].correlation - ranked[1].correlation < this.minWinnerMargin) {
      return null;
    }
    return ranked[0];
  }
}

module.exports = ApplicationMixAcousticMatcher;
module.exports.energyEnvelope = energyEnvelope;
module.exports.downsampleMono = downsampleMono;
module.exports.alignmentScore = alignmentScore;
module.exports.bestAlignment = bestAlignment;
module.exports.waveformCorrelation = waveformCorrelation;
module.exports.bestWaveformAlignment = bestWaveformAlignment;
module.exports.constants = Object.freeze({
  FRAME_MS,
  MAX_DRIFT_MS,
  MIN_OVERLAP_MS,
  MIN_ACTIVE_MS,
  MIN_CORRELATION,
  MIN_WINNER_MARGIN,
  MIN_VOICED_COVERAGE,
  MIN_MIXED_COVERAGE,
  MAX_UNMATCHED_MIXED_MS,
  MIN_WAVEFORM_CORRELATION,
});
