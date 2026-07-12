const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getFFmpegPath } = require("../../helpers/ffmpegUtils");

function parsePcmWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) throw new Error("invalid_pcm_wav");
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("invalid_pcm_wav");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const declaredSize = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const availableSize = Math.min(declaredSize, wav.length - dataOffset);
    if (chunkId === "fmt " && availableSize >= 16) {
      format = {
        audioFormat: wav.readUInt16LE(dataOffset),
        channels: wav.readUInt16LE(dataOffset + 2),
        sampleRate: wav.readUInt32LE(dataOffset + 4),
        blockAlign: wav.readUInt16LE(dataOffset + 12),
        bitsPerSample: wav.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data") {
      data = wav.subarray(dataOffset, dataOffset + availableSize);
      break;
    }
    offset = dataOffset + availableSize + (availableSize % 2);
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

function runFfmpeg(args, { spawnImpl = spawn, getPath = getFFmpegPath } = {}) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getPath();
    if (!ffmpegPath) {
      reject(new Error("FFmpeg not found - required for audio evidence decoding"));
      return;
    }
    const child = spawnImpl(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
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
    child.on("error", (error) =>
      settle(reject, new Error(`FFmpeg process error: ${error.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) settle(resolve);
      else settle(reject, new Error(`FFmpeg decode exited with code ${code}: ${stderr.trim()}`));
    });
  });
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
    const directory = await this.fs.mkdtemp(path.join(os.tmpdir(), "jarvis-decode-"));
    const outputPath = path.join(directory, "decoded.wav");
    try {
      await runFfmpeg(
        [
          "-v",
          "error",
          "-i",
          inputPath,
          "-map",
          "0:a:0",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "-y",
          outputPath,
        ],
        { spawnImpl: this.spawn, getPath: this.getPath }
      );
      return parsePcmWav(await this.fs.readFile(outputPath));
    } finally {
      await this.fs.rm(directory, { recursive: true, force: true });
    }
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

function defaultTemporaryWav(fsImpl = fs.promises) {
  return {
    async write(pcm) {
      const directory = await fsImpl.mkdtemp(path.join(os.tmpdir(), "jarvis-evidence-"));
      const temporaryPath = path.join(directory, "verified.wav");
      try {
        const handle = await fsImpl.open(temporaryPath, "wx");
        try {
          await handle.writeFile(wavForPcm(pcm));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await fsImpl.rm(directory, { recursive: true, force: true });
        throw error;
      }
      return {
        path: temporaryPath,
        remove: () => fsImpl.rm(directory, { recursive: true, force: true }),
      };
    },
  };
}

class AudioEvidenceReader {
  constructor({ decoder = new FfmpegPcmDecoder(), temporaryWav = defaultTemporaryWav() } = {}) {
    if (!decoder || typeof decoder.decode !== "function") {
      throw new TypeError("decoder.decode must be a function");
    }
    if (!temporaryWav || typeof temporaryWav.write !== "function") {
      throw new TypeError("temporaryWav.write must be a function");
    }
    this.decoder = decoder;
    this.temporaryWav = temporaryWav;
  }

  async readVerifiedPcm(chunk) {
    if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
    const expectedHash = chunk.pcm_sha256 ?? chunk.sha256;
    if (typeof expectedHash !== "string" || expectedHash.length === 0) {
      throw new TypeError("chunk PCM hash is required");
    }
    const pcm = await this.decoder.decode(chunk.path, chunk.format ?? "wav");
    if (!pcm || !Buffer.isBuffer(pcm.bytes)) {
      throw new TypeError("decoder must return PCM bytes");
    }
    const actualHash = crypto.createHash("sha256").update(pcm.bytes).digest("hex");
    if (actualHash !== expectedHash) throw new Error("pcm_hash_mismatch");
    return pcm;
  }

  async withVerifiedWav(chunk, consume) {
    if (typeof consume !== "function") throw new TypeError("consume must be a function");
    const pcm = await this.readVerifiedPcm(chunk);
    const temporary = await this.temporaryWav.write(pcm);
    try {
      return await consume(temporary.path);
    } finally {
      await temporary.remove();
    }
  }

  async readPlayableWav(chunk) {
    return wavForPcm(await this.readVerifiedPcm(chunk));
  }
}

module.exports = AudioEvidenceReader;
module.exports.wavForPcm = wavForPcm;
module.exports.parsePcmWav = parsePcmWav;
module.exports.FfmpegPcmDecoder = FfmpegPcmDecoder;
