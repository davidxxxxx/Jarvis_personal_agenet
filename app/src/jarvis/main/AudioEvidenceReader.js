const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getFFmpegPath } = require("../../helpers/ffmpegUtils");
const {
  ffmpegExitError,
  ffmpegProcessError,
  isTransientIoError,
} = require("./AudioEvidenceErrors");

function parsePcmWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) throw new Error("invalid_pcm_wav");
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("invalid_pcm_wav");
  }
  if (wav.readUInt32LE(4) !== wav.length - 8) throw new Error("invalid_pcm_wav");
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const declaredSize = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (declaredSize > wav.length - dataOffset) throw new Error("invalid_pcm_wav");
    const paddedEnd = dataOffset + declaredSize + (declaredSize % 2);
    if (paddedEnd > wav.length) throw new Error("invalid_pcm_wav");
    if (chunkId === "fmt " && declaredSize >= 16) {
      format = {
        audioFormat: wav.readUInt16LE(dataOffset),
        channels: wav.readUInt16LE(dataOffset + 2),
        sampleRate: wav.readUInt32LE(dataOffset + 4),
        blockAlign: wav.readUInt16LE(dataOffset + 12),
        bitsPerSample: wav.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data") {
      data = wav.subarray(dataOffset, dataOffset + declaredSize);
      break;
    }
    offset = paddedEnd;
  }
  if (
    !format ||
    !data ||
    format.audioFormat !== 1 ||
    format.bitsPerSample !== 16 ||
    format.channels <= 0 ||
    format.blockAlign !== format.channels * 2 ||
    data.length % format.blockAlign !== 0
  ) {
    throw new Error("invalid_pcm_wav");
  }
  return {
    bytes: Buffer.from(data),
    sampleRate: format.sampleRate,
    channels: format.channels,
    sampleCount: data.length / format.blockAlign,
  };
}

