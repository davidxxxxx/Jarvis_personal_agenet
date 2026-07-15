"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

class SpeakerEvaluationSetupError extends Error {
  constructor(code) {
    super(`Speaker evaluation setup failed (${code}).`);
    this.name = "SpeakerEvaluationSetupError";
    this.code = code;
  }
}

function fail(code) {
  throw new SpeakerEvaluationSetupError(code);
}

function hasExactFields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((field) => allowed.has(field));
}

function anonymousId(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validateAudioName(value) {
  if (
    typeof value !== "string" ||
    !value.endsWith(".wav") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    fail("SPEAKER_EVAL_MANIFEST_AUDIO_PATH");
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) {
    fail("SPEAKER_EVAL_MANIFEST_AUDIO_PATH");
  }
  return value;
}

function validateSpeakerEvaluationManifest(manifest, { policy } = {}) {
  const expectedModelId = policy?.modelId;
  if (!hasExactFields(manifest, new Set(["schemaVersion", "modelId", "profiles", "cases"]))) {
    fail("SPEAKER_EVAL_MANIFEST_FIELDS");
  }
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.profiles) ||
    !Array.isArray(manifest.cases)
  ) {
    fail("SPEAKER_EVAL_MANIFEST_SCHEMA");
  }
  if (typeof expectedModelId !== "string" || manifest.modelId !== expectedModelId) {
    fail("SPEAKER_EVAL_MODEL_MISMATCH");
  }

  const people = new Map();
  let selfProfiles = 0;
  for (const profile of manifest.profiles) {
    if (!hasExactFields(profile, new Set(["personId", "kind", "audio"]))) {
      fail("SPEAKER_EVAL_MANIFEST_FIELDS");
    }
    if (
      !anonymousId(profile.personId) ||
      !["self", "known"].includes(profile.kind) ||
      !Array.isArray(profile.audio) ||
      profile.audio.length === 0
    ) {
      fail("SPEAKER_EVAL_MANIFEST_SCHEMA");
    }
    if (people.has(profile.personId)) fail("SPEAKER_EVAL_MANIFEST_DUPLICATE_ID");
    if (profile.kind === "self") selfProfiles += 1;
    profile.audio.forEach(validateAudioName);
    people.set(profile.personId, profile);
  }
  if (selfProfiles !== 1 || ![...people.values()].some((profile) => profile.kind === "known")) {
    fail("SPEAKER_EVAL_MANIFEST_SUPPORT");
  }

  const caseIds = new Set();
  const support = new Set();
  for (const evaluationCase of manifest.cases) {
    if (!hasExactFields(evaluationCase, new Set(["id", "audio", "speakers", "segments"]))) {
      fail("SPEAKER_EVAL_MANIFEST_FIELDS");
    }
    if (
      !anonymousId(evaluationCase.id) ||
      !Array.isArray(evaluationCase.speakers) ||
      evaluationCase.speakers.length === 0 ||
      !Array.isArray(evaluationCase.segments) ||
      evaluationCase.segments.length === 0
    ) {
      fail("SPEAKER_EVAL_MANIFEST_SCHEMA");
    }
    if (caseIds.has(evaluationCase.id)) fail("SPEAKER_EVAL_MANIFEST_DUPLICATE_ID");
    caseIds.add(evaluationCase.id);
    validateAudioName(evaluationCase.audio);

    const speakers = new Map();
    for (const speaker of evaluationCase.speakers) {
      if (!hasExactFields(speaker, new Set(["speakerId", "kind"]))) {
        fail("SPEAKER_EVAL_MANIFEST_FIELDS");
      }
      if (!anonymousId(speaker.speakerId) || !["self", "known", "unknown"].includes(speaker.kind)) {
        fail("SPEAKER_EVAL_MANIFEST_SCHEMA");
      }
      if (speakers.has(speaker.speakerId)) fail("SPEAKER_EVAL_MANIFEST_DUPLICATE_ID");
      if (speaker.kind === "unknown") {
        if (people.has(speaker.speakerId)) fail("SPEAKER_EVAL_MANIFEST_UNKNOWN_SPEAKER");
      } else if (people.get(speaker.speakerId)?.kind !== speaker.kind) {
        fail("SPEAKER_EVAL_MANIFEST_UNKNOWN_SPEAKER");
      }
      speakers.set(speaker.speakerId, speaker);
      support.add(speaker.kind);
    }

    const segmentsBySpeaker = new Map();
    for (const segment of evaluationCase.segments) {
      if (!hasExactFields(segment, new Set(["speakerId", "startMs", "endMs"]))) {
        fail("SPEAKER_EVAL_MANIFEST_FIELDS");
      }
      if (!speakers.has(segment.speakerId)) fail("SPEAKER_EVAL_MANIFEST_UNKNOWN_SPEAKER");
      if (
        !Number.isSafeInteger(segment.startMs) ||
        !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs
      ) {
        fail("SPEAKER_EVAL_MANIFEST_SEGMENT_BOUNDS");
      }
      const entries = segmentsBySpeaker.get(segment.speakerId) ?? [];
      entries.push(segment);
      segmentsBySpeaker.set(segment.speakerId, entries);
    }
    for (const entries of segmentsBySpeaker.values()) {
      entries.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index].startMs < entries[index - 1].endMs) {
          fail("SPEAKER_EVAL_MANIFEST_SEGMENT_OVERLAP");
        }
      }
    }
  }

  if (!["self", "known", "unknown"].every((kind) => support.has(kind))) {
    fail("SPEAKER_EVAL_MANIFEST_SUPPORT");
  }
  return manifest;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePrivateAudioFile(privateRoot, relativeName, fsImpl = fs) {
  try {
    validateAudioName(relativeName);
  } catch (error) {
    if (error?.code === "SPEAKER_EVAL_MANIFEST_AUDIO_PATH") {
      fail("SPEAKER_EVAL_AUDIO_PATH");
    }
    throw error;
  }
  const resolvedRoot = fsImpl.realpathSync(path.resolve(privateRoot));
  const candidate = path.resolve(resolvedRoot, ...relativeName.split("/"));
  if (!isContained(resolvedRoot, candidate)) fail("SPEAKER_EVAL_AUDIO_PATH");

  let stat;
  try {
    stat = fsImpl.lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") fail("SPEAKER_EVAL_AUDIO_MISSING");
    fail("SPEAKER_EVAL_AUDIO_UNREADABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("SPEAKER_EVAL_AUDIO_NOT_REGULAR");

  let realCandidate;
  try {
    realCandidate = fsImpl.realpathSync(candidate);
  } catch {
    fail("SPEAKER_EVAL_AUDIO_UNREADABLE");
  }
  if (!isContained(resolvedRoot, realCandidate)) fail("SPEAKER_EVAL_AUDIO_PATH");
  return realCandidate;
}

function validatePcmWav(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    fail("SPEAKER_EVAL_WAV_INVALID");
  }

  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) fail("SPEAKER_EVAL_WAV_INVALID");
    if (id === "fmt ") {
      if (size < 16) fail("SPEAKER_EVAL_WAV_INVALID");
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (dataBytes !== null) fail("SPEAKER_EVAL_WAV_INVALID");
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (offset !== buffer.length || !format || !Number.isSafeInteger(dataBytes) || dataBytes <= 0) {
    fail("SPEAKER_EVAL_WAV_INVALID");
  }
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== 2 ||
    format.byteRate !== 32_000 ||
    dataBytes % format.blockAlign !== 0
  ) {
    fail("SPEAKER_EVAL_WAV_FORMAT");
  }
  return Object.freeze({
    sampleRate: format.sampleRate,
    frames: dataBytes / format.blockAlign,
    durationMs: (dataBytes / format.blockAlign / format.sampleRate) * 1_000,
  });
}

