const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const WINDOWS_HELPER_PATH = path.join(__dirname, "directory-lease-helper.ps1");
const DATA_ROOT_IN_USE_CODE = "JARVIS_DATA_ROOT_IN_USE";

function dataRootInUseError() {
  const error = new Error("data-root runtime lease acquisition failed");
  error.code = DATA_ROOT_IN_USE_CODE;
  return error;
}

function timeoutAfter(milliseconds, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function defaultTerminateChildTree(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const finish = () => {
      try {
        child.kill();
      } catch {}
      resolve();
    };
    if (process.platform !== "win32" || !Number.isSafeInteger(child.pid)) {
      finish();
      return;
    }
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: timeoutMs },
      finish
    );
  });
}

class DirectoryLeaseProvider {
  constructor({
    platform = process.platform,
    fsImpl = fsp,
    spawnImpl = spawn,
    timeoutMs = 10_000,
    terminateChildTree = defaultTerminateChildTree,
  } = {}) {
    if (typeof terminateChildTree !== "function") {
      throw new TypeError("terminateChildTree must be a function");
    }
    this.platform = platform;
    this.fs = fsImpl;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.terminateChildTree = terminateChildTree;
  }

  async acquire(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new TypeError("directory lease path must be absolute");
    }
    try {
      return this.platform === "win32"
        ? await this._acquireWindows(path.resolve(candidate), "--open")
        : await this._acquirePosix(path.resolve(candidate));
    } catch {
      throw new Error("directory lease acquisition failed");
    }
  }

  async createAndAcquire(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new TypeError("directory lease path must be absolute");
    }
    const resolved = path.resolve(candidate);
    try {
      if (this.platform === "win32") {
        return await this._acquireWindows(resolved, "--create");
      }
      await this.fs.mkdir(resolved, { recursive: false, mode: 0o700 });
      return await this._acquirePosix(resolved);
    } catch {
      throw new Error("directory lease acquisition failed");
    }
  }

  async acquireExclusiveFile(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new TypeError("exclusive lease path must be absolute");
    }
    const resolved = path.resolve(candidate);
    try {
      return this.platform === "win32"
        ? await this._acquireWindows(resolved, "--exclusive-file", "file")
        : await this._acquireExclusivePosixFile(resolved);
    } catch {
      throw dataRootInUseError();
    }
  }

  async _acquirePosix(candidate) {
    const leaseFs = this.fs;
    const handle = await this.fs.open(candidate, "r");
    let active = true;
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory()) throw new Error("leased path is not a directory");
      const identity = `posix:${String(stat.dev)}:${String(stat.ino)}`;
      return {
        path: candidate,
        identity,
        assertActive() {
          if (!active) throw new Error("directory lease is not active");
        },
        async assertCurrent() {
          if (!active) throw new Error("directory lease is not active");
          const current = await leaseFs.lstat(candidate);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            String(current.dev) !== String(stat.dev) ||
            String(current.ino) !== String(stat.ino)
          ) {
            throw new Error("directory lease path changed");
          }
        },
        async release() {
          if (!active) return;
          active = false;
          await handle.close();
        },
      };
    } catch (error) {
      active = false;
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async _acquireExclusivePosixFile(candidate) {
    const handle = await this.fs.open(candidate, "wx", 0o600);
    let active = true;
    return {
      path: candidate,
      identity: `posix-file:${candidate}`,
      assertActive() {
        if (!active) throw new Error("directory lease is not active");
      },
      async assertCurrent() {
        if (!active) throw new Error("directory lease is not active");
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("exclusive lease path changed");
      },
      async release() {
        if (!active) return;
        active = false;
        await handle.close();
        await fsp.unlink(candidate).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      },
    };
  }

  async _acquireWindows(candidate, mode, expectedKind = "directory") {
    const timeoutMs = this.timeoutMs;
    let child;
    try {
      child = this.spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", WINDOWS_HELPER_PATH, mode, candidate],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (error) {
      throw error;
    }
    let active = false;
    let releasing = false;
    let exited = false;
    let exitError = null;
    let stdout = "";
    let stderr = "";
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const settleExit = (code, signal, error = null) => {
      if (exited) return;
      exited = true;
      if (!releasing) {
        exitError = error ?? new Error(`directory lease helper exited: ${code ?? signal}`);
      }
      resolveExit({ code, signal, error });
    };
    child.once("close", (code, signal) => {
      settleExit(code, signal);
    });
    child.on("error", (error) => {
      exitError = error;
      if (!Number.isSafeInteger(child.pid)) {
        settleExit(null, null, error);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.stderr.on("error", () => {});
    child.stdin.on("error", (error) => {
      if (!releasing) exitError = error;
    });

    const reap = async () => {
      if (exited) return;
      await this.terminateChildTree(child, this.timeoutMs);
      if (exited) return;
      const reapTimeout = timeoutAfter(this.timeoutMs, "directory lease helper did not exit");
      try {
        await Promise.race([exitPromise, reapTimeout.promise]);
      } finally {
        reapTimeout.clear();
      }
    };

    let cleanupReady = () => {};
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanupReady();
        callback(value);
      };
      const onError = (error) => finish(reject, error);
      const onClose = () => finish(reject, new Error(stderr || "directory lease helper exited"));
      const onData = (chunk) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(resolve, JSON.parse(stdout.slice(0, newline).trim()));
        } catch (error) {
          finish(reject, error);
        }
      };
      cleanupReady = () => {
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        child.stdout.removeListener("data", onData);
      };
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.on("data", onData);
    });
    const acquisitionTimeout = timeoutAfter(this.timeoutMs, "directory lease helper timed out");
    let metadata;
    try {
      metadata = await Promise.race([ready, acquisitionTimeout.promise]);
      acquisitionTimeout.clear();
      const attributes = Number(metadata?.attributes);
      const isDirectory = (attributes & 0x10) !== 0;
      if (
        !/^[0-9a-f]{8}$/i.test(metadata?.volumeSerial) ||
        !/^[0-9a-f]{16}$/i.test(metadata?.fileId) ||
        !Number.isSafeInteger(attributes) ||
        (attributes & 0x400) !== 0 ||
        (expectedKind === "directory" ? !isDirectory : isDirectory)
      ) {
        throw new Error("directory lease metadata is invalid");
      }
      active = true;
    } catch (error) {
      acquisitionTimeout.clear();
      cleanupReady();
      await reap();
      throw error;
    }
    const identity = `win32:${metadata.volumeSerial.toLowerCase()}:${metadata.fileId.toLowerCase()}`;
    return {
      path: candidate,
      identity,
      assertActive() {
        if (!active || exited || exitError) throw new Error("directory lease is not active");
      },
      async assertCurrent() {
        if (!active || exited || exitError) throw new Error("directory lease is not active");
      },
      async release() {
        if (!active) return;
        releasing = true;
        active = false;
        child.stdin.end("release\n");
        const releaseTimeout = timeoutAfter(timeoutMs, "directory lease release timed out");
        try {
          const result = await Promise.race([exitPromise, releaseTimeout.promise]);
          if (result.error || result.code !== 0) {
            throw new Error("directory lease helper release failed");
          }
        } catch (error) {
          await reap();
          throw error;
        } finally {
          releaseTimeout.clear();
        }
      },
    };
  }
}

module.exports = { DATA_ROOT_IN_USE_CODE, DirectoryLeaseProvider, WINDOWS_HELPER_PATH };
