const { spawn } = require("node:child_process");
const WindowsLoopbackAudioManager = require("./windowsLoopbackAudioManager");
const { normalizeProcessApplications } = require("./applicationNameNormalizer");

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_LINE_BUFFER_BYTES = 64 * 1024;

async function defaultProcessList() {
  const module = await import("ps-list");
  return module.default();
}

class WindowsAudioSessionWatcher {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    processId = process.pid,
    processList = defaultProcessList,
    resolveBinary = null,
    capabilityProvider = null,
    onSession = null,
    onWarning = null,
    onError = null,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.processId = processId;
    this.processList = processList;
    this.manager = new WindowsLoopbackAudioManager({ spawnImpl, platform, processId });
    this.resolveBinary = resolveBinary ?? (() => this.manager.resolveBinary());
    this.capabilityProvider =
      capabilityProvider ?? (() => this.manager.getCapability({ force: true }));
    this.onSession = onSession;
    this.onWarning = onWarning;
    this.onError = onError;
    this.process = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.identityByPid = new Map();
    this.processRefreshPromise = null;
    this.stopping = false;
  }

  async start() {
    if (this.process) return;
    if (this.platform !== "win32") {
      throw new Error("Application audio session watch is available only on Windows.");
    }
    const capability = await this.capabilityProvider();
    if (!capability?.available || !capability.supportsApplicationCapture || !capability.supportsSessionWatch) {
      const minimum = capability?.minimumWindowsBuild ?? 20348;
      throw new Error(`Application audio capture requires Windows build ${minimum} or newer.`);
    }
    const binary = this.resolveBinary();
    if (!binary) throw new Error("Windows system audio helper binary not found.");

    const child = this.spawnImpl(
      binary,
      ["watch-sessions", "--exclude-pid", String(this.processId)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    this.process = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stopping = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(reject, new Error("Timed out starting Windows audio session watch."), true);
      }, START_TIMEOUT_MS);
      const finish = (callback, value, stop = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (stop) void this.stop();
        callback(value);
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) return;
        this._consumeLines("stdoutBuffer", chunk, (message) => {
          if (message.type === "ready") {
            finish(resolve);
          } else if (message.type === "session") {
            void this._handleSession(message);
          }
        });
      });
      child.stderr.on("data", (chunk) => {
        if (this.process !== child) return;
        this._consumeLines("stderrBuffer", chunk, (message) => {
          if (message.type === "warning") this.onWarning?.(this._safeDiagnostic(message));
          if (message.type === "error") {
            const error = this._processError(message);
            if (!settled) finish(reject, error, true);
            else this.onError?.(error);
          }
        });
      });
      child.on("error", (error) => {
        if (this.process === child) this.process = null;
        finish(reject, error);
      });
      child.on("exit", (code, signal) => {
        const expected = this.stopping;
        if (this.process === child) this.process = null;
        if (!settled) {
          finish(
            reject,
            new Error(
              `Windows audio session watch exited before ready (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
        } else if (!expected) {
          this.onError?.(
            new Error(
              `Windows audio session watch exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
        }
      });
    });
  }

  async stop() {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          resolve();
        }
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        try {
          child.kill();
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
    if (this.process === child) this.process = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stopping = false;
  }

  async _handleSession(message) {
    if (
      (message.state !== "active" && message.state !== "inactive") ||
      !Number.isSafeInteger(message.pid) ||
      message.pid <= 0 ||
      typeof message.peak !== "number" ||
      !Number.isFinite(message.peak) ||
      message.peak < 0 ||
      message.peak > 1
    ) {
      return;
    }
    if (!this.identityByPid.has(message.pid)) await this._refreshProcessMap();
    const identity = this.identityByPid.get(message.pid);
    if (!identity) return;
    this.onSession?.({
      state: message.state,
      pid: message.pid,
      applicationKey: identity.applicationKey,
      applicationDisplayName: identity.applicationDisplayName,
      peak: message.peak,
    });
    if (message.state === "inactive") this.identityByPid.delete(message.pid);
  }

  async _refreshProcessMap() {
    if (this.processRefreshPromise) return this.processRefreshPromise;
    this.processRefreshPromise = Promise.resolve()
      .then(() => this.processList())
      .then((processes) => {
        this.identityByPid = normalizeProcessApplications(processes);
      })
      .catch((error) => {
        this.onWarning?.({ type: "warning", code: "process_identity_unavailable" });
        return error;
      })
      .finally(() => {
        this.processRefreshPromise = null;
      });
    return this.processRefreshPromise;
  }

  _consumeLines(bufferName, chunk, onMessage) {
    this[bufferName] += chunk.toString("utf8");
    if (Buffer.byteLength(this[bufferName], "utf8") > MAX_LINE_BUFFER_BYTES) {
      this[bufferName] = "";
      this.onWarning?.({ type: "warning", code: "native_event_too_large" });
      return;
    }
    let newline = this[bufferName].indexOf("\n");
    while (newline !== -1) {
      const line = this[bufferName].slice(0, newline).trim();
      this[bufferName] = this[bufferName].slice(newline + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          this.onWarning?.({ type: "warning", code: "invalid_native_event" });
        }
      }
      newline = this[bufferName].indexOf("\n");
    }
  }

  _safeDiagnostic(message) {
    return {
      type: message.type,
      code: typeof message.code === "string" ? message.code : "native_warning",
    };
  }

  _processError(message) {
    const error = new Error("Windows audio session watch failed");
    error.code = typeof message.code === "string" ? message.code : "native_watch_failed";
    return error;
  }
}

module.exports = WindowsAudioSessionWatcher;