function defaultIsTracked(filePath, repoRoot) {
  const relative = path.relative(repoRoot, filePath);
  if (!isContained(repoRoot, filePath)) return false;
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relative], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail("SPEAKER_EVAL_CONSENT_TRACKING_CHECK_FAILED");
}

function readConsent({ privateRoot, repoRoot, fsImpl, isTracked }) {
  const consentPath = path.join(privateRoot, "consent.json");
  let stat;
  try {
    stat = fsImpl.lstatSync(consentPath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("SPEAKER_EVAL_CONSENT_MISSING");
    fail("SPEAKER_EVAL_CONSENT_UNREADABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("SPEAKER_EVAL_CONSENT_NOT_REGULAR");
  if (isTracked(consentPath, repoRoot)) fail("SPEAKER_EVAL_CONSENT_TRACKED");

  let consentText;
  try {
    consentText = fsImpl.readFileSync(consentPath, "utf8");
  } catch {
    fail("SPEAKER_EVAL_CONSENT_UNREADABLE");
  }
  let consent;
  try {
    consent = JSON.parse(consentText);
  } catch {
    fail("SPEAKER_EVAL_CONSENT_INVALID");
  }
  if (!consent || consent.consented !== true) fail("SPEAKER_EVAL_CONSENT_REQUIRED");
}

async function loadPrivateSpeakerEvaluation({
  repoRoot,
  manifestPath,
  envValue = process.env.JARVIS_SPEAKER_EVAL_DIR,
  fsImpl = fs,
  isTracked = defaultIsTracked,
  runtime,
} = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const recommended = path.resolve(absoluteRepoRoot, ".private", "speaker-eval");
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return {
      status: "skip",
      hint:
        `Speaker evaluation skipped: JARVIS_SPEAKER_EVAL_DIR is unset. ` +
        `Recommended path: ${recommended}. Set it with: ` +
        `$env:JARVIS_SPEAKER_EVAL_DIR="${recommended}". No data is downloaded.`,
    };
  }

  const configuredRoot = path.resolve(envValue.trim());
  let rootStat;
  try {
    rootStat = fsImpl.lstatSync(configuredRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "skip",
        hint:
          `Speaker evaluation skipped: directory does not exist: ${configuredRoot}. ` +
          `Set JARVIS_SPEAKER_EVAL_DIR to a consented fixture directory. ` +
          `No data is downloaded.`,
      };
    }
    fail("SPEAKER_EVAL_ROOT_UNREADABLE");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("SPEAKER_EVAL_ROOT_NOT_DIRECTORY");
  const privateRoot = fsImpl.realpathSync(configuredRoot);

  readConsent({ privateRoot, repoRoot: absoluteRepoRoot, fsImpl, isTracked });

  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("SPEAKER_EVAL_MANIFEST_UNREADABLE");
  }
  const {
    SPEAKER_IDENTITY_RESOLUTION_POLICY,
  } = require("../../../src/jarvis/main/SpeakerIdentityResolutionPolicy");
  validateSpeakerEvaluationManifest(manifest, {
    policy: SPEAKER_IDENTITY_RESOLUTION_POLICY,
  });

  const audioNames = new Set();
  for (const profile of manifest.profiles) {
    for (const audio of profile.audio) audioNames.add(audio);
  }
  for (const evaluationCase of manifest.cases) audioNames.add(evaluationCase.audio);

  const audioFiles = new Map();
  for (const audioName of [...audioNames].sort()) {
    const audioPath = resolvePrivateAudioFile(privateRoot, audioName, fsImpl);
    let wav;
    try {
      wav = fsImpl.readFileSync(audioPath);
    } catch {
      fail("SPEAKER_EVAL_AUDIO_UNREADABLE");
    }
    audioFiles.set(audioName, {
      path: audioPath,
      ...validatePcmWav(wav),
    });
  }
  for (const evaluationCase of manifest.cases) {
    const durationMs = audioFiles.get(evaluationCase.audio).durationMs;
    if (evaluationCase.segments.some((segment) => segment.endMs > durationMs)) {
      fail("SPEAKER_EVAL_SEGMENT_EXCEEDS_AUDIO");
    }
  }

  if (!runtime || typeof runtime.assertAvailable !== "function") {
    fail("SPEAKER_EVAL_RUNTIME_MISSING");
  }
  let runtimeEvidence;
  try {
    runtimeEvidence = await runtime.assertAvailable();
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("SPEAKER_EVAL_")) throw error;
    fail("SPEAKER_EVAL_RUNTIME_MISSING");
  }
  if (
    !runtimeEvidence ||
    !/^[a-f0-9]{64}$/.test(runtimeEvidence.diarizerHash) ||
    !/^[a-f0-9]{64}$/.test(runtimeEvidence.embeddingHash)
  ) {
    fail("SPEAKER_EVAL_RUNTIME_INVALID");
  }

  return {
    status: "ready",
    privateRoot,
    manifest,
    audioFiles,
    runtime: runtimeEvidence,
  };
}

module.exports = {
  SpeakerEvaluationSetupError,
  validateSpeakerEvaluationManifest,
  resolvePrivateAudioFile,
  validatePcmWav,
  loadPrivateSpeakerEvaluation,
};
