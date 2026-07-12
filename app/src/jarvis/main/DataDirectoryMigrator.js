const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MANIFEST_VERSION = 1;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function sha256(filePath, fsImpl) {
  const bytes = await fsImpl.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

class DefaultVolumeInspector {
  async inspect(target) {
    if (process.platform === "win32" && /^\\\\/.test(target)) {
      return { kind: "network", writable: false };
    }
    if (process.platform !== "win32") return { kind: "fixed", writable: true };
    const root = path.parse(target).root;
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$d=[System.IO.DriveInfo]::new($args[0]); [Console]::Write($d.DriveType.ToString())",
          root,
        ],
        { windowsHide: true, timeout: 5_000 },
        (error, stdout) => {
          if (error) return resolve({ kind: "unknown", writable: false });
          const kind = String(stdout).trim().toLowerCase();
          resolve({ kind: kind === "fixed" ? "fixed" : kind, writable: kind === "fixed" });
        }
      );
    });
  }
}

class DataDirectoryMigrator {
  constructor({
    fsImpl = fsp,
    volumeInspector = new DefaultVolumeInspector(),
    closeHolders = async () => {},
    persistRoot = async () => {},
    reopenHolders = async () => {},
    onProgress = () => {},
  } = {}) {
    if (!fsImpl || typeof fsImpl.lstat !== "function" || typeof fsImpl.copyFile !== "function") {
      throw new TypeError("fsImpl must provide promise-based file operations");
    }
    if (!volumeInspector || typeof volumeInspector.inspect !== "function") {
      throw new TypeError("volumeInspector.inspect is required");
    }
    for (const [name, callback] of Object.entries({
      closeHolders,
      persistRoot,
      reopenHolders,
      onProgress,
    })) {
      if (typeof callback !== "function") throw new TypeError(`${name} must be a function`);
    }
    this.fs = fsImpl;
    this.volumeInspector = volumeInspector;
    this.closeHolders = closeHolders;
    this.persistRoot = persistRoot;
    this.reopenHolders = reopenHolders;
    this.onProgress = onProgress;
    this.inProgress = false;
  }

  async migrate({ from, to, signal, failAfterFiles } = {}) {
    if (this.inProgress) throw new Error("migration already in progress");
    this.inProgress = true;
    try {
      const source = this._safeAbsolute(from, "source");
      const target = this._safeAbsolute(to, "destination");
      await this._validateRoots(source, target);
      this._throwIfAborted(signal);

      const entries = await this._scanSource(source, signal);
      const staging = `${target}.jarvis-migration-staging`;
      const manifestPath = `${target}.jarvis-migration-manifest.json`;
      let manifest = await this._loadManifest(manifestPath);
      if (manifest) this._validateManifest(manifest, source, target, entries);
      else {
        manifest = {
          version: MANIFEST_VERSION,
          sourceId: crypto.createHash("sha256").update(source).digest("hex"),
          targetId: crypto.createHash("sha256").update(target).digest("hex"),
          phase: "copying",
          files: entries.map((entry) => ({ ...entry, copied: false })),
        };
        await this._writeManifest(manifestPath, manifest);
      }

      const targetExists = await this._exists(target);
      if (!targetExists) {
        await this.fs.mkdir(staging, { recursive: true });
        let copiedThisRun = 0;
        for (const entry of manifest.files) {
          this._throwIfAborted(signal);
          const sourceFile = this._inside(source, entry.relative);
          const stagedFile = this._inside(staging, entry.relative);
          if (entry.copied && (await this._verifiedFile(stagedFile, entry))) continue;
          await this.fs.mkdir(path.dirname(stagedFile), { recursive: true });
          await this.fs
            .copyFile(sourceFile, stagedFile, fs.constants.COPYFILE_EXCL)
            .catch(async (error) => {
              if (error?.code !== "EEXIST") throw error;
              await this.fs.rm(stagedFile, { force: true });
              await this.fs.copyFile(sourceFile, stagedFile, fs.constants.COPYFILE_EXCL);
            });
          await this._fsyncFile(stagedFile);
          if (!(await this._verifiedFile(stagedFile, entry))) {
            await this.fs.rm(stagedFile, { force: true });
            throw new Error("migration verification failed");
          }
          entry.copied = true;
          copiedThisRun += 1;
          await this._writeManifest(manifestPath, manifest);
          this.onProgress({
            state: "copying",
            completedFiles: manifest.files.filter((file) => file.copied).length,
            totalFiles: manifest.files.length,
          });
          if (Number.isSafeInteger(failAfterFiles) && copiedThisRun >= failAfterFiles) {
            throw new Error("migration interrupted");
          }
        }

        for (const entry of manifest.files) {
          if (!(await this._verifiedFile(this._inside(staging, entry.relative), entry))) {
            throw new Error("migration verification failed");
          }
        }
        manifest.phase = "verified";
        await this._writeManifest(manifestPath, manifest);
        await this.fs.rename(staging, target);
      } else {
        if (manifest.phase !== "verified" && manifest.phase !== "activated") {
          throw new Error("destination is unsafe");
        }
        for (const entry of manifest.files) {
          if (!(await this._verifiedFile(this._inside(target, entry.relative), entry))) {
            throw new Error("migration verification failed");
          }
        }
      }

      if (manifest.phase === "activated") {
        return {
          switched: true,
          canDeleteOldRoot: true,
          oldRoot: source,
          currentRoot: target,
          recoveryAction: "After verifying Jarvis data, delete the old data directory manually.",
        };
      }
      this._throwIfAborted(signal);
      this.onProgress({
        state: "activating",
        completedFiles: entries.length,
        totalFiles: entries.length,
      });
      await this.closeHolders();
      try {
        await this.persistRoot(target);
        await this.reopenHolders(target);
      } catch {
        try {
          await this.persistRoot(source);
          await this.reopenHolders(source);
        } catch {
          throw new Error(
            "migration rollback failed; restart Jarvis and select the previous data directory"
          );
        }
        throw new Error("migration activation failed; the previous data directory was restored");
      }
      manifest.phase = "activated";
      await this._writeManifest(manifestPath, manifest);
      this.onProgress({
        state: "complete",
        completedFiles: entries.length,
        totalFiles: entries.length,
      });
      return {
        switched: true,
        canDeleteOldRoot: true,
        oldRoot: source,
        currentRoot: target,
        recoveryAction: "After verifying Jarvis data, delete the old data directory manually.",
      };
    } finally {
      this.inProgress = false;
    }
  }

