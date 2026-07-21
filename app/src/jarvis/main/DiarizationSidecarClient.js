const { EventEmitter } = require("node:events");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class DiarizationSidecarClient extends EventEmitter {
  constructor({
    packRoot,
    spawnImpl = spawn,
    requestTimeoutMs = 30 * 60_000,
    log = () => {},
    selectedGpuUuid = null,
  } = {}) {
    super();
    if (typeof packRoot !== "string" || !path.isAbsolute(packRoot)) {
      throw new TypeError("packRoot must be absolute");
    }
    if (typeof spawnImpl !== "function" || typeof log !== "function") {
      throw new TypeError("sidecar dependencies are invalid");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
      throw new RangeError("requestTimeoutMs must be at least one second");
    }
    if (
      selectedGpuUuid !== null &&
      (typeof selectedGpuUuid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(selectedGpuUuid))
    ) {
      throw new TypeError("selectedGpuUuid is invalid");
    }
    this.packRoot = path.resolve(packRoot);
    this.spawn = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.selectedGpuUuid = selectedGpuUuid;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.sequence = 0;
    this.stopping = false;
  }

  _runtimePaths() {
    return {
      python: path.join(this.packRoot, "runtime", "python.exe"),
      sidecar: path.join(this.packRoot, "runtime", "jarvis_diarization_sidecar.py"),
      cache: path.join(this.packRoot, "cache"),
    };
  }

  async start() {
    if (this.child) return this;
    const paths = this._runtimePaths();
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
    const runtimePath = [
      path.dirname(paths.python),
      path.join(this.packRoot, "runtime", "Library", "bin"),
      ...(systemRoot ? [path.join(systemRoot, "System32")] : []),
    ].join(path.delimiter);
    this.stopping = false;
    const child = this.spawn(
      paths.python,
      ["-I", "-u", paths.sidecar, "--server", "--model-root", this.packRoot],
      {
        cwd: this.packRoot,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: runtimePath,
          PYTHONNOUSERSITE: "1",
          PYTHONUTF8: "1",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HOME: paths.cache,
          TORCH_HOME: paths.cache,
          JARVIS_AI_MODEL_ROOT: this.packRoot,
          ...(this.selectedGpuUuid ? { CUDA_VISIBLE_DEVICES: this.selectedGpuUuid } : {}),
        },
      }
    );
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this._handleLine(line));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (value) =>
      this.log({ phase: "diarization_sidecar_stderr", value: String(value).slice(-4_096) })
    );
    child.once("error", (error) =>
      this._close(codedError("DIARIZATION_SIDECAR_START_FAILED", error.message))
    );
    child.once("exit", (code, signal) => {
      if (!this.stopping) {
        this._close(
          codedError(
            "DIARIZATION_SIDECAR_EXITED",
            `sidecar exited (${code ?? "null"}/${signal ?? "none"})`
          )
        );
      }
    });
    return this;
  }

  _handleLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_BYTES) {
      this._close(
        codedError("DIARIZATION_SIDECAR_PROTOCOL_ERROR", "sidecar response is too large")
      );
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._close(
        codedError("DIARIZATION_SIDECAR_PROTOCOL_ERROR", "sidecar returned invalid JSON")
      );
      return;
    }
    const request = this.pending.get(message?.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok === true) request.resolve(message.result);
    else
      request.reject(
        codedError(
          message?.error?.code || "DIARIZATION_SIDECAR_FAILED",
          message?.error?.message || "sidecar request failed"
        )
      );
  }

  _close(error) {
    const child = this.child;
    this.child = null;
    this.lines?.close?.();
    this.lines = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    child?.stdin?.destroy?.();
    this.emit("closed", error);
  }

  async request(command, payload = {}) {
    if (!this.child) await this.start();
    if (!this.child?.stdin?.writable) {
      throw codedError("DIARIZATION_SIDECAR_UNAVAILABLE", "sidecar input is unavailable");
    }
    const id = `request_${++this.sequence}`;
    const message = `${JSON.stringify({ id, command, ...payload })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError("DIARIZATION_SIDECAR_TIMEOUT", "sidecar request timed out"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(message, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(codedError("DIARIZATION_SIDECAR_WRITE_FAILED", error.message));
      });
    });
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.stopping = true;
    try {
      child.stdin.write(
        `${JSON.stringify({ id: `shutdown_${++this.sequence}`, command: "shutdown" })}\n`
      );
    } catch {}
    this._close(codedError("DIARIZATION_SIDECAR_STOPPED", "sidecar stopped"));
    child.kill?.();
    this.stopping = false;
  }

  getPid() {
    return Number.isSafeInteger(this.child?.pid) && this.child.pid > 0 ? this.child.pid : null;
  }
}

module.exports = DiarizationSidecarClient;
