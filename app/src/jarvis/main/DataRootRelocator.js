const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const JarvisRepository = require("./JarvisRepository");

const SIDECAR_SUFFIX = ".wav.recovery.json";
const MAX_SIDECAR_BYTES = 16 * 1024;

function relativeInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return relative;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

class DataRootRelocator {
  constructor({ fsImpl = fsp, Repository = JarvisRepository, faultInjector = async () => {} } = {}) {
    if (typeof faultInjector !== "function") throw new TypeError("faultInjector must be a function");
    this.fs = fsImpl;
    this.Repository = Repository;
    this.faultInjector = faultInjector;
  }

  async relocate({ oldRoot, newRoot, migrationId = null, token = null }) {
    if (
      typeof oldRoot !== "string" ||
      !path.isAbsolute(oldRoot) ||
      typeof newRoot !== "string" ||
      !path.isAbsolute(newRoot)
    ) {
      throw new TypeError("data roots must be absolute");
    }
    const sourceRoot = path.resolve(oldRoot);
    const targetRoot = path.resolve(newRoot);
    if (sourceRoot === targetRoot) throw new Error("data roots must differ");
    return this.relocateRecordings({
      databasePath: path.join(targetRoot, "jarvis.db"),
      oldRecordingsRoot: path.join(sourceRoot, "recordings"),
      newRecordingsRoot: path.join(targetRoot, "recordings"),
      migrationId,
      token,
    });
  }

