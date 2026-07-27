import { describe, expect, it } from "vitest";
import { normalizeWavForPlayback } from "../playbackLoudness";

function pcm16Wav(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

function samplesFrom(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: number[] = [];
  for (let offset = 44; offset + 1 < bytes.byteLength; offset += 2) {
    result.push(view.getInt16(offset, true));
  }
  return result;
}

describe("normalizeWavForPlayback", () => {
  it("boosts quiet microphone speech without modifying the source bytes", () => {
    const source = pcm16Wav([0, 500, -1_000, 2_000, -3_000, 1_500]);
    const before = samplesFrom(source);

    const result = normalizeWavForPlayback(source, "mic");

    expect(result.appliedGain).toBeGreaterThan(1);
    expect(samplesFrom(source)).toEqual(before);
    expect(Math.max(...samplesFrom(result.bytes).map(Math.abs))).toBeGreaterThan(3_000);
  });

  it("does not amplify confirmed silence", () => {
    const source = pcm16Wav([0, 1, -1, 2, -2, 0]);

    const result = normalizeWavForPlayback(source, "mic");

    expect(result.appliedGain).toBe(1);
    expect(samplesFrom(result.bytes)).toEqual(samplesFrom(source));
  });

  it("keeps loud system audio below the PCM clipping limit", () => {
    const source = pcm16Wav([0, 12_000, -24_000, 30_000, -31_000]);

    const result = normalizeWavForPlayback(source, "system");
    const peak = Math.max(...samplesFrom(result.bytes).map(Math.abs));

    expect(result.appliedGain).toBe(1);
    expect(peak).toBeLessThanOrEqual(32_767);
  });

  it("gates low-level system loopback noise instead of amplifying it", () => {
    const source = pcm16Wav(Array.from({ length: 960 }, (_, index) => (index % 2 ? 30 : -30)));

    const result = normalizeWavForPlayback(source, "system");

    expect(result.appliedGain).toBe(1);
    expect(samplesFrom(result.bytes).every((sample) => sample === 0)).toBe(true);
  });
});
