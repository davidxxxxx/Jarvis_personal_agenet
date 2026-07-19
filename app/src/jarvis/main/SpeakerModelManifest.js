const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SPEAKER_MODEL_KEYS = Object.freeze({
  PRIMARY: "campplus_zh_cn_v1",
  REVIEW: "eres2netv2_zh_cn_v1",
});

function freezeManifest(value) {
  return Object.freeze({
    ...value,
    thresholds: Object.freeze({ ...value.thresholds }),
  });
}

const SPEAKER_MODEL_MANIFESTS = Object.freeze({
  [SPEAKER_MODEL_KEYS.PRIMARY]: freezeManifest({
    key: SPEAKER_MODEL_KEYS.PRIMARY,
    role: "all_day_primary",
    modelId: "iic/speech_campplus_sv_zh-cn_16k-common",
    artifactVersion: "k2-fsa-speaker-recongition-models-2024-10-14",
    fileName: "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    byteLength: 28_281_138,
    sha256: "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11",
    sampleRate: 16_000,
    inputKind: "fbank_80",
    embeddingDimension: 192,
    embeddingSpace: "campplus-zh-cn-192-v1",
    maximumEmbeddingSeconds: 8,
    executionDevice: "cpu",
    thresholds: {
      minimumQuality: 0.78,
      similarity: 0.82,
      margin: 0.05,
      minimumContiguousWindows: 3,
    },
  }),
  [SPEAKER_MODEL_KEYS.REVIEW]: freezeManifest({
    key: SPEAKER_MODEL_KEYS.REVIEW,
    role: "idle_review",
    modelId: "iic/speech_eres2netv2_sv_zh-cn_16k-common",
    artifactVersion: "k2-fsa-speaker-recongition-models-2024-10-14",
    fileName: "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    downloadUrl:
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    byteLength: 71_441_526,
    sha256: "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239",
    sampleRate: 16_000,
    inputKind: "fbank_80",
    embeddingDimension: 192,
    embeddingSpace: "eres2netv2-zh-cn-192-v1",
    maximumEmbeddingSeconds: 8,
    executionDevice: "cpu",
    thresholds: {
      minimumQuality: 0.78,
      similarity: 0.8,
      margin: 0.05,
      minimumContiguousWindows: 3,
    },
  }),
});

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getSpeakerModelManifest(modelKey) {
  const manifest = SPEAKER_MODEL_MANIFESTS[modelKey];
  if (!manifest) {
    throw codedError("SPEAKER_MODEL_UNKNOWN", "unknown speaker model");
  }
  return manifest;
}

function assertNonSystemDrive(
  directory,
  { systemDrive = process.env.SystemDrive || "C:" } = {}
) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new TypeError("speaker model directory must be absolute");
  }
  const resolved = path.resolve(directory);
  const root = path.win32.parse(resolved).root.replace(/[\\/]$/, "");
  const forbidden = String(systemDrive).replace(/[\\/]$/, "");
  if (root && forbidden && root.toLowerCase() === forbidden.toLowerCase()) {
    throw codedError(
      "SPEAKER_MODEL_SYSTEM_DRIVE_FORBIDDEN",
      "speaker model downloads must not use the Windows system drive"
    );
  }
  return resolved;
}

function resolveSpeakerModelDirectory({
  dataRoot = process.env.JARVIS_DATA_ROOT,
  systemDrive,
} = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
    throw codedError(
      "SPEAKER_MODEL_DATA_ROOT_REQUIRED",
      "JARVIS_DATA_ROOT is required for speaker model downloads"
    );
  }
  return assertNonSystemDrive(path.join(dataRoot, "models", "diarization-models"), {
    systemDrive,
  });
}

async function exists(filePath, fsImpl) {
  try {
    await fsImpl.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath, fsImpl) {
  const handle = await fsImpl.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    buffer.fill(0);
    await handle.close();
  }
  return hash.digest("hex");
}