  async relocateRecordings({
    databasePath,
    oldRecordingsRoot,
    newRecordingsRoot,
    migrationId = null,
    token = null,
  }) {
    for (const [name, value] of Object.entries({
      databasePath,
      oldRecordingsRoot,
      newRecordingsRoot,
    })) {
      if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new TypeError(`${name} must be absolute`);
      }
    }
    const sourceRecordings = path.resolve(oldRecordingsRoot);
    const targetRecordings = path.resolve(newRecordingsRoot);
    if (sourceRecordings === targetRecordings) {
      return { databaseLocators: 0, recoverySidecars: 0 };
    }
    const operationId =
      typeof migrationId === "string" && /^migration_[a-f0-9]{32}$/.test(migrationId)
        ? migrationId
        : `adoption_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationToken =
      typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
        ? token
        : crypto.randomBytes(32).toString("hex");
    const recoverySidecars = await this._rewriteRecoverySidecars({
      sourceRecordings,
      targetRecordings,
      migrationId: operationId,
      token: operationToken,
    });

    const formalDatabasePath = path.resolve(databasePath);
    const workDatabasePath = path.join(
      path.dirname(formalDatabasePath),
      `.jarvis-relocate-${operationId}-${operationToken}.db`
    );
    await this._prepareWorkDatabase(formalDatabasePath, workDatabasePath);
    const repository = new this.Repository(workDatabasePath);
    let databaseLocators;
    try {
      const result = repository.relocateDataRoot({
        fromRecordingsRoot: sourceRecordings,
        toRecordingsRoot: targetRecordings,
      });
      databaseLocators = result.relocated;
      await this.faultInjector("sqlite-relocation-wal-open", {
        databasePath: formalDatabasePath,
        workDatabasePath,
        migrationId: operationId,
        token: operationToken,
      });
      repository.checkpointForMigration();
    } finally {
      repository.close();
    }
    if (databaseLocators === 0) {
      await this._removeWorkDatabase(workDatabasePath);
      return { databaseLocators, recoverySidecars };
    }
    await this._verifySqliteDatabase(workDatabasePath);
    await this._fsyncFile(workDatabasePath);
    await this.fs.rename(workDatabasePath, formalDatabasePath);
    await this._fsyncDirectory(path.dirname(formalDatabasePath));
    return { databaseLocators, recoverySidecars };
  }

  async _removeWorkDatabase(workDatabasePath) {
    for (const candidate of [
      `${workDatabasePath}-shm`,
      `${workDatabasePath}-wal`,
      workDatabasePath,
    ]) {
      await this.fs.rm(candidate, { force: true });
    }
    await this._fsyncDirectory(path.dirname(workDatabasePath));
  }

  async _prepareWorkDatabase(formalDatabasePath, workDatabasePath) {
    const existing = await this.fs.lstat(workDatabasePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
        throw new Error("SQLite relocation work database is unsafe");
      }
      return;
    }
    await this.fs.copyFile(formalDatabasePath, workDatabasePath, fs.constants.COPYFILE_EXCL);
    await this._fsyncFile(workDatabasePath);
    await this._fsyncDirectory(path.dirname(workDatabasePath));
  }

  async _verifySqliteDatabase(databasePath) {
    const stat = await this.fs.lstat(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 100) {
      throw new Error("SQLite relocation work database is invalid");
    }
    const header = Buffer.alloc(16);
    const handle = await this.fs.open(databasePath, "r");
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.toString("binary") !== "SQLite format 3\u0000") {
        throw new Error("SQLite relocation work database is invalid");
      }
    } finally {
      await handle.close();
    }
    const verifier = new this.Repository(databasePath);
    try {
      verifier.checkpointForMigration();
    } finally {
      verifier.close();
    }
  }

  async _rewriteRecoverySidecars({ sourceRecordings, targetRecordings, migrationId, token }) {
    const targetStat = await this.fs.lstat(targetRecordings).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (targetStat === null) return 0;
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error("migrated recordings root is unsafe");
    }
    let rewritten = 0;
    const walk = async (directory) => {
      const entries = await this.fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const stat = await this.fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error("migrated recordings contain a link");
        if (stat.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!stat.isFile()) throw new Error("migrated recordings contain an unsupported entry");
        if (!entry.name.endsWith(SIDECAR_SUFFIX)) continue;
        if (stat.size <= 0 || stat.size > MAX_SIDECAR_BYTES) {
          throw new Error("migrated recovery sidecar is invalid");
        }
        const metadata = JSON.parse(await this.fs.readFile(absolute, "utf8"));
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new Error("migrated recovery sidecar is invalid");
        }
        const mappedPath = this._mapLocator(
          metadata.path,
          sourceRecordings,
          targetRecordings
        );
        const expectedWav = absolute.slice(0, -".recovery.json".length);
        if (path.resolve(mappedPath) !== path.resolve(expectedWav)) {
          throw new Error("migrated recovery sidecar path is invalid");
        }
        const wavStat = await this.fs.lstat(expectedWav);
        if (!wavStat.isFile() || wavStat.isSymbolicLink()) {
          throw new Error("migrated recovery WAV is unsafe");
        }
        if (path.resolve(metadata.path) !== path.resolve(mappedPath)) {
          await this._writeVerifiedJson(
            absolute,
            { ...metadata, path: mappedPath },
            { migrationId, token }
          );
          rewritten += 1;
        }
      }
    };
    await walk(targetRecordings);
    return rewritten;
  }

  _mapLocator(locator, sourceRoot, targetRoot) {
    if (typeof locator !== "string" || !path.isAbsolute(locator)) {
      throw new Error("migrated recovery sidecar path is invalid");
    }
    const canonical = path.resolve(locator);
    if (relativeInside(targetRoot, canonical) !== null) return canonical;
    const relative = relativeInside(sourceRoot, canonical);
    if (relative === null) throw new Error("migrated recovery sidecar path is invalid");
    return path.resolve(targetRoot, relative);
  }

  async _writeVerifiedJson(filePath, value, { migrationId, token }) {
    const bytes = Buffer.from(JSON.stringify(value));
    const expectedHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const temporary = `${filePath}.${migrationId}.${token}.${crypto.randomUUID()}.tmp`;
    const handle = await this.fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.faultInjector("sidecar-temp-fsynced", {
      filePath,
      temporary,
      migrationId,
      token,
    });
    await this.fs.rename(temporary, filePath);
    await this._fsyncDirectory(path.dirname(filePath));
    if ((await hashFile(filePath)) !== expectedHash) {
      throw new Error("migrated recovery sidecar verification failed");
    }
  }

  async _fsyncDirectory(directory) {
    let handle;
    try {
      handle = await this.fs.open(directory, "r");
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  async _fsyncFile(filePath) {
    const handle = await this.fs.open(filePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

module.exports = DataRootRelocator;