function runFfmpeg(
  args,
  {
    spawnImpl = spawn,
    getPath = getFFmpegPath,
    input = null,
    maxOutputBytes = 16 * 1024 * 1024,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getPath();
    if (!ffmpegPath) {
      reject(new Error("FFmpeg not found - required for audio evidence decoding"));
      return;
    }
    let child;
    try {
      child = spawnImpl(ffmpegPath, args, {
        stdio: [Buffer.isBuffer(input) ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(ffmpegProcessError(error));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.stderr.on("data", (data) => {
      stderr = `${stderr}${data}`.slice(-4_096);
    });
    child.stdout.on("data", (data) => {
      stdoutBytes += data.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        settle(reject, new Error("FFmpeg decoded evidence exceeds the bounded PCM size"));
        return;
      }
      stdout.push(data);
    });
    if (Buffer.isBuffer(input)) {
      child.stdin.on("error", (error) => settle(reject, ffmpegProcessError(error)));
      child.stdin.end(input);
    }
    child.on("error", (error) => settle(reject, ffmpegProcessError(error)));
    child.on("close", (code) => {
      if (code === 0) settle(resolve, Buffer.concat(stdout));
      else settle(reject, ffmpegExitError(code, stderr));
    });
  });
}

function normalizeStreamedWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return wav;
  const normalized = Buffer.from(wav);
  if (normalized.readUInt32LE(4) === 0xffffffff) {
    normalized.writeUInt32LE(normalized.length - 8, 4);
  }
  let offset = 12;
  while (offset + 8 <= normalized.length) {
    const id = normalized.toString("ascii", offset, offset + 4);
    const size = normalized.readUInt32LE(offset + 4);
    if (id === "data" && size === 0xffffffff) {
      normalized.writeUInt32LE(normalized.length - offset - 8, offset + 4);
      break;
    }
    if (size > normalized.length - offset - 8) break;
    offset += 8 + size + (size % 2);
  }
  return normalized;
}

class FfmpegPcmDecoder {
  constructor({ fsImpl = fs.promises, spawnImpl = spawn, getPath = getFFmpegPath } = {}) {
    this.fs = fsImpl;
    this.spawn = spawnImpl;
    this.getPath = getPath;
  }

  async decode(inputPath, format) {
    if (format === "wav") return parsePcmWav(await this.fs.readFile(inputPath));
    if (format !== "flac") throw new Error(`unsupported_audio_evidence_format:${format}`);
    const decodedWav = await runFfmpeg(
      ["-v", "error", "-i", inputPath, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
      { spawnImpl: this.spawn, getPath: this.getPath }
    );
    return parsePcmWav(normalizeStreamedWav(decodedWav));
  }
}

function wavForPcm(pcm) {
  if (!pcm || !Buffer.isBuffer(pcm.bytes)) throw new TypeError("PCM bytes are required");
  const { sampleRate, channels } = pcm;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError("PCM sampleRate must be a positive integer");
  }
  if (!Number.isSafeInteger(channels) || channels <= 0) {
    throw new TypeError("PCM channels must be a positive integer");
  }
  const blockAlign = channels * 2;
  if (pcm.bytes.length % blockAlign !== 0) {
    throw new RangeError("PCM bytes must contain complete signed 16-bit samples");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.bytes.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.bytes.length, 40);
  return Buffer.concat([header, pcm.bytes]);
}

class FfmpegPcmNormalizer {
  constructor({ spawnImpl = spawn, getPath = getFFmpegPath } = {}) {
    this.spawn = spawnImpl;
    this.getPath = getPath;
  }

  async normalize(pcm, { sampleRate, channels }) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
      throw new TypeError("target PCM sampleRate must be a positive integer");
    }
    if (!Number.isSafeInteger(channels) || channels <= 0) {
      throw new TypeError("target PCM channels must be a positive integer");
    }
    if (pcm.sampleRate === sampleRate && pcm.channels === channels) return pcm;

    const normalizedWav = await runFfmpeg(
      [
        "-v",
        "error",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      {
        spawnImpl: this.spawn,
        getPath: this.getPath,
        input: wavForPcm(pcm),
      }
    );
    const normalized = parsePcmWav(normalizeStreamedWav(normalizedWav));
    if (normalized.sampleRate !== sampleRate || normalized.channels !== channels) {
      throw new Error("normalized_pcm_format_mismatch");
    }
    return normalized;
  }
}

