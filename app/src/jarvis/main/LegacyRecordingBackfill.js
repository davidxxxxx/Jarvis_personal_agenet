const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEGACY_AUDIO_EXTENSIONS = new Set([".wav", ".flac"]);

function emptyResult() {
  return { linked: 0, orphaned: [], jobsCreated: 0 };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function deterministicLegacyMicTrackId(sessionId) {
  return `legacy_mic_${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function isSafeLegacyFile(chunk, recordingsRoot, realSessionDir) {
  if (!chunk || chunk.source_type !== "mic" || typeof chunk.path !== "string") return false;
  const extension = path.extname(chunk.path).toLowerCase();
  if (!LEGACY_AUDIO_EXTENSIONS.has(extension)) return false;
  const candidate = path.isAbsolute(chunk.path)
    ? path.resolve(chunk.path)
    : path.resolve(recordingsRoot, chunk.path);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return isInside(realSessionDir, fs.realpathSync(candidate));
  } catch {
    return false;
  }
}

function backfillLegacyRecordings({ repository, recordingsRoot }) {
  if (
    !repository ||
    typeof repository.getSession !== "function" ||
    typeof repository.listUntrackedAudioChunks !== "function" ||
    typeof repository.backfillLegacyMicChunks !== "function"
  ) {
    throw new TypeError("repository must provide the legacy recording backfill interface");
  }
  if (typeof recordingsRoot !== "string" || recordingsRoot.length === 0) {
    throw new TypeError("recordingsRoot is required");
  }

  const root = path.resolve(recordingsRoot);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyResult();
    throw error;
  }
  if (!rootStat.isDirectory()) return emptyResult();
  const realRoot = fs.realpathSync(root);
  const result = emptyResult();
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort(compareNames);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.resolve(root, entry.name);
    let realDirectory;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      realDirectory = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (!isInside(realRoot, realDirectory)) continue;
    if (!SAFE_ID.test(entry.name) || !repository.getSession(entry.name)) {
      result.orphaned.push(directory);
      continue;
    }

    const chunks = repository
      .listUntrackedAudioChunks(entry.name)
      .filter((chunk) => isSafeLegacyFile(chunk, root, realDirectory));
    const linked = repository.backfillLegacyMicChunks({
      sessionId: entry.name,
      deterministicTrackId: deterministicLegacyMicTrackId(entry.name),
      chunkIds: chunks.map((chunk) => chunk.id),
    });
    result.linked += linked.linked;
    result.jobsCreated += linked.jobsCreated;
  }

  return result;
}

function runLegacyRecordingBackfillAtStartup({
  repository,
  recordingsRoot,
  log = () => {},
  backfillImpl = backfillLegacyRecordings,
}) {
  if (typeof log !== "function") throw new TypeError("log must be a function");
  const safeLog = (message, details) => {
    try {
      log(message, details);
    } catch {}
  };
  try {
    const result = backfillImpl({ repository, recordingsRoot });
    safeLog("Jarvis legacy recording backfill", {
      linked: result.linked,
      orphaned: result.orphaned.length,
      jobsCreated: result.jobsCreated,
    });
    return result;
  } catch {
    safeLog("Jarvis legacy recording backfill failed", { code: "legacy_backfill_failed" });
    return null;
  }
}

module.exports = {
  backfillLegacyRecordings,
  runLegacyRecordingBackfillAtStartup,
};
