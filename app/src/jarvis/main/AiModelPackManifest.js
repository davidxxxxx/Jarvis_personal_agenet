const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertNonSystemDrive } = require("./SpeakerModelManifest");
const { HYBRID_DIARIZATION_POLICY } = require("./HybridDiarizationPolicy");

const MODEL_PACK_SCHEMA_VERSION = 1;
const MODEL_PACK_VERSION = "jarvis-ai-model-pack-2026.07.2";
const MANIFEST_FILE = "manifest.json";
const SHA256 = /^[0-9a-f]{64}$/;

const REQUIRED_COMPONENTS = Object.freeze([
  Object.freeze({ id: "python-runtime", license: "PSF-2.0", requiredPath: "runtime/python.exe" }),
  Object.freeze({
    id: HYBRID_DIARIZATION_POLICY.models.primary.id,
    license: HYBRID_DIARIZATION_POLICY.models.primary.license,
    revision: HYBRID_DIARIZATION_POLICY.models.primary.revision,
    requiredPath: "models/pyannote-community-1/config.yaml",
  }),
  Object.freeze({
    id: HYBRID_DIARIZATION_POLICY.models.verifier.id,
    license: HYBRID_DIARIZATION_POLICY.models.verifier.license,
    revision: HYBRID_DIARIZATION_POLICY.models.verifier.revision,
    requiredPath: "models/diarization-models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
  }),
  Object.freeze({
    id: HYBRID_DIARIZATION_POLICY.models.separator.id,
    license: HYBRID_DIARIZATION_POLICY.models.separator.license,
    revision: HYBRID_DIARIZATION_POLICY.models.separator.revision,
    requiredPath: "checkpoints/MossFormer2_SS_16K/last_best_checkpoint",
  }),
  Object.freeze({
    id: "jarvis-diarization-sidecar",
    license: "MIT",
    requiredPath: "runtime/jarvis_diarization_sidecar.py",
  }),
  Object.freeze({
    id: "jarvis-overlap-separator",
    license: "MIT",
    requiredPath: "runtime/jarvis_overlap_separator.py",
  }),
  Object.freeze({
    id: "modelscope/ClearerVoice-Studio",
    license: "Apache-2.0",
    revision: "a170d81ae1372201d8ad14f1cb80bb95e5e7e65b",
    requiredPath: "vendor/clearervoice-studio/clearvoice/__init__.py",
  }),
  Object.freeze({
    id: "modelscope/ClearerVoice-Studio-license",
    license: "Apache-2.0",
    requiredPath: "vendor/clearervoice-studio/LICENSE",
  }),
  Object.freeze({
    id: "iic/speech_campplus_sv_zh-cn_16k-common",
    license: "MODEL-SPECIFIC",
    requiredPath: "models/diarization-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
  }),
  Object.freeze({
    id: "iic/speech_eres2netv2_sv_zh-cn_16k-common",
    license: "MODEL-SPECIFIC",
    requiredPath: "models/diarization-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
  }),
  Object.freeze({
    id: "snakers4/silero-vad",
    license: "MIT",
    requiredPath: "models/diarization-models/silero_vad.onnx",
  }),
  Object.freeze({
    id: "third-party-notices",
    license: "MULTIPLE",
    requiredPath: "THIRD_PARTY_NOTICES.txt",
  }),
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  const relativePath = value.replaceAll("\\", "/");
  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    /[\u0000-\u001f<>:"|?*]/.test(relativePath)
  ) {
    return null;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
}

function resolveAiModelPackRoot({ dataRoot = process.env.JARVIS_DATA_ROOT, systemDrive } = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
    throw codedError("AI_MODEL_PACK_DATA_ROOT_REQUIRED", "JARVIS_DATA_ROOT is required");
  }
  return assertNonSystemDrive(path.join(dataRoot, "models", "ai-model-pack"), { systemDrive });
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("AI_MODEL_PACK_INVALID", "model pack manifest must be an object");
  }
  if (
    value.schemaVersion !== MODEL_PACK_SCHEMA_VERSION ||
    value.packVersion !== MODEL_PACK_VERSION
  ) {
    throw codedError("AI_MODEL_PACK_VERSION_MISMATCH", "model pack version is unsupported");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw codedError("AI_MODEL_PACK_INVALID", "model pack file list is empty");
  }
  const files = new Map();
  for (const entry of value.files) {
    const relativePath = normalizeRelativePath(entry?.path);
    if (
      relativePath === null ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw codedError("AI_MODEL_PACK_INVALID", "model pack contains invalid file metadata");
    }
    if (files.has(relativePath)) {
      throw codedError("AI_MODEL_PACK_INVALID", "model pack contains duplicate files");
    }
    files.set(
      relativePath,
      Object.freeze({ path: relativePath, bytes: entry.bytes, sha256: entry.sha256 })
    );
  }
  for (const component of REQUIRED_COMPONENTS) {
    if (!files.has(component.requiredPath)) {
      throw codedError("AI_MODEL_PACK_INCOMPLETE", `missing ${component.requiredPath}`);
    }
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    packVersion: value.packVersion,
    createdAt: value.createdAt ?? null,
    files: Object.freeze([...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))),
  });
}

