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
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      if (
        !parsed ||
        Object.keys(parsed).sort().join(",") !== "root,version" ||
        parsed.version !== 1
      ) {
        throw new Error("invalid data root configuration");
      }
      return assertSafeRoot(parsed.root, "configured Jarvis data root");
    } catch (error) {
      if (error?.code === "ENOENT") return resolveJarvisDataRoot(this.userDataDir, "");
      throw new Error("Jarvis data root configuration is invalid");
    }
  }

  hasSavedRoot() {
    return this.fs.existsSync(this.filePath);
  }

  save(root) {
    const safeRoot = assertSafeRoot(root, "Jarvis data root");
    this.fs.mkdirSync(this.userDataDir, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    let handle = null;
    try {
      handle = this.fs.openSync(temporary, "w", 0o600);
      this.fs.writeFileSync(handle, JSON.stringify({ version: 1, root: safeRoot }));
      this.fs.fsyncSync(handle);
    } finally {
      if (handle !== null) this.fs.closeSync(handle);
    }
    this.fs.renameSync(temporary, this.filePath);
    return safeRoot;
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
  const hash = (filePath) =>
    crypto.createHash("sha256").update(fsImpl.readFileSync(filePath)).digest("hex");
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
        const handle = fsImpl.openSync(targetPath, "wx", 0o600);
        try {
          fsImpl.writeFileSync(handle, fsImpl.readFileSync(sourcePath));
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

module.exports = {
  DataRootConfig,
  copyLegacyTreeSync,
  resolveJarvisDataRoot,
  resolveRecordingsRoot,
};
