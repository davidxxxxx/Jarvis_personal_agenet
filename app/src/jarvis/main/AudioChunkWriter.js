const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const MAX_CHUNK_SECONDS = 60;

function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

class AudioChunkWriter {
  constructor({
    sessionId,
    trackId,
    sourceType,
    baseDir,
    sampleRate = REQUIRED_SAMPLE_RATE,
    chunkSeconds = MAX_CHUNK_SECONDS,
    now = Date.now,
    startedAt = now(),
    sequenceNumber = 0,
    beforeChunk = () => {},
    onChunk,
  }) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    if (typeof baseDir !== "string" || baseDir.length === 0) {
      throw new TypeError("baseDir is required");
    }
    if (sampleRate !== REQUIRED_SAMPLE_RATE) {
      throw new RangeError("sampleRate must be exactly 24000 Hz");
    }
    if (!(chunkSeconds > 0 && chunkSeconds <= MAX_CHUNK_SECONDS)) {
      throw new RangeError("chunkSeconds must be greater than 0 and at most 60");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(startedAt)) {
      throw new TypeError("startedAt must be a safe integer");
    }
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
      throw new TypeError("sequenceNumber must be a non-negative safe integer");
    }
    if (typeof onChunk !== "function") throw new TypeError("onChunk must be a function");
    if (typeof beforeChunk !== "function") throw new TypeError("beforeChunk must be a function");

    const chunkBytes = sampleRate * BYTES_PER_SAMPLE * chunkSeconds;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes % BYTES_PER_SAMPLE !== 0) {
      throw new RangeError("chunkSeconds must produce a whole number of 16-bit samples");
    }

    this.sessionId = sessionId;
    this.trackId = trackId;
    this.sourceType = sourceType;
    this.baseDir = baseDir;
    this.sampleRate = sampleRate;
    this.chunkBytes = chunkBytes;
    this.now = now;
    this.onChunk = onChunk;
    this.beforeChunk = beforeChunk;
    this.pending = [];
    this.pendingBytes = 0;
    this.startedAt = startedAt;
    this.sequenceNumber = sequenceNumber;
    this.fault = null;
    this.closed = false;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  append(pcmBuffer) {
    if (this.fault) throw this.fault;
    if (this.closed) throw new Error("audio chunk writer is closed");
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    if (buffer.length % BYTES_PER_SAMPLE !== 0) {
      throw new RangeError("PCM must contain complete signed 16-bit little-endian samples");
    }
    if (buffer.length === 0) return;

    this.pending.push(Buffer.from(buffer));
    this.pendingBytes += buffer.length;
    while (this.pendingBytes >= this.chunkBytes) {
      this.beforeChunk(this.chunkBytes);
      this._emit(this._take(this.chunkBytes), this.now());
    }
  }

  close(at = this.now()) {
    if (this.fault) throw this.fault;
    if (this.closed) return;
    this.closed = true;
    if (this.pendingBytes === 0) return;
    this.beforeChunk(this.pendingBytes);
    this._emit(this._take(this.pendingBytes), at);
  }

  abort() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
  }

  _take(byteLength) {
    const output = Buffer.allocUnsafe(byteLength);
    let offset = 0;

    while (offset < byteLength) {
      const head = this.pending[0];
      const take = Math.min(head.length, byteLength - offset);
      head.copy(output, offset, 0, take);
      offset += take;
      this.pendingBytes -= take;
      if (take === head.length) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(take);
      }
    }

    return output;
  }

  _emit(pcmBuffer, _at) {
    if (pcmBuffer.length === 0) return;

    const id = `chunk-${crypto.randomUUID()}`;
    const partPath = path.join(this.baseDir, `${id}.wav.tmp`);
    const finalPath = path.join(this.baseDir, `${id}.wav`);
    const recoveryPath = `${finalPath}.recovery.json`;
    const recoveryPartPath = `${recoveryPath}.tmp`;
    const wav = Buffer.concat([wavHeader(pcmBuffer.length, this.sampleRate), pcmBuffer]);
    const durationMs = Math.max(
      1,
      Math.round((pcmBuffer.length * 1000) / (this.sampleRate * BYTES_PER_SAMPLE))
    );
    const startedAt = this.startedAt;
    const endedAt = startedAt + durationMs;
    const sequenceNumber = this.sequenceNumber;
    let chunk;
    let sha256;
    let fd = null;
    let recoveryFd = null;
    let recoveryCommitted = false;
    let wavCommitted = false;

    try {
      fd = fs.openSync(partPath, "wx");
      fs.writeFileSync(fd, wav);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      sha256 = crypto.createHash("sha256").update(pcmBuffer).digest("hex");
      chunk = {
        id,
        sessionId: this.sessionId,
        trackId: this.trackId,
        sourceType: this.sourceType,
        sequenceNumber,
        path: finalPath,
        startedAt,
        endedAt,
        durationMs,
        sha256,
      };
      recoveryFd = fs.openSync(recoveryPartPath, "wx");
      fs.writeFileSync(recoveryFd, JSON.stringify(chunk));
      fs.fsyncSync(recoveryFd);
      fs.closeSync(recoveryFd);
      recoveryFd = null;
      fs.renameSync(recoveryPartPath, recoveryPath);
      recoveryCommitted = true;
      fs.renameSync(partPath, finalPath);
      wavCommitted = true;
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (recoveryFd !== null) {
        try {
          fs.closeSync(recoveryFd);
        } catch {}
      }
      try {
        fs.unlinkSync(partPath);
      } catch {}
      try {
        fs.unlinkSync(recoveryPartPath);
      } catch {}
      if (recoveryCommitted && !wavCommitted) {
        try {
          fs.unlinkSync(recoveryPath);
        } catch {}
      }
      throw error;
    }

    this.startedAt = endedAt;
    this.sequenceNumber += 1;
    try {
      this.onChunk(chunk);
    } catch (error) {
      this.fault = new Error(`audio chunk metadata commit failed for ${id}`, { cause: error });
      this.fault.evidenceEndedAt = endedAt;
      try {
        chunk = this._moveToRecoveryDirectory(chunk, recoveryPath);
        this.fault.evidencePath = chunk.path;
      } catch (recoveryError) {
        // The original WAV and sidecar remain the durable fallback if quarantine fails.
        this.fault.recoveryError = recoveryError;
        this.fault.evidencePath = chunk.path;
      }
      throw this.fault;
    }

    try {
      fs.unlinkSync(recoveryPath);
    } catch (error) {
      this.fault = new Error(`audio chunk recovery cleanup failed for ${id}`, { cause: error });
      this.fault.evidenceEndedAt = endedAt;
      throw this.fault;
    }
  }

  _moveToRecoveryDirectory(chunk, originalSidecarPath) {
    const recoveryDir = path.join(this.baseDir, "recovery");
    fs.mkdirSync(recoveryDir, { recursive: true });
    const recoveryStat = fs.lstatSync(recoveryDir);
    if (!recoveryStat.isDirectory() || recoveryStat.isSymbolicLink()) {
      throw new Error("audio recovery path must be a local directory");
    }

    const recoveryPath = path.join(recoveryDir, path.basename(chunk.path));
    const recoverySidecarPath = `${recoveryPath}.recovery.json`;
    const recoveryPartPath = `${recoverySidecarPath}.${crypto.randomUUID()}.tmp`;
    const recoveredChunk = { ...chunk, path: recoveryPath };
    let recoveryFd = null;

    try {
      recoveryFd = fs.openSync(recoveryPartPath, "wx");
      fs.writeFileSync(recoveryFd, JSON.stringify(recoveredChunk));
      fs.fsyncSync(recoveryFd);
      fs.closeSync(recoveryFd);
      recoveryFd = null;
      fs.renameSync(recoveryPartPath, recoverySidecarPath);
      fs.renameSync(chunk.path, recoveryPath);
      try {
        fs.unlinkSync(originalSidecarPath);
      } catch {}
      Object.assign(chunk, recoveredChunk);
      return chunk;
    } catch (error) {
      if (recoveryFd !== null) {
        try {
          fs.closeSync(recoveryFd);
        } catch {}
      }
      try {
        fs.unlinkSync(recoveryPartPath);
      } catch {}
      throw error;
    }
  }
}

module.exports = AudioChunkWriter;
