const fs = require("fs");
const net = require("net");
const path = require("path");
const { killProcessGroup } = require("./process");

const GRACEFUL_STOP_TIMEOUT_MS = 5000;

function tryBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function isPortAvailable(port) {
  return (
    (await tryBind(port, "0.0.0.0")) &&
    (await tryBind(port, "::")) &&
    (await tryBind(port, "127.0.0.1"))
  );
}

async function findAvailablePort(rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

function resolveBinaryPath(binaryName) {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", binaryName));
  }

  const projectBinDir = path.resolve(__dirname, "..", "..", "resources", "bin");
  candidates.push(path.join(projectBinDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.statSync(candidate);
        return candidate;
      } catch {
        // Can't access binary
      }
    }
  }

  return null;
}

function waitForProcessClose(proc, timeoutMs) {
  if (!proc || proc.exitCode !== null || proc.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    proc.once("close", onClose);
  });
}

async function gracefulStopProcess(
  proc,
  {
    gracefulTimeoutMs = GRACEFUL_STOP_TIMEOUT_MS,
    forcedTimeoutMs = GRACEFUL_STOP_TIMEOUT_MS,
  } = {}
) {
  if (!proc || proc.exitCode !== null || proc.signalCode != null) return;
  killProcessGroup(proc, "SIGTERM");
  if (await waitForProcessClose(proc, gracefulTimeoutMs)) return;
  killProcessGroup(proc, "SIGKILL");
  if (await waitForProcessClose(proc, forcedTimeoutMs)) return;
  throw new Error("native process termination could not be confirmed");
}

module.exports = {
  findAvailablePort,
  isPortAvailable,
  resolveBinaryPath,
  gracefulStopProcess,
};
