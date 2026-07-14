const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertId, assertSourceType } = require("../shared/contracts");

const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1_000;
const MAX_BUFFER_MS = 120_000;
const WATERMARK_MS = 15_000;

function rangeBoundary(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function boundedRange(fromMs, throughMs) {
  const from = rangeBoundary(fromMs, "fromMs");
  const through = rangeBoundary(throughMs, "throughMs");
  if (through <= from) throw new RangeError("preview range must be increasing");
  if (through - from > MAX_BUFFER_MS) {
    throw new RangeError(`preview range must not exceed ${MAX_BUFFER_MS} ms`);
  }
  return { fromMs: from, throughMs: through };
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function keyFor(sessionId, trackId) {
  return `${sessionId}\u0000${trackId}`;
}

class PreviewAudioRing {
  constructor({ rootDir, fsImpl = fs } = {}) {
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw new TypeError("rootDir must be an absolute path");
    }
    if (!fsImpl.promises || typeof fsImpl.promises.open !== "function") {
      throw new TypeError("fsImpl.promises must provide asynchronous file operations");
    }
    this.rootDir = path.resolve(rootDir);
    this.fsPromises = fsImpl.promises;
    this.entries = new Map();
    this.activeFiles = new Set();
    this.activeOperations = new Set();
    this.ready = this._prepareRoot();
  }

  _prepareRoot() {
    return this.fsPromises
      .mkdir(this.rootDir, { recursive: true })
      .then(() => this._cleanupPreviewArtifacts(this.rootDir, 0, { remaining: 1_024 }))
      .catch(() => 0);
  }

  append({ sessionId, trackId, sourceType, fromMs, throughMs, pcm } = {}) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(trackId, "trackId");
    const safeSourceType = assertSourceType(sourceType);
    const range = boundedRange(fromMs, throughMs);
    const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
    const expectedBytes = (range.throughMs - range.fromMs) * BYTES_PER_MS;
    if (audio.length !== expectedBytes || audio.length % BYTES_PER_SAMPLE !== 0) {
      throw new RangeError("PCM bytes must exactly match the preview range");
    }
    const key = keyFor(safeSessionId, safeTrackId);
    const entry = this.entries.get(key) ?? {
      sessionId: safeSessionId,
      trackId: safeTrackId,
      sourceType: safeSourceType,
      frames: [],
      latestThroughMs: range.fromMs,
      lastWatermarkMs: Math.floor(range.fromMs / WATERMARK_MS) * WATERMARK_MS,
    };
    if (entry.sourceType !== safeSourceType) throw new Error("preview track source changed");
    if (range.fromMs < entry.latestThroughMs) {
      throw new RangeError("preview PCM ranges must be monotonic and non-overlapping");
    }
    entry.frames.push({ ...range, pcm: Buffer.from(audio) });
    entry.latestThroughMs = range.throughMs;
    const cutoff = Math.max(0, entry.latestThroughMs - MAX_BUFFER_MS);
    entry.frames = entry.frames
      .filter((frame) => frame.throughMs > cutoff)
      .map((frame) => {
        if (frame.fromMs >= cutoff) return frame;
        const trimBytes = (cutoff - frame.fromMs) * BYTES_PER_MS;
        return { ...frame, fromMs: cutoff, pcm: frame.pcm.subarray(trimBytes) };
      });
    const watermarks = [];
    while (entry.lastWatermarkMs + WATERMARK_MS <= entry.latestThroughMs) {
      entry.lastWatermarkMs += WATERMARK_MS;
      watermarks.push(entry.lastWatermarkMs);
    }
    this.entries.set(key, entry);
    return watermarks;
  }

  withPreviewWav(input = {}, callback) {
    let tracked;
    const operation = this._withPreviewWav(input, callback);
    tracked = Promise.resolve(operation).finally(() => {
      this.activeOperations.delete(tracked);
    });
    this.activeOperations.add(tracked);
    return tracked;
  }

  async _withPreviewWav({ sessionId, trackId, fromMs, throughMs } = {}, callback) {
    const safeSessionId = assertId(sessionId, "sessionId");
    const safeTrackId = assertId(trackId, "trackId");
    const range = boundedRange(fromMs, throughMs);
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const entry = this.entries.get(keyFor(safeSessionId, safeTrackId));
    if (!entry || range.fromMs >= entry.latestThroughMs) return null;
    await this.ready;
    const actualThroughMs = Math.min(range.throughMs, entry.latestThroughMs);
    const actualFromMs = Math.max(
      range.fromMs,
      actualThroughMs - MAX_BUFFER_MS,
      entry.frames[0]?.fromMs ?? actualThroughMs
    );
    if (actualThroughMs <= actualFromMs) return null;
    const output = Buffer.alloc((actualThroughMs - actualFromMs) * BYTES_PER_MS);
    let copied = false;
    for (const frame of entry.frames) {
      const overlapFrom = Math.max(frame.fromMs, actualFromMs);
      const overlapThrough = Math.min(frame.throughMs, actualThroughMs);
      if (overlapThrough <= overlapFrom) continue;
      const sourceStart = (overlapFrom - frame.fromMs) * BYTES_PER_MS;
      const sourceEnd = (overlapThrough - frame.fromMs) * BYTES_PER_MS;
      const targetStart = (overlapFrom - actualFromMs) * BYTES_PER_MS;
      frame.pcm.copy(output, targetStart, sourceStart, sourceEnd);
      copied = true;
    }
    if (!copied) return null;

    const directory = path.join(this.rootDir, safeSessionId, safeTrackId);
    const digest = crypto
      .createHash("sha256")
      .update(
        `${safeSessionId}\u0000${safeTrackId}\u0000${actualFromMs}\u0000${actualThroughMs}\u0000`
      )
      .update(output)
      .digest("hex");
    const finalPath = path.join(directory, `${digest}.preview.wav`);
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    const resolvedFinalPath = path.resolve(finalPath);
    const resolvedTemporaryPath = path.resolve(temporaryPath);
    this.activeFiles.add(resolvedFinalPath);
    this.activeFiles.add(resolvedTemporaryPath);
    let handle = null;
    try {
      await this.fsPromises.mkdir(directory, { recursive: true });
      handle = await this.fsPromises.open(temporaryPath, "wx");
      await handle.writeFile(Buffer.concat([wavHeader(output.length), output]));
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fsPromises.rename(temporaryPath, finalPath);
      return await callback({
        path: finalPath,
        sourceType: entry.sourceType,
        fromMs: actualFromMs,
        throughMs: actualThroughMs,
        sha256: digest,
      });
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {}
      }
      for (const candidate of [temporaryPath, finalPath]) {
        try {
          await this.fsPromises.unlink(candidate);
        } catch {}
      }
      this.activeFiles.delete(resolvedTemporaryPath);
      this.activeFiles.delete(resolvedFinalPath);
    }
  }

  waitUntilReady() {
    return this.ready;
  }

  async waitForIdle() {
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  reconfigureRoot(rootDir) {
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw new TypeError("rootDir must be an absolute path");
    }
    if (this.activeOperations.size > 0 || this.activeFiles.size > 0 || this.entries.size > 0) {
      throw new Error("preview audio ring must be idle and empty before reconfiguration");
    }
    this.rootDir = path.resolve(rootDir);
    this.ready = this._prepareRoot();
    return this.rootDir;
  }

  async clearSession(sessionId) {
    const safeSessionId = assertId(sessionId, "sessionId");
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === safeSessionId) this.entries.delete(key);
    }
    await this.waitForIdle();
    await this.ready;
    return this._cleanupPreviewArtifacts(path.join(this.rootDir, safeSessionId), 1, {
      remaining: 1_024,
    });
  }

  async clear() {
    this.entries.clear();
    await this.waitForIdle();
    await this.ready;
    return this._cleanupPreviewArtifacts(this.rootDir, 0, { remaining: 1_024 });
  }

  async _cleanupPreviewArtifacts(directory, depth, budget) {
    if (budget.remaining <= 0 || depth > 2) return 0;
    let entries;
    try {
      entries = await this.fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 2) {
        removed += await this._cleanupPreviewArtifacts(candidate, depth + 1, budget);
        continue;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".preview.wav") && !entry.name.endsWith(".tmp")) ||
        this.activeFiles.has(path.resolve(candidate))
      ) {
        continue;
      }
      try {
        await this.fsPromises.unlink(candidate);
        removed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
}

module.exports = PreviewAudioRing;
module.exports.constants = { MAX_BUFFER_MS, WATERMARK_MS, SAMPLE_RATE, BYTES_PER_SAMPLE };