function defaultTemporaryWav(recordingsRoot, fsImpl = fs.promises) {
  const root = typeof recordingsRoot === "string" ? path.resolve(recordingsRoot) : null;
  const active = new Set();
  let fixedRoot = null;

  const controlledDirectory = async () => {
    if (!root || !path.isAbsolute(root)) {
      throw new TypeError("recordingsRoot is required for verified WAV leases");
    }
    await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await fsImpl.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("recordings root must be a real directory");
    }
    const rootReal = await fsImpl.realpath(root);
    if (fixedRoot === null) fixedRoot = rootReal;
    if (path.relative(fixedRoot, rootReal) !== "" || path.relative(rootReal, fixedRoot) !== "") {
      throw new Error("recordings root identity changed");
    }
    const directory = path.join(fixedRoot, ".evidence-tmp");
    await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fsImpl.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("evidence lease directory must be a real directory");
    }
    const directoryReal = await fsImpl.realpath(directory);
    if (
      path.dirname(directoryReal) !== fixedRoot ||
      path.basename(directoryReal) !== ".evidence-tmp"
    ) {
      throw new Error("evidence lease directory escapes recordings root");
    }
    await fsImpl.chmod(directoryReal, 0o700);
    return directoryReal;
  };

  const safeLease = async (candidate, directory) => {
    const stat = await fsImpl.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== undefined && stat.nlink !== 1)) {
      throw new Error("evidence lease must be a single-link regular file");
    }
    const real = await fsImpl.realpath(candidate);
    if (path.dirname(real) !== directory) throw new Error("evidence lease escapes its directory");
    return real;
  };

  return {
    async write(pcm, { chunkId, pcmSha256 } = {}) {
      if (typeof chunkId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(chunkId)) {
        throw new TypeError("chunkId is required for verified WAV leases");
      }
      if (typeof pcmSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pcmSha256)) {
        throw new TypeError("pcmSha256 is required for verified WAV leases");
      }
      const directory = await controlledDirectory();
      const token = crypto.randomUUID().replaceAll("-", "");
      const temporaryPath = path.join(directory, `lease-${chunkId}-${pcmSha256}-${token}.wav`);
      try {
        const handle = await fsImpl.open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(wavForPcm(pcm));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await fsImpl.rm(temporaryPath, { force: true });
        throw error;
      }
      active.add(temporaryPath);
      return {
        path: temporaryPath,
        async remove() {
          active.delete(temporaryPath);
          await fsImpl.rm(temporaryPath, { force: true });
        },
      };
    },
    async cleanup({ getChunk }) {
      if (typeof getChunk !== "function") throw new TypeError("getChunk must be a function");
      const directory = await controlledDirectory();
      const entries = await fsImpl.readdir(directory, { withFileTypes: true });
      let removed = 0;
      for (const entry of entries) {
        const match = /^lease-([A-Za-z0-9_-]{1,128})-([0-9a-f]{64})-([0-9a-f]{32})\.wav$/.exec(
          entry.name
        );
        if (!match || !entry.isFile()) continue;
        const candidate = path.join(directory, entry.name);
        if (active.has(candidate)) continue;
        try {
          const chunk = getChunk(match[1]);
          if (!chunk || (chunk.pcm_sha256 ?? chunk.sha256) !== match[2]) continue;
          const safe = await safeLease(candidate, directory);
          const pcm = parsePcmWav(await fsImpl.readFile(safe));
          const actual = crypto.createHash("sha256").update(pcm.bytes).digest("hex");
          if (actual !== match[2]) continue;
          await fsImpl.unlink(safe);
          removed += 1;
        } catch {
          // Unproven files are preserved instead of guessed from an extension.
        }
      }
      return removed;
    },
  };
}