async function sha256File(filePath, fsImpl) {
  const hash = crypto.createHash("sha256");
  const handle = await fsImpl.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    for (;;) {
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

async function verifyAiModelPack({
  root = resolveAiModelPackRoot(),
  fsImpl = fs.promises,
  allowSystemDrive = false,
  systemDrive,
} = {}) {
  const safeRoot = allowSystemDrive
    ? path.resolve(root)
    : assertNonSystemDrive(root, { systemDrive });
  let manifest;
  try {
    manifest = normalizeManifest(
      JSON.parse(await fsImpl.readFile(path.join(safeRoot, MANIFEST_FILE), "utf8"))
    );
  } catch (error) {
    if (error?.code?.startsWith?.("AI_MODEL_PACK_")) throw error;
    throw codedError(
      "AI_MODEL_PACK_INVALID",
      `model pack manifest is unavailable: ${error?.code || "unknown"}`
    );
  }
  for (const entry of manifest.files) {
    const absolutePath = path.resolve(safeRoot, entry.path);
    if (absolutePath !== safeRoot && !absolutePath.startsWith(`${safeRoot}${path.sep}`)) {
      throw codedError("AI_MODEL_PACK_INVALID", "model pack path escapes its root");
    }
    const stat = await fsImpl.stat(absolutePath).catch(() => null);
    if (!stat?.isFile() || stat.size !== entry.bytes) {
      throw codedError("AI_MODEL_PACK_ARTIFACT_INVALID", `invalid model artifact: ${entry.path}`);
    }
    const digest = await sha256File(absolutePath, fsImpl);
    if (digest !== entry.sha256) {
      throw codedError("AI_MODEL_PACK_ARTIFACT_INVALID", `model digest mismatch: ${entry.path}`);
    }
  }
  const checkpointPointer = "checkpoints/MossFormer2_SS_16K/last_best_checkpoint";
  const checkpointDirectory = path.posix.dirname(checkpointPointer);
  const pointerText = await fsImpl.readFile(path.join(safeRoot, checkpointPointer), "utf8");
  const checkpointNames = pointerText
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    checkpointNames.length < 1 ||
    checkpointNames.length > 4 ||
    checkpointNames.some(
      (name) =>
        name !== path.posix.basename(name) ||
        normalizeRelativePath(`${checkpointDirectory}/${name}`) === null ||
        !manifest.files.some((entry) => entry.path === `${checkpointDirectory}/${name}`)
    )
  ) {
    throw codedError(
      "AI_MODEL_PACK_INCOMPLETE",
      "MossFormer2 checkpoint pointer does not resolve inside the model pack"
    );
  }
  const manifestSha256 = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return Object.freeze({ root: safeRoot, manifest, manifestSha256 });
}

function isAiModelPackPresent({ root = resolveAiModelPackRoot(), fsImpl = fs } = {}) {
  try {
    return (
      REQUIRED_COMPONENTS.every((component) =>
        fsImpl.existsSync(path.join(root, component.requiredPath))
      ) && fsImpl.existsSync(path.join(root, MANIFEST_FILE))
    );
  } catch {
    return false;
  }
}

module.exports = {
  MANIFEST_FILE,
  MODEL_PACK_SCHEMA_VERSION,
  MODEL_PACK_VERSION,
  REQUIRED_COMPONENTS,
  isAiModelPackPresent,
  normalizeManifest,
  resolveAiModelPackRoot,
  verifyAiModelPack,
};
