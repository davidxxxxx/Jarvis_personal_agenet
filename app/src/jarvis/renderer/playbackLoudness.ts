type PlaybackSource = "mic" | "system";

export interface PlaybackLoudnessResult {
  bytes: Uint8Array;
  appliedGain: number;
}

const PCM_FORMAT = 1;
const PCM_16_BITS = 16;
const SILENCE_PEAK = 64;
const SYSTEM_GAIN_MIN_RMS = 96;
const SYSTEM_GATE_RMS = 48;
const SYSTEM_GATE_PEAK = 256;
const TARGET_PEAK: Record<PlaybackSource, number> = {
  mic: 0.82 * 32_767,
  system: 0.9 * 32_767,
};
const MAX_GAIN: Record<PlaybackSource, number> = {
  mic: 4,
  system: 2,
};

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function locatePcm16Data(
  bytes: Uint8Array
): { offset: number; length: number; sampleRate: number } | null {
  if (
    bytes.byteLength < 44 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let isPcm16 = false;
  let sampleRate = 24_000;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (payloadOffset + length > bytes.byteLength) return null;
    if (id === "fmt " && length >= 16) {
      isPcm16 =
        view.getUint16(payloadOffset, true) === PCM_FORMAT &&
        view.getUint16(payloadOffset + 14, true) === PCM_16_BITS;
      sampleRate = view.getUint32(payloadOffset + 4, true);
    } else if (id === "data") {
      return isPcm16
        ? { offset: payloadOffset, length: length - (length % 2), sampleRate }
        : null;
    }
    offset = payloadOffset + length + (length % 2);
  }
  return null;
}

export function normalizeWavForPlayback(
  source: Uint8Array,
  sourceType: PlaybackSource
): PlaybackLoudnessResult {
  const data = locatePcm16Data(source);
  if (!data || data.length === 0) return { bytes: source, appliedGain: 1 };

  const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let peak = 0;
  let squared = 0;
  let sampleCount = 0;
  for (let offset = data.offset; offset < data.offset + data.length; offset += 2) {
    const sample = input.getInt16(offset, true);
    peak = Math.max(peak, Math.abs(sample));
    squared += sample * sample;
    sampleCount += 1;
  }
  // Preserve true microphone silence byte-for-byte, but still pass low-level
  // system loopback through the noise gate below.
  if (sourceType === "mic" && peak < SILENCE_PEAK) {
    return { bytes: source, appliedGain: 1 };
  }

  const rms = sampleCount > 0 ? Math.sqrt(squared / sampleCount) : 0;
  const candidateGain = Math.min(MAX_GAIN[sourceType], TARGET_PEAK[sourceType] / peak);
  const gain =
    sourceType === "system" && rms < SYSTEM_GAIN_MIN_RMS ? 1 : candidateGain;
  const shouldGain = Number.isFinite(gain) && gain > 1.05;
  const shouldGate = sourceType === "system";
  if (!shouldGain && !shouldGate) return { bytes: source, appliedGain: 1 };

  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const output = new DataView(bytes.buffer);
  let changed = false;
  const samplesPerFrame = Math.max(1, Math.round(data.sampleRate / 50));
  for (
    let frameStart = data.offset;
    frameStart < data.offset + data.length;
    frameStart += samplesPerFrame * 2
  ) {
    const frameEnd = Math.min(
      data.offset + data.length,
      frameStart + samplesPerFrame * 2
    );
    let frameSquared = 0;
    let framePeak = 0;
    let frameSamples = 0;
    for (let offset = frameStart; offset < frameEnd; offset += 2) {
      const sample = input.getInt16(offset, true);
      frameSquared += sample * sample;
      framePeak = Math.max(framePeak, Math.abs(sample));
      frameSamples += 1;
    }
    const frameRms = frameSamples > 0 ? Math.sqrt(frameSquared / frameSamples) : 0;
    const gateFrame =
      shouldGate && frameRms < SYSTEM_GATE_RMS && framePeak < SYSTEM_GATE_PEAK;
    for (let offset = frameStart; offset < frameEnd; offset += 2) {
      const original = input.getInt16(offset, true);
      const sample = gateFrame ? 0 : Math.round(original * (shouldGain ? gain : 1));
      const bounded = Math.max(-32_768, Math.min(32_767, sample));
      output.setInt16(offset, bounded, true);
      if (bounded !== original) changed = true;
    }
  }
  return {
    bytes: changed ? bytes : source,
    appliedGain: shouldGain ? gain : 1,
  };
}
