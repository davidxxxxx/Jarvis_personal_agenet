const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const DATA_ROOT_CONFIG = "jarvis-data-root.json";

function assertSafeRoot(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError(`${name} must not be a volume root`);
  }
  return resolved;
}

function resolveJarvisDataRoot(userDataDir, configuredPath) {
  const userData = assertSafeRoot(userDataDir, "userDataDir");
  const configured = typeof configuredPath === "string" ? configuredPath.trim() : "";
  return configured ? assertSafeRoot(configured, "JARVIS_DATA_DIR") : path.join(userData, "jarvis");
}

function resolveRecordingsRoot(userDataDir, configuredPath) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new TypeError("userDataDir must be an absolute path");
  }
  const configured = typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (!configured) return path.join(resolveJarvisDataRoot(userDataDir, ""), "recordings");
  if (!path.isAbsolute(configured)) {
    throw new TypeError("JARVIS_RECORDINGS_DIR must be an absolute path");
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("JARVIS_RECORDINGS_DIR must not be a volume root");
  }
  return resolved;
}

class DataRootConfig {
  constructor({ userDataDir, fsImpl = fs } = {}) {
    this.userDataDir = assertSafeRoot(userDataDir, "userDataDir");
    this.filePath = path.join(this.userDataDir, DATA_ROOT_CONFIG);
    this.fs = fsImpl;
  }

  load() {
    const state = this.loadState();
    return state.phase === "complete" ? state.current : state.previous;
  }

  loadState() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.version === 1 && Object.keys(parsed).sort().join(",") === "root,version") {
        return this._completeState(assertSafeRoot(parsed.root, "configured Jarvis data root"));
      }
      const expectedKeys = [
        "current",
        "migrationId",
        "phase",
        "previous",
        "target",
        "targetIdentity",
        "version",
      ];
      if (
        parsed?.version !== 2 ||
        JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys) ||
        !["verified", "activating", "persisted", "reopening", "rollback", "complete"].includes(
          parsed.phase
        )
      ) {
        throw new Error("invalid data root configuration");
      }
      const current = assertSafeRoot(parsed.current, "configured Jarvis data root");
      if (parsed.phase === "complete") {
        if (
          parsed.previous !== null ||
          parsed.target !== null ||
          parsed.migrationId !== null ||
          parsed.targetIdentity !== null
        ) {
          throw new Error("invalid data root configuration");
        }
        return { ...parsed, current };
      }
      if (
        typeof parsed.migrationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.migrationId) ||
        (parsed.targetIdentity !== null && typeof parsed.targetIdentity !== "string")
      ) {
        throw new Error("invalid data root configuration");
      }
      return {
        ...parsed,
        current,
        previous: assertSafeRoot(parsed.previous, "previous Jarvis data root"),
        target: assertSafeRoot(parsed.target, "target Jarvis data root"),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return this._completeState(resolveJarvisDataRoot(this.userDataDir, ""));
      }
      throw new Error("Jarvis data root configuration is invalid");
    }
  }

  hasSavedRoot() {
    return this.fs.existsSync(this.filePath);
  }

  save(root) {
    const safeRoot = assertSafeRoot(root, "Jarvis data root");
    this._writeState(this._completeState(safeRoot));
    return safeRoot;
  }

  beginActivation({ previous, target, migrationId, targetIdentity = null }) {
    const safePrevious = assertSafeRoot(previous, "previous Jarvis data root");
    const safeTarget = assertSafeRoot(target, "target Jarvis data root");
    if (safePrevious === safeTarget) throw new Error("activation roots must differ");
    if (typeof migrationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(migrationId)) {
      throw new TypeError("migrationId is invalid");
    }
    if (targetIdentity !== null && typeof targetIdentity !== "string") {
      throw new TypeError("targetIdentity is invalid");
    }
    const state = {
      version: 2,
      current: safePrevious,
      previous: safePrevious,
      target: safeTarget,
      migrationId,
      targetIdentity,
      phase: "verified",
    };
    this._writeState(state);
    return state;
  }

  markActivationPhase(phase) {
    if (!['activating', 'persisted', 'reopening', 'rollback'].includes(phase)) {
      throw new TypeError("activation phase is invalid");
    }
    const state = this.loadState();
    if (state.phase === "complete") throw new Error("no activation is pending");
    const next = {
      ...state,
      current: phase === "persisted" || phase === "reopening" ? state.target : state.current,
      phase,
    };
    this._writeState(next);
    return next;
  }

  recoverActivation(validateRoot) {
    if (typeof validateRoot !== "function") throw new TypeError("validateRoot is required");
    const state = this.loadState();
    if (state.phase === "complete") return state.current;
    let selected = state.previous;
    if (["persisted", "reopening"].includes(state.phase)) {
      try {
        if (validateRoot(state.target, state)) selected = state.target;
      } catch {
        selected = state.previous;
      }
    }
    this._writeState(this._completeState(selected));
    return selected;
  }

  _completeState(root) {
    return {
      version: 2,
      current: root,
      previous: null,
      target: null,
      migrationId: null,
      targetIdentity: null,
      phase: "complete",
    };
  }

  _writeState(state) {
    this.fs.mkdirSync(this.userDataDir, { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    let handle = null;
    try {
      handle = this.fs.openSync(temporary, "wx", 0o600);
      this.fs.writeFileSync(handle, JSON.stringify(state));
      this.fs.fsyncSync(handle);
    } finally {
      if (handle !== null) this.fs.closeSync(handle);
    }
    this.fs.renameSync(temporary, this.filePath);
    let directoryHandle = null;
    try {
      directoryHandle = this.fs.openSync(this.userDataDir, "r");
      this.fs.fsyncSync(directoryHandle);
    } catch (error) {
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    } finally {
      if (directoryHandle !== null) this.fs.closeSync(directoryHandle);
    }
  }
}

function copyLegacyTreeSync({ from, to, fsImpl = fs }) {
  const source = assertSafeRoot(from, "legacy source");
  const target = assertSafeRoot(to, "legacy destination");
  const sourceStat = fsImpl.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("legacy data source is unsafe");
  }
  fsImpl.mkdirSync(target, { recursive: true });
  const hash = (filePath) => fileHashSync(filePath, fsImpl);
  const walk = (sourceDir, targetDir) => {
    for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      const stat = fsImpl.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("legacy data contains a link");
      if (stat.isDirectory()) {
        fsImpl.mkdirSync(targetPath, { recursive: true });
        const targetStat = fsImpl.lstatSync(targetPath);
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
          throw new Error("legacy data destination is unsafe");
        }
        walk(sourcePath, targetPath);
      } else if (stat.isFile()) {
        if (fsImpl.existsSync(targetPath)) {
          const targetStat = fsImpl.lstatSync(targetPath);
          if (
            !targetStat.isFile() ||
            targetStat.isSymbolicLink() ||
            targetStat.size !== stat.size ||
            hash(targetPath) !== hash(sourcePath)
          ) {
            throw new Error("legacy data destination conflicts with existing data");
          }
          continue;
        }
        fsImpl.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        const handle = fsImpl.openSync(targetPath, "r+");
        try {
          fsImpl.fsyncSync(handle);
        } finally {
          fsImpl.closeSync(handle);
        }
        if (hash(targetPath) !== hash(sourcePath))
          throw new Error("legacy data verification failed");
      } else throw new Error("legacy data contains an unsupported entry");
    }
  };
  walk(source, target);
}

