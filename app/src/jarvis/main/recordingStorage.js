const path = require("node:path");

function resolveRecordingsRoot(userDataDir, configuredPath) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new TypeError("userDataDir must be an absolute path");
  }
  const configured = typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (!configured) return path.join(userDataDir, "recordings");
  if (!path.isAbsolute(configured)) {
    throw new TypeError("JARVIS_RECORDINGS_DIR must be an absolute path");
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("JARVIS_RECORDINGS_DIR must not be a volume root");
  }
  return resolved;
}

module.exports = { resolveRecordingsRoot };
