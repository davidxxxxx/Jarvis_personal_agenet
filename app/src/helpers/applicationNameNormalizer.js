const crypto = require("node:crypto");
const path = require("node:path");

const KNOWN_APPLICATIONS = Object.freeze({
  chrome: { applicationKey: "chrome", applicationDisplayName: "Chrome" },
  msedge: { applicationKey: "edge", applicationDisplayName: "Microsoft Edge" },
  firefox: { applicationKey: "firefox", applicationDisplayName: "Firefox" },
  kook: { applicationKey: "kook", applicationDisplayName: "KOOK" },
  discord: { applicationKey: "discord", applicationDisplayName: "Discord" },
  teams: { applicationKey: "teams", applicationDisplayName: "Microsoft Teams" },
  "ms-teams": { applicationKey: "teams", applicationDisplayName: "Microsoft Teams" },
  zoom: { applicationKey: "zoom", applicationDisplayName: "Zoom" },
  "zoom.us": { applicationKey: "zoom", applicationDisplayName: "Zoom" },
  dota2: { applicationKey: "dota2", applicationDisplayName: "DOTA 2" },
  steam: { applicationKey: "steam", applicationDisplayName: "Steam" },
  vlc: { applicationKey: "vlc", applicationDisplayName: "VLC" },
  spotify: { applicationKey: "spotify", applicationDisplayName: "Spotify" },
});

const PRIVATE_HELPERS = new Set([
  "jarvis-memory",
  "jarvis-memory-assistant",
  "windows-system-audio-helper",
  "whisper-server",
  "whisper-cli",
  "ffmpeg",
  "electron",
]);

function boundedDisplayName(value) {
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[\\/:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, 80).join("");
}

function canonicalKey(stem) {
  const ascii = stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 64);
  if (ascii) return ascii;
  return `application-${crypto.createHash("sha256").update(stem, "utf8").digest("hex").slice(0, 8)}`;
}

function normalizeApplicationIdentity(executableName) {
  if (typeof executableName !== "string" || !executableName.trim()) return null;
  const input = executableName.trim();
  if (/[\\/]$/u.test(input)) return null;
  const basename = path.win32.basename(input);
  if (!basename || basename === "." || basename === "..") return null;
  const stem = basename.replace(/\.exe$/iu, "").trim();
  if (!stem) return null;
  const normalizedStem = stem.toLowerCase().replace(/\s+/gu, "-");
  if (PRIVATE_HELPERS.has(normalizedStem)) return null;

  const known = KNOWN_APPLICATIONS[normalizedStem];
  if (known) return { ...known };

  const applicationDisplayName = boundedDisplayName(stem);
  if (!applicationDisplayName) return null;
  return {
    applicationKey: canonicalKey(stem),
    applicationDisplayName,
  };
}

function normalizeProcessApplications(processes) {
  if (!Array.isArray(processes)) throw new TypeError("processes must be an array");
  const result = new Map();
  for (const processInfo of processes) {
    if (!processInfo || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0) continue;
    const identity = normalizeApplicationIdentity(processInfo.name);
    if (identity) result.set(processInfo.pid, identity);
  }
  return result;
}

module.exports = {
  normalizeApplicationIdentity,
  normalizeProcessApplications,
};