  _safeAbsolute(value, name) {
    if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
      throw new TypeError(`${name} must be an absolute path`);
    }
    return path.resolve(value);
  }

  async _validateRoots(source, target) {
    if (
      source === target ||
      target === path.parse(target).root ||
      isWithin(source, target) ||
      isWithin(target, source) ||
      (process.platform === "win32" && /^\\\\/.test(target))
    ) {
      throw new Error("destination is unsafe");
    }
    const sourceStat = await this.fs.lstat(source).catch(() => null);
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error("source is unsafe");
    }
    const targetStat = await this.fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isDirectory())) {
      throw new Error("destination is unsafe");
    }
    await this._assertSafeTargetAncestors(source, target);
    const inspected = await this.volumeInspector.inspect(target);
    if (!inspected || inspected.writable === false || inspected.kind !== "fixed") {
      throw new Error("destination is unsafe");
    }
  }

  async _scanSource(root, signal) {
    const files = [];
    const walk = async (directory, prefix = "") => {
      const children = await this.fs.readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        this._throwIfAborted(signal);
        const relative = path.join(prefix, child.name);
        if (prefix === "" && child.name === ".emergency-reserve") continue;
        const absolute = this._inside(root, relative);
        const stat = await this.fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error("source contains a link");
        if (stat.isDirectory()) await walk(absolute, relative);
        else if (stat.isFile()) {
          files.push({ relative, size: stat.size, sha256: await sha256(absolute, this.fs) });
        } else throw new Error("source contains an unsupported entry");
      }
    };
    await walk(root);
    return files;
  }

  _inside(root, relative) {
    if (typeof relative !== "string" || path.isAbsolute(relative)) {
      throw new Error("migration manifest is unsafe");
    }
    const resolved = path.resolve(root, relative);
    if (!isWithin(root, resolved) || resolved === root)
      throw new Error("migration manifest is unsafe");
    return resolved;
  }

  async _verifiedFile(filePath, expected) {
    const stat = await this.fs.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) return false;
    return (await sha256(filePath, this.fs)) === expected.sha256;
  }

  async _loadManifest(manifestPath) {
    try {
      const raw = await this.fs.readFile(manifestPath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("migration manifest is invalid");
    }
  }

  _validateManifest(manifest, source, target, entries) {
    if (
      manifest?.version !== MANIFEST_VERSION ||
      manifest.sourceId !== crypto.createHash("sha256").update(source).digest("hex") ||
      manifest.targetId !== crypto.createHash("sha256").update(target).digest("hex") ||
      !Array.isArray(manifest.files) ||
      !["copying", "verified", "activated"].includes(manifest.phase) ||
      manifest.files.length !== entries.length
    ) {
      throw new Error("migration manifest is invalid");
    }
    for (let index = 0; index < entries.length; index += 1) {
      const actual = manifest.files[index];
      const expected = entries[index];
      this._inside(source, actual?.relative);
      if (
        actual.relative !== expected.relative ||
        actual.size !== expected.size ||
        actual.sha256 !== expected.sha256 ||
        typeof actual.copied !== "boolean"
      ) {
        throw new Error("migration source changed; restart migration with a new destination");
      }
    }
  }

  async _assertSafeTargetAncestors(source, target) {
    let cursor = target;
    const missing = [];
    while (true) {
      const stat = await this.fs.lstat(cursor).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (stat) {
        if (stat.isSymbolicLink()) throw new Error("destination is unsafe");
        const real = await this.fs.realpath(cursor);
        const resolvedTarget = path.resolve(real, ...missing.reverse());
        const realSource = await this.fs.realpath(source);
        if (isWithin(realSource, resolvedTarget) || isWithin(resolvedTarget, realSource)) {
          throw new Error("destination is unsafe");
        }
        return;
      }
      missing.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("destination is unsafe");
      cursor = parent;
    }
  }

  async _writeManifest(manifestPath, manifest) {
    await this.fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const temporary = `${manifestPath}.tmp`;
    await this.fs.writeFile(temporary, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
    await this._fsyncFile(temporary);
    await this.fs.rename(temporary, manifestPath);
  }

  async _fsyncFile(filePath) {
    const handle = await this.fs.open(filePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async _exists(filePath) {
    try {
      await this.fs.lstat(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const error = new Error("migration interrupted");
      error.name = "AbortError";
      throw error;
    }
  }
}

DataDirectoryMigrator.DefaultVolumeInspector = DefaultVolumeInspector;

module.exports = DataDirectoryMigrator;