async function verifySpeakerModelArtifact(filePath, manifest, fsImpl = fs.promises) {
  let stat;
  try {
    stat = await fsImpl.stat(filePath);
  } catch (error) {
    throw codedError(
      "SPEAKER_MODEL_ARTIFACT_INVALID",
      `speaker model artifact is unavailable: ${error?.code || "unknown"}`
    );
  }
  if (!stat.isFile() || stat.size !== manifest.byteLength) {
    throw codedError("SPEAKER_MODEL_ARTIFACT_INVALID", "speaker model artifact length mismatch");
  }
  const digest = await sha256File(filePath, fsImpl);
  if (digest !== manifest.sha256) {
    throw codedError("SPEAKER_MODEL_ARTIFACT_INVALID", "speaker model artifact digest mismatch");
  }
  return Object.freeze({
    modelId: manifest.modelId,
    artifactVersion: manifest.artifactVersion ?? null,
    byteLength: stat.size,
    sha256: digest,
  });
}

class SpeakerModelInstaller {
  constructor({
    rootDirectory = resolveSpeakerModelDirectory(),
    manifests = SPEAKER_MODEL_MANIFESTS,
    fsImpl = fs.promises,
    allowSystemDrive = false,
    systemDrive,
    randomId = () => crypto.randomUUID().replaceAll("-", ""),
    faultInjector = async () => {},
  } = {}) {
    if (!manifests || typeof manifests !== "object") {
      throw new TypeError("speaker model manifests are required");
    }
    if (!fsImpl || typeof fsImpl.rename !== "function" || typeof fsImpl.open !== "function") {
      throw new TypeError("promise filesystem implementation is required");
    }
    if (typeof randomId !== "function" || typeof faultInjector !== "function") {
      throw new TypeError("speaker model installer callbacks are invalid");
    }
    this.rootDirectory = allowSystemDrive
      ? path.resolve(rootDirectory)
      : assertNonSystemDrive(rootDirectory, { systemDrive });
    this.manifests = manifests;
    this.fs = fsImpl;
    this.randomId = randomId;
    this.faultInjector = faultInjector;
  }

  async install(modelKey, { downloadTo, force = false } = {}) {
    const manifest = this.manifests[modelKey];
    if (!manifest) throw codedError("SPEAKER_MODEL_UNKNOWN", "unknown speaker model");
    if (typeof downloadTo !== "function") {
      throw new TypeError("downloadTo must be a function");
    }
    await this.fs.mkdir(this.rootDirectory, { recursive: true });
    const target = path.join(this.rootDirectory, manifest.fileName);
    if (!force && (await exists(target, this.fs))) {
      await verifySpeakerModelArtifact(target, manifest, this.fs);
      return Object.freeze({
        installed: false,
        reused: true,
        modelId: manifest.modelId,
        path: target,
      });
    }

    const transactionId = this.randomId();
    if (typeof transactionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) {
      throw new TypeError("speaker model transaction id is invalid");
    }
    const staging = path.join(
      this.rootDirectory,
      `.${manifest.fileName}.staging-${transactionId}`
    );
    const backup = path.join(
      this.rootDirectory,
      `.${manifest.fileName}.rollback-${transactionId}`
    );
    let backupCreated = false;
    let activated = false;
    try {
      await downloadTo({
        modelKey,
        modelId: manifest.modelId,
        url: manifest.downloadUrl,
        destination: staging,
      });
      await verifySpeakerModelArtifact(staging, manifest, this.fs);
      if (await exists(target, this.fs)) {
        await this.fs.rename(target, backup);
        backupCreated = true;
      }
      await this.fs.rename(staging, target);
      activated = true;
      await verifySpeakerModelArtifact(target, manifest, this.fs);
      await this.faultInjector("after_activate", { modelKey, target });
      if (backupCreated) {
        await this.fs.rm(backup, { force: true });
        backupCreated = false;
      }
      return Object.freeze({
        installed: true,
        reused: false,
        modelId: manifest.modelId,
        path: target,
      });
    } catch (error) {
      await this.fs.rm(staging, { force: true }).catch(() => {});
      if (activated) await this.fs.rm(target, { force: true }).catch(() => {});
      if (backupCreated) {
        await this.fs.rename(backup, target).catch(() => {});
        backupCreated = false;
      }
      throw error;
    } finally {
      await this.fs.rm(staging, { force: true }).catch(() => {});
      if (backupCreated) await this.fs.rm(backup, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  SPEAKER_MODEL_KEYS,
  SPEAKER_MODEL_MANIFESTS,
  SpeakerModelInstaller,
  assertNonSystemDrive,
  getSpeakerModelManifest,
  resolveSpeakerModelDirectory,
  verifySpeakerModelArtifact,
};
