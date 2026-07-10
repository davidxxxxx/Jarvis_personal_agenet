const path = require("node:path");
const { spawn } = require("node:child_process");

const RESULTS = new Set(["deleted", "missing", "outside", "retry", "unsupported"]);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function retryRows(paths, code) {
  return paths.map(() => ({ status: "retry", code }));
}

function createSafeRecordingDelete({
  platform = process.platform,
  helperDir = path.resolve(__dirname, "../native/windows"),
  spawnImpl = spawn,
  systemRoot = process.env.SystemRoot,
  timeoutMs = 15_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const active = new Set();
  if (platform !== "win32") {
    const unsupported = async (_recordingsRoot, paths) =>
      paths.map(() => ({ status: "unsupported", code: "platform_unsupported" }));
    unsupported.cancel = () => {};
    return unsupported;
  }

  const windowsRoot = typeof systemRoot === "string" ? systemRoot : "";
  const powershell = path.win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const trustedExecutable = path.win32.isAbsolute(powershell) && path.win32.isAbsolute(windowsRoot);
  const scriptPath = path.resolve(helperDir, "delete-recording-safe.ps1");

  const deleteBatch = (recordingsRoot, paths) => {
    if (!Array.isArray(paths)) return Promise.reject(new TypeError("paths must be an array"));
    if (paths.length === 0) return Promise.resolve([]);
    if (!trustedExecutable) return Promise.resolve(retryRows(paths, "trusted_helper_unavailable"));

    return new Promise((resolve) => {
      let child;
      let stdout = "";
      let outputTooLarge = false;
      let settled = false;
      let terminationCode = null;
      let timer;
      const finish = (rows) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timer);
        if (child) active.delete(child);
        resolve(rows);
      };

      try {
        child = spawnImpl(
          powershell,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
        );
      } catch {
        finish(retryRows(paths, "helper_unavailable"));
        return;
      }

      active.add(child);
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        if (outputTooLarge) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
          outputTooLarge = true;
          terminationCode = "helper_output_too_large";
          child.kill?.();
        }
      });
      child.on("error", () => finish(retryRows(paths, "helper_unavailable")));
      child.on("close", (code) => {
        if (terminationCode) return finish(retryRows(paths, terminationCode));
        if (code !== 0 || outputTooLarge) return finish(retryRows(paths, "helper_failed"));
        try {
          const parsed = JSON.parse(stdout.trim());
          if (!Array.isArray(parsed) || parsed.length !== paths.length) throw new Error();
          const rows = parsed.map((row) => {
            if (!RESULTS.has(row?.status) || typeof row?.code !== "string") throw new Error();
            return { status: row.status, code: row.code };
          });
          finish(rows);
        } catch {
          finish(retryRows(paths, "invalid_helper_result"));
        }
      });
      timer = setTimeoutImpl(() => {
        terminationCode = "helper_timeout";
        child.kill?.();
      }, timeoutMs);
      timer?.unref?.();
      try {
        child.stdin.end(JSON.stringify({ root: recordingsRoot, paths }));
      } catch {
        terminationCode = "helper_unavailable";
        child.kill?.();
      }
    });
  };

  deleteBatch.cancel = () => {
    for (const child of active) {
      child.kill?.();
    }
  };
  return deleteBatch;
}

module.exports = { createSafeRecordingDelete };