class AudioEvidenceReader {
  constructor({
    decoder = new FfmpegPcmDecoder(),
    normalizer = new FfmpegPcmNormalizer(),
    temporaryWav = null,
    recordingsRoot = null,
    fsImpl = fs.promises,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    temporaryWav ??= defaultTemporaryWav(recordingsRoot);
    if (!decoder || typeof decoder.decode !== "function") {
      throw new TypeError("decoder.decode must be a function");
    }
    if (!normalizer || typeof normalizer.normalize !== "function") {
      throw new TypeError("normalizer.normalize must be a function");
    }
    if (!temporaryWav || typeof temporaryWav.write !== "function") {
      throw new TypeError("temporaryWav.write must be a function");
    }
    this.decoder = decoder;
    this.normalizer = normalizer;
    this.temporaryWav = temporaryWav;
    this.recordingsRoot = typeof recordingsRoot === "string" ? path.resolve(recordingsRoot) : null;
    this.fs = fsImpl;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.fixedRoot = null;
  }

  async readVerifiedPcm(chunk) {
    if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
    const expectedHash = chunk.pcm_sha256 ?? chunk.sha256;
    if (typeof expectedHash !== "string" || expectedHash.length === 0) {
      throw new TypeError("chunk PCM hash is required");
    }
    await this._assertSafeAuthority(chunk.path);
    const pcm = await this.decoder.decode(chunk.path, chunk.format ?? "wav");
    if (!pcm || !Buffer.isBuffer(pcm.bytes)) {
      throw new TypeError("decoder must return PCM bytes");
    }
    const actualHash = crypto.createHash("sha256").update(pcm.bytes).digest("hex");
    if (actualHash !== expectedHash) throw new Error("pcm_hash_mismatch");
    return pcm;
  }

  async withVerifiedWav(
    chunk,
    consume,
    { deadline: requestedDeadline, sampleRate = null, channels = null } = {}
  ) {
    if (typeof consume !== "function") throw new TypeError("consume must be a function");
    const deadlines = [chunk?.expires_at, requestedDeadline].filter(Number.isFinite);
    const hasDeadline = deadlines.length > 0;
    const deadline = hasDeadline ? Math.min(...deadlines) : null;
    const assertLive = () => {
      if (hasDeadline && this.now() >= deadline) {
        const error = new Error("audio_expired");
        error.code = "audio_expired";
        throw error;
      }
    };
    assertLive();
    let pcm = await this.readVerifiedPcm(chunk);
    assertLive();
    if (sampleRate !== null || channels !== null) {
      pcm = await this.normalizer.normalize(pcm, {
        sampleRate: sampleRate ?? pcm.sampleRate,
        channels: channels ?? pcm.channels,
      });
      assertLive();
    }
    const temporary = await this.temporaryWav.write(pcm, {
      chunkId: chunk.id,
      pcmSha256: chunk.pcm_sha256 ?? chunk.sha256,
    });
    const controller = new AbortController();
    let timer = null;
    let result;
    let primaryError;
    let hasPrimaryError = false;
    try {
      assertLive();
      const consumption = Promise.resolve().then(() => consume(temporary.path, controller.signal));
      if (!hasDeadline) {
        result = await consumption;
      } else {
        const expired = new Promise((_resolve, reject) => {
          timer = this.setTimeout(() => {
            const error = new Error("audio_expired");
            error.code = "audio_expired";
            controller.abort(error);
            reject(error);
          }, Math.max(0, deadline - this.now()));
          timer?.unref?.();
        });
        result = await Promise.race([consumption, expired]);
      }
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    let cleanupError = null;
    try {
      if (timer !== null) this.clearTimeout(timer);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await temporary.remove();
    } catch (error) {
      cleanupError ??= error;
    }
    if (hasPrimaryError) {
      if (
        cleanupError &&
        (typeof primaryError === "object" || typeof primaryError === "function") &&
        primaryError !== null &&
        primaryError.cause === undefined
      ) {
        try {
          primaryError.cause = cleanupError;
        } catch {
          // Preserve the primary failure even when it is not extensible.
        }
      }
      throw primaryError;
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async readPlayableWav(chunk) {
    return wavForPcm(await this.readVerifiedPcm(chunk));
  }

  async cleanupStaleTemporaryEvidence({ getChunk }) {
    if (typeof this.temporaryWav.cleanup !== "function") return 0;
    return this.temporaryWav.cleanup({ getChunk });
  }

  async _assertSafeAuthority(candidate) {
    if (this.recordingsRoot === null) return;
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new TypeError("audio evidence path must be absolute");
    }
    const rootStat = await this.fs.lstat(this.recordingsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("recordings root must be a real directory");
    }
    const rootReal = await this.fs.realpath(this.recordingsRoot);
    const identity = { real: rootReal, dev: rootStat.dev, ino: rootStat.ino };
    if (this.fixedRoot === null) this.fixedRoot = identity;
    if (
      this.fixedRoot.real !== identity.real ||
      (identity.dev !== undefined && identity.dev !== this.fixedRoot.dev) ||
      (identity.ino !== undefined && identity.ino !== this.fixedRoot.ino)
    ) {
      throw new Error("recordings root identity changed");
    }
    const resolved = path.resolve(candidate);
    const stat = await this.fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== undefined && stat.nlink !== 1)) {
      throw new Error("audio evidence path must be a single-link regular file");
    }
    const real = await this.fs.realpath(resolved);
    const relative = path.relative(this.fixedRoot.real, real);
    if (
      relative.length === 0 ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("audio evidence path escapes recordings root");
    }
  }
}

module.exports = AudioEvidenceReader;
module.exports.wavForPcm = wavForPcm;
module.exports.parsePcmWav = parsePcmWav;
module.exports.FfmpegPcmDecoder = FfmpegPcmDecoder;
module.exports.FfmpegPcmNormalizer = FfmpegPcmNormalizer;
module.exports.isTransientIoError = isTransientIoError;
