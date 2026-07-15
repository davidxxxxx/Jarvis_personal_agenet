const fs = require("fs");
const fsPromises = require("fs").promises;
const crypto = require("node:crypto");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal, checkDiskSpace } = require("./downloadUtils");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const { processWriteGate } = require("../jarvis/main/UnifiedRootWriteGate");
const { convertToWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { applyConfirmedSpeaker } = require("./speakerAssignmentPolicy");
const sidecarPidFile = require("./sidecarPidFile");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");

const DIARIZATION_TIMEOUT_MS = 300000; // 5 minutes
const POST_MERGE_CONTEXT_WINDOW_MS = 6000;
const POST_MERGE_CONTEXT_MERGE_LIMIT = 3;

const dedupeMicAgainstSystem = (segments) => {
  const systemSegments = segments.filter((seg) => seg.source === "system" && seg.text);
  if (!systemSegments.length) return segments;

  return segments.filter((seg) => {
    if (seg.source !== "mic" || !seg.text) return true;
    if (
      !seg.likelyRenderBleed &&
      !seg.hasBleedEvidence &&
      seg.suppressionReason !== "double_talk"
    ) {
      return true;
    }

    const matcher =
      seg.suppressionReason === "double_talk" ? transcriptsLooselyOverlap : transcriptsOverlap;
    const candidates = buildMergedCandidates({
      segments: systemSegments,
      timestamp: seg.timestamp,
      windowMs: POST_MERGE_CONTEXT_WINDOW_MS,
      mergeLimit: POST_MERGE_CONTEXT_MERGE_LIMIT,
    });
    return !candidates.some((candidateText) => matcher(seg.text, candidateText));
  });
};

const SEGMENTATION_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const EMBEDDING_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SILERO_VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

const SEGMENTATION_DIR = "sherpa-onnx-pyannote-segmentation-3-0";
const SEGMENTATION_ONNX = path.join(SEGMENTATION_DIR, "model.onnx");
const EMBEDDING_ONNX = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SILERO_VAD_ONNX = "silero_vad.onnx";

function diarizationError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class DiarizationManager {
  constructor({
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    gracefulStopProcessImpl = gracefulStopProcess,
    pidFileImpl = sidecarPidFile,
    timeoutMs = DIARIZATION_TIMEOUT_MS,
  } = {}) {
    if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function");
    if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
      throw new TypeError("timer implementations must be functions");
    }
    if (typeof gracefulStopProcessImpl !== "function") {
      throw new TypeError("gracefulStopProcessImpl must be a function");
    }
    if (
      !pidFileImpl ||
      typeof pidFileImpl.write !== "function" ||
      typeof pidFileImpl.clear !== "function"
    ) {
      throw new TypeError("pidFileImpl must provide write and clear functions");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }
    this._process = null;
    this._processState = "idle";
    this.currentDownloadProcess = null;
    this.cachedBinaryPath = null;
    this.modelArtifactHashPromise = null;
    this.spawnImpl = spawnImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.gracefulStopProcessImpl = gracefulStopProcessImpl;
    this.pidFileImpl = pidFileImpl;
    this.timeoutMs = timeoutMs;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32"
        ? `sherpa-onnx-diarize-${platformArch}.exe`
        : `sherpa-onnx-diarize-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getBinaryPath() !== null && this.isModelDownloaded();
  }

  getModelsDir() {
    return getModelsDirForService("diarization");
  }

  getBundledModelsDir() {
    if (!process.resourcesPath) {
      return null;
    }

    return path.join(process.resourcesPath, "bin", "diarization-models");
  }

  _resolveModelPath(relativePath) {
    const bundledModelsDir = this.getBundledModelsDir();
    if (bundledModelsDir) {
      const bundledPath = path.join(bundledModelsDir, relativePath);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(this.getModelsDir(), relativePath);
  }

  isModelDownloaded() {
    const segPath = this._resolveModelPath(SEGMENTATION_ONNX);
    const embPath = this._resolveModelPath(EMBEDDING_ONNX);
    return fs.existsSync(segPath) && fs.existsSync(embPath);
  }

  getVadModelPath() {
    return this._resolveModelPath(SILERO_VAD_ONNX);
  }

  isVadModelDownloaded() {
    return fs.existsSync(this.getVadModelPath());
  }

  downloadModels(progressCallback = null) {
    return processWriteGate.runWithWriteLease("diarization-model-download", () =>
      this._downloadModels(progressCallback)
    );
  }

  getModelArtifacts() {
    return Object.freeze([
      Object.freeze({
        id: "sherpa-pyannote-segmentation-3.0",
        path: this._resolveModelPath(SEGMENTATION_ONNX),
      }),
      Object.freeze({
        id: "3dspeaker-campplus-voxceleb-16k-v1",
        path: this._resolveModelPath(EMBEDDING_ONNX),
      }),
    ]);
  }

  getModelArtifactSha256() {
    if (this.modelArtifactHashPromise) return this.modelArtifactHashPromise;
    this.modelArtifactHashPromise = (async () => {
      const hash = crypto.createHash("sha256");
      for (const artifact of this.getModelArtifacts()) {
        hash.update(`${artifact.id}\0`);
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(artifact.path);
          stream.on("data", (chunk) => hash.update(chunk));
          stream.on("error", reject);
          stream.on("end", resolve);
        });
        hash.update("\0");
      }
      return hash.digest("hex");
    })().catch((error) => {
      this.modelArtifactHashPromise = null;
      throw error;
    });
    return this.modelArtifactHashPromise;
  }

  async _downloadModels(progressCallback = null) {
    const modelsDir = this.getModelsDir();
    await fsPromises.mkdir(modelsDir, { recursive: true });

    const modelsReady = this.isModelDownloaded();
    const vadReady = this.isVadModelDownloaded();

    if (modelsReady && vadReady) {
      return { success: true, path: modelsDir };
    }

    const requiredBytes = modelsReady ? 2 * 1_000_000 : 37 * 1_000_000;
    const spaceCheck = await checkDiskSpace(modelsDir, requiredBytes * 2.5);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space. Need ~${Math.round((requiredBytes * 2.5) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    try {
      // Download segmentation model (tar.bz2)
      const segArchivePath = path.join(modelsDir, `${SEGMENTATION_DIR}.tar.bz2`);
      const segModelPath = path.join(modelsDir, SEGMENTATION_ONNX);

      if (!fs.existsSync(segModelPath)) {
        await downloadFile(SEGMENTATION_MODEL_URL, segArchivePath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            if (progressCallback) {
              progressCallback({
                type: "progress",
                stage: "segmentation",
                downloaded_bytes: downloadedBytes,
                total_bytes: totalBytes,
                percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              });
            }
          },
        });

        // Extract tar.bz2
        if (progressCallback) {
          progressCallback({ type: "progress", stage: "extracting", percentage: 100 });
        }

        await this._extractTarBz2(segArchivePath, modelsDir);
        await fsPromises.unlink(segArchivePath).catch(() => {});

        if (!fs.existsSync(segModelPath)) {
          throw new Error("Segmentation model extraction failed: model.onnx not found");
        }
      }

      // Download embedding model (.onnx directly)
      const embModelPath = path.join(modelsDir, EMBEDDING_ONNX);

      if (!fs.existsSync(embModelPath)) {
        await downloadFile(EMBEDDING_MODEL_URL, embModelPath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            if (progressCallback) {
              progressCallback({
                type: "progress",
                stage: "embedding",
                downloaded_bytes: downloadedBytes,
                total_bytes: totalBytes,
                percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              });
            }
          },
        });
      }

      if (!this.isVadModelDownloaded()) {
        try {
          await downloadFile(SILERO_VAD_MODEL_URL, this.getVadModelPath(), {
            timeout: 600000,
            signal,
            onProgress: (downloadedBytes, totalBytes) => {
              if (progressCallback) {
                progressCallback({
                  type: "progress",
                  stage: "vad",
                  downloaded_bytes: downloadedBytes,
                  total_bytes: totalBytes,
                  percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                });
              }
            },
          });
        } catch (error) {
          if (error.isAbort) {
            throw new Error("Download interrupted by user");
          }
          debugLogger.warn("Silero VAD model download failed", {
            error: error.message,
            modelsDir,
          });
        }
      }

      if (progressCallback) {
        progressCallback({ type: "complete", percentage: 100 });
      }

      debugLogger.info("Diarization models downloaded", { modelsDir });
      return { success: true, path: modelsDir };
    } catch (error) {
      if (error.isAbort) {
        throw new Error("Download interrupted by user");
      }
      if (progressCallback) {
        progressCallback({ type: "error", error: error.message });
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async _extractTarBz2(archivePath, destDir) {
    try {
      await this._runSystemTar(archivePath, destDir);
      return;
    } catch (err) {
      debugLogger.debug("System tar failed, falling back to JS extraction", {
        error: err.message,
      });
    }

    const unbzip2 = require("unbzip2-stream");
    const tar = require("tar");
    const { pipeline } = require("stream/promises");
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: destDir }));
  }

  _runSystemTar(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      // Use relative paths from archive dir as cwd so neither -f nor -C args
      // contain Windows drive letter colons (GNU tar treats C: as remote host)
      const cwd = path.dirname(archivePath);
      const tarProcess = spawn(
        "tar",
        ["-xjf", path.basename(archivePath), "-C", path.relative(cwd, destDir)],
        { stdio: ["ignore", "pipe", "pipe"], cwd }
      );

      let stderr = "";

      tarProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      tarProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`tar extraction failed with code ${code}: ${stderr}`));
        }
      });

      tarProcess.on("error", (err) => {
        reject(new Error(`Failed to start tar process: ${err.message}`));
      });
    });
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async diarize(wavPath, options = {}) {
    try {
      return await this.diarizeStrict(wavPath, options);
    } catch (error) {
      debugLogger.warn("Diarization unavailable", {
        code: error?.code,
        error: error?.message,
      });
      return [];
    }
  }

  async diarizeStrict(wavPath, options = {}) {
    const { numSpeakers = -1, threshold = 0.55 } = options;

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw diarizationError("DIARIZATION_BINARY_UNAVAILABLE", "Diarization binary not found");
    }

    if (!this.isModelDownloaded()) {
      throw diarizationError("DIARIZATION_MODEL_UNAVAILABLE", "Diarization models not downloaded");
    }

    if (!fs.existsSync(wavPath)) {
      throw diarizationError("DIARIZATION_INPUT_UNAVAILABLE", "Diarization input file not found");
    }

    const segPath = this._resolveModelPath(SEGMENTATION_ONNX);
    const embPath = this._resolveModelPath(EMBEDDING_ONNX);

    const args = [
      `--segmentation.pyannote-model=${segPath}`,
      `--embedding.model=${embPath}`,
      `--clustering.num-clusters=${numSpeakers}`,
      `--clustering.cluster-threshold=${threshold}`,
      "--min-duration-on=0.2",
      "--min-duration-off=0.5",
      wavPath,
    ];

    debugLogger.info("Starting diarization", {
      binaryPath,
      numSpeakers,
      threshold,
      wavPath,
    });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timingOut = false;
      let proc;
      let timeout;

      const clearTimer = () => {
        if (timeout === undefined) return;
        this.clearTimeoutImpl(timeout);
        timeout = undefined;
      };
      const clearTrackedProcess = () => {
        if (this._process !== proc) return;
        this._process = null;
        this._processState = "idle";
        this.pidFileImpl.clear("diarization");
      };
      const cleanup = () => {
        clearTimer();
        clearTrackedProcess();
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      try {
        proc = this.spawnImpl(binaryPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        finishReject(
          diarizationError("DIARIZATION_SIDECAR_SPAWN_FAILED", error?.message || "spawn failed")
        );
        return;
      }

      this._process = proc;
      this._processState = "running";
      this.pidFileImpl.write("diarization", proc.pid);

      timeout = this.setTimeoutImpl(() => {
        if (settled || timingOut) return;
        timingOut = true;
        this._processState = "timing_out";
        clearTimer();
        debugLogger.warn("Diarization timed out", { timeoutMs: this.timeoutMs });
        void (async () => {
          try {
            await this.gracefulStopProcessImpl(proc);
          } catch (error) {
            if (settled) return;
            settled = true;
            reject(
              diarizationError(
                "DIARIZATION_SIDECAR_STOP_FAILED",
                error?.message || "Diarization sidecar could not be stopped after timeout"
              )
            );
            return;
          }
          clearTrackedProcess();
          if (settled) return;
          settled = true;
          reject(diarizationError("DIARIZATION_SIDECAR_TIMEOUT"));
        })();
      }, this.timeoutMs);

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (timingOut) {
          clearTrackedProcess();
          return;
        }
        if (settled) return;
        if (code !== 0) {
          debugLogger.warn("Diarization process exited with error", {
            code,
            stderr: stderr.slice(-500).trim(),
          });
          finishReject(
            diarizationError(
              "DIARIZATION_SIDECAR_EXIT_NONZERO",
              `Diarization sidecar exited with code ${code}`
            )
          );
          return;
        }

        try {
          const segments = this._parseStrictOutput(stdout);
          debugLogger.info("Diarization complete", { segmentCount: segments.length });
          finishResolve(segments);
        } catch (error) {
          finishReject(error);
        }
      });

      proc.on("error", (err) => {
        if (settled || timingOut) return;
        debugLogger.warn("Diarization process error", { error: err.message });
        finishReject(diarizationError("DIARIZATION_SIDECAR_SPAWN_FAILED", err.message));
      });
    });
  }

  _parseStrictOutput(stdout) {
    const segments = this._parseOutput(stdout);
    const nonemptyLines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (nonemptyLines.length !== segments.length) {
      throw diarizationError("DIARIZATION_SIDECAR_INVALID_OUTPUT");
    }
    return segments;
  }

  _parseOutput(stdout) {
    const segments = [];
    const lineRegex = /^(\d+\.?\d*)\s+--\s+(\d+\.?\d*)\s+(speaker_\d+)$/;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(lineRegex);
      if (match) {
        segments.push({
          start: parseFloat(match[1]),
          end: parseFloat(match[2]),
          speaker: match[3],
        });
      }
    }

    return segments;
  }

  capSpeakerClusters(segments, cap) {
    if (!cap || !segments?.length) return segments;
    const totals = new Map();
    for (const s of segments) {
      totals.set(s.speaker, (totals.get(s.speaker) || 0) + (s.end - s.start));
    }
    if (totals.size <= cap) return segments;

    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const keep = new Set(ranked.slice(0, cap).map(([sp]) => sp));
    const primary = ranked[0][0];
    return segments.map((s) => (keep.has(s.speaker) ? s : { ...s, speaker: primary }));
  }

  mergeWithTranscript(transcriptSegments, diarizationSegments) {
    if (!transcriptSegments || transcriptSegments.length === 0) return [];
    const deduped = dedupeMicAgainstSystem(transcriptSegments);
    if (!diarizationSegments || diarizationSegments.length === 0) {
      return deduped.map((seg) => ({ ...seg }));
    }

    // Build speaker renumbering map (e.g., speaker_00 → speaker_0)
    const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
    const speakerMap = new Map();
    let idx = 0;
    for (const sp of speakerSet) {
      speakerMap.set(sp, `speaker_${idx}`);
      idx++;
    }

    const nextSystemTimestampAt = (startIndex) => {
      for (let i = startIndex + 1; i < deduped.length; i += 1) {
        const candidate = deduped[i];
        if (candidate.source === "system" && candidate.timestamp != null) {
          return candidate.timestamp;
        }
      }
      return null;
    };

    return deduped.map((seg, index) => {
      const enriched = { ...seg };

      if (seg.source === "mic") {
        applyConfirmedSpeaker(enriched, {
          speaker: "you",
          speakerIsPlaceholder: false,
        });
        return enriched;
      }

      if (seg.source === "system" && seg.timestamp != null) {
        const segStart = seg.timestamp;
        const segEnd = nextSystemTimestampAt(index) ?? segStart + 2.5;
        const midpoint = segStart + (segEnd - segStart) / 2;
        let bestSpeaker = null;
        let bestOverlap = 0;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const dSeg of diarizationSegments) {
          const overlap = Math.min(segEnd, dSeg.end) - Math.max(segStart, dSeg.start);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestSpeaker = dSeg.speaker;
          }

          const distance =
            midpoint < dSeg.start
              ? dSeg.start - midpoint
              : midpoint > dSeg.end
                ? midpoint - dSeg.end
                : 0;

          if (!bestSpeaker && distance < bestDistance) {
            bestDistance = distance;
            bestSpeaker = dSeg.speaker;
          }
        }

        if (bestSpeaker) {
          applyConfirmedSpeaker(enriched, {
            speaker: speakerMap.get(bestSpeaker) || bestSpeaker,
            speakerIsPlaceholder: false,
          });
        }
      }

      return enriched;
    });
  }

  async convertRawPcmToWav(rawPcmPath, inputSampleRate) {
    const stat = await fsPromises.stat(rawPcmPath);
    if (stat.size === 0) {
      throw new Error("Raw PCM file is empty");
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const inputWavPath = path.join(tempDir, `ow-diarize-${timestamp}-input.wav`);
    const wavPath = path.join(tempDir, `ow-diarize-${timestamp}.wav`);

    // Stream: write 44-byte WAV header, then pipe raw PCM — avoids loading entire file into memory
    const header = this._createWavHeader(stat.size, inputSampleRate, 1);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(inputWavPath);
      out.write(header);
      const pcmStream = fs.createReadStream(rawPcmPath);
      pcmStream.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      pcmStream.on("error", reject);
    });

    try {
      await convertToWav(inputWavPath, wavPath, { sampleRate: 16000, channels: 1 });
    } finally {
      await fsPromises.unlink(inputWavPath).catch(() => {});
    }

    debugLogger.debug("Raw PCM converted to WAV for diarization", {
      wavPath,
      rawPcmBytes: stat.size,
    });

    return wavPath;
  }

  _createWavHeader(dataSize, sampleRate, channels) {
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bytesPerSample * 8, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }

  deleteModels() {
    return processWriteGate.runWithWriteLease("diarization-model-delete", () =>
      this._deleteModels()
    );
  }

  async quiesce() {
    await this.cancelDownload();
    await this.shutdown();
  }

  async resume() {}

  async _deleteModels() {
    this.modelArtifactHashPromise = null;
    const modelsDir = this.getModelsDir();
    const segDir = path.join(modelsDir, SEGMENTATION_DIR);
    const embPath = path.join(modelsDir, EMBEDDING_ONNX);
    const vadPath = this.getVadModelPath();

    if (fs.existsSync(segDir)) {
      await fsPromises.rm(segDir, { recursive: true, force: true });
    }
    if (fs.existsSync(embPath)) {
      await fsPromises.unlink(embPath);
    }
    if (fs.existsSync(vadPath)) {
      await fsPromises.unlink(vadPath);
    }

    debugLogger.info("Diarization models deleted", { modelsDir });
    return { success: true };
  }

  async shutdown() {
    const proc = this._process;
    if (!proc) return;
    await this.gracefulStopProcessImpl(proc);
    if (this._process !== proc) return;
    this._process = null;
    this._processState = "idle";
    this.pidFileImpl.clear("diarization");
  }
}

module.exports = DiarizationManager;
