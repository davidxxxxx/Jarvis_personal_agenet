function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function cloneEntry(entry, bytesPerFrame) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("PCM ring entry must be an object");
  }
  const pcm = Buffer.isBuffer(entry.pcm) ? entry.pcm : Buffer.from(entry.pcm ?? []);
  if (pcm.length % bytesPerFrame !== 0) {
    throw new RangeError("PCM ring entry must contain complete frames");
  }
  if (!Number.isSafeInteger(entry.startedAt) || !Number.isSafeInteger(entry.endedAt)) {
    throw new TypeError("PCM ring entry timestamps must be safe integers");
  }
  if (entry.endedAt < entry.startedAt) {
    throw new RangeError("PCM ring entry must not end before it starts");
  }
  return { ...entry, pcm: Buffer.from(pcm) };
}

function splitEntry(entry, leadingFrames, bytesPerFrame) {
  const totalFrames = entry.pcm.length / bytesPerFrame;
  if (!Number.isSafeInteger(leadingFrames) || leadingFrames <= 0 || leadingFrames >= totalFrames) {
    throw new RangeError("leadingFrames must split the PCM entry");
  }
  const byteOffset = leadingFrames * bytesPerFrame;
  const durationMs = entry.endedAt - entry.startedAt;
  const splitAt = entry.startedAt + Math.round((durationMs * leadingFrames) / totalFrames);
  return [
    { ...entry, pcm: Buffer.from(entry.pcm.subarray(0, byteOffset)), endedAt: splitAt },
    { ...entry, pcm: Buffer.from(entry.pcm.subarray(byteOffset)), startedAt: splitAt },
  ];
}

class PcmRingBuffer {
  constructor({ capacityFrames, bytesPerFrame }) {
    this.capacityFrames = assertNonNegativeInteger(capacityFrames, "capacityFrames");
    this.bytesPerFrame = assertPositiveInteger(bytesPerFrame, "bytesPerFrame");
    this.entries = [];
    this.frameCount = 0;
  }

  get byteLength() {
    return this.frameCount * this.bytesPerFrame;
  }

  push(input) {
    const entry = cloneEntry(input, this.bytesPerFrame);
    const frames = entry.pcm.length / this.bytesPerFrame;
    if (frames === 0) return [];
    this.entries.push(entry);
    this.frameCount += frames;

    const evicted = [];
    while (this.frameCount > this.capacityFrames && this.entries.length > 0) {
      const overflow = this.frameCount - this.capacityFrames;
      const head = this.entries[0];
      const headFrames = head.pcm.length / this.bytesPerFrame;
      if (headFrames <= overflow) {
        this.entries.shift();
        this.frameCount -= headFrames;
        evicted.push(head);
        continue;
      }
      const [removed, retained] = splitEntry(head, overflow, this.bytesPerFrame);
      this.entries[0] = retained;
      this.frameCount -= overflow;
      evicted.push(removed);
    }
    return evicted;
  }

  drain() {
    const entries = this.entries;
    this.entries = [];
    this.frameCount = 0;
    return entries;
  }

  clear() {
    this.entries = [];
    this.frameCount = 0;
  }
}

module.exports = PcmRingBuffer;
module.exports.splitEntry = splitEntry;
