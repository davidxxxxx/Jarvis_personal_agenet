const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RESULTS = new Set(["deleted", "missing", "outside", "retry", "unsupported"]);

function createSafeRecordingDelete({
  platform = process.platform,
  helperDir = path.resolve(__dirname, "../native/windows"),
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") {
    return () => ({ status: "unsupported", code: "platform_unsupported" });
  }
  const scriptPath = path.join(helperDir, "delete-recording-safe.ps1");
  return (recordingsRoot, filePath) => {
    const result = spawnSyncImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        recordingsRoot,
        filePath,
      ],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      }
    );
    if (result.error) {
      return {
        status: "retry",
        code: result.error.code === "ETIMEDOUT" ? "helper_timeout" : "helper_unavailable",
      };
    }
    if (result.status !== 0) return { status: "retry", code: "helper_failed" };
    try {
      const parsed = JSON.parse(result.stdout.trim());
      if (!RESULTS.has(parsed.status) || typeof parsed.code !== "string") throw new Error();
      return { status: parsed.status, code: parsed.code };
    } catch {
      return { status: "retry", code: "invalid_helper_result" };
    }
  };
}

module.exports = { createSafeRecordingDelete };