function fileHashSync(filePath, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = fsImpl.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fsImpl.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fsImpl.closeSync(handle);
  }
  return hash.digest("hex");
}

function adoptLegacyDatabaseSync({ from, to, fsImpl = fs }) {
  if (typeof from !== "string" || !path.isAbsolute(from)) {
    throw new TypeError("legacy database source must be absolute");
  }
  if (typeof to !== "string" || !path.isAbsolute(to)) {
    throw new TypeError("legacy database destination must be absolute");
  }
  const source = path.resolve(from);
  const target = path.resolve(to);
  const initialSourceStat = fsImpl.lstatSync(source);
  if (!initialSourceStat.isFile() || initialSourceStat.isSymbolicLink()) {
    throw new Error("legacy database source is unsafe");
  }
  const checkpoint = new (require("./JarvisRepository"))(source);
  try {
    checkpoint.checkpointForMigration();
  } finally {
    checkpoint.close();
  }
  const sourceStat = fsImpl.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("legacy database source changed during checkpoint");
  }
  const expectedHash = fileHashSync(source, fsImpl);
  if (fsImpl.existsSync(target)) {
    const targetStat = fsImpl.lstatSync(target);
    if (
      !targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      targetStat.size !== sourceStat.size ||
      fileHashSync(target, fsImpl) !== expectedHash
    ) {
      throw new Error("legacy database destination conflicts with existing data");
    }
    return target;
  }
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fsImpl.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  const handle = fsImpl.openSync(temporary, "r+");
  try {
    fsImpl.fsyncSync(handle);
  } finally {
    fsImpl.closeSync(handle);
  }
  if (fileHashSync(temporary, fsImpl) !== expectedHash) {
    fsImpl.rmSync(temporary, { force: true });
    throw new Error("legacy database verification failed");
  }
  fsImpl.renameSync(temporary, target);
  return target;
}

module.exports = {
  DataRootConfig,
  adoptLegacyDatabaseSync,
  copyLegacyTreeSync,
  resolveJarvisDataRoot,
  resolveRecordingsRoot,
};
