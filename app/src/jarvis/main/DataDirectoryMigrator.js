const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const MigrationCoordinator = require("./MigrationCoordinator");
const { DirectoryLeaseProvider } = require("./DirectoryLease");
const { releaseReserve } = require("./SafeReserveFile");
const {
  DefaultPathInspector,
  DefaultVolumeInspector,
} = require("./StoragePathInspector");

const MANIFEST_VERSION = 3;
const OWNERSHIP_MARKER = ".jarvis-migration-owner";

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function sha256(filePath, fsImpl) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = await fsImpl.open(filePath, "r");
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

class DataDirectoryMigrator {
  constructor({
    fsImpl = fsp,
    volumeInspector = new DefaultVolumeInspector(),
    closeHolders = async () => {},
    persistRoot = async () => {},
    reopenHolders = async () => {},
    onProgress = () => {},
    migrationCoordinator = null,
    relocateTarget = async () => {},
    activationJournal = null,
    journalRoot = null,
    pathInspector = new DefaultPathInspector(),
    directoryIdentityProvider = null,
    directoryLeaseProvider = new DirectoryLeaseProvider({ fsImpl }),
    faultInjector = async () => {},
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
      relocateTarget,
    })) {
      if (typeof callback !== "function") throw new TypeError(`${name} must be a function`);
    }
    this.fs = fsImpl;
    this.volumeInspector = volumeInspector;
    this.closeHolders = closeHolders;
    this.persistRoot = persistRoot;
    this.reopenHolders = reopenHolders;
    this.onProgress = onProgress;
    this.relocateTarget = relocateTarget;
    if (
      activationJournal !== null &&
      (!activationJournal ||
        ["begin", "mark", "finalize", "rollback"].some(
          (method) => typeof activationJournal[method] !== "function"
        ))
    ) {
      throw new TypeError("activationJournal must provide begin, mark, finalize and rollback");
    }
    this.activationJournal =
      activationJournal ??
      Object.freeze({
        async begin() {},
        async mark() {},
        async finalize() {},
        async rollback() {},
      });
    if (journalRoot !== null && (typeof journalRoot !== "string" || !path.isAbsolute(journalRoot))) {
      throw new TypeError("journalRoot must be absolute");
    }
    if (!pathInspector || typeof pathInspector.inspect !== "function") {
      throw new TypeError("pathInspector.inspect is required");
    }
    this.journalRoot = path.resolve(
      journalRoot ?? path.join(os.tmpdir(), `jarvis-migration-journal-${crypto.randomUUID()}`)
    );
    this.pathInspector = pathInspector;
    if (directoryIdentityProvider !== null && typeof directoryIdentityProvider !== "function") {
      throw new TypeError("directoryIdentityProvider must be a function");
    }
    this.directoryIdentityProvider =
      directoryIdentityProvider ?? ((directory) => this._captureDirectoryIdentity(directory));
    if (!directoryLeaseProvider || typeof directoryLeaseProvider.acquire !== "function") {
      throw new TypeError("directoryLeaseProvider.acquire is required");
    }
    this.directoryLeaseProvider = directoryLeaseProvider;
    if (typeof faultInjector !== "function") throw new TypeError("faultInjector must be a function");
    this.faultInjector = faultInjector;
    if (
      migrationCoordinator !== null &&
      (!migrationCoordinator ||
        typeof migrationCoordinator.runExclusive !== "function" ||
        typeof migrationCoordinator.assertProducerAllowed !== "function")
    ) {
      throw new TypeError("migrationCoordinator must provide runExclusive and assertProducerAllowed");
    }
    this.migrationCoordinator =
      migrationCoordinator ??
      new MigrationCoordinator({
        providers: [
          {
            name: "legacy-storage-holders",
            quiesce: closeHolders,
            async close() {},
            reopen: reopenHolders,
            rollback: reopenHolders,
            async resume() {},
          },
        ],
      });
    this.inProgress = false;
  }

  async migrate({ from, to, signal, failAfterFiles, failAfterRelocation = false } = {}) {
    if (this.inProgress) throw new Error("migration already in progress");
    this.inProgress = true;
    try {
      const source = this._safeAbsolute(from, "source");
      const target = this._safeAbsolute(to, "destination");
      return await this.migrationCoordinator.runExclusive(async (lease) => {
      const targetVolume = await this._validateRoots(source, target);
      const sourceLease = await this.directoryLeaseProvider.acquire(source);
      let targetLease = null;
      let parentLease = null;
      try {
      await this._assertLeaseCurrent(sourceLease);
      await this._assertDirectoryIdentity(targetVolume.anchor);
      this._throwIfAborted(signal);

      const entries = await this._scanSource(source, signal);
      await this._ensureJournalRoot();
      const migrationKey = crypto
        .createHash("sha256")
        .update(`${source}\0${target}`)
        .digest("hex");
      const manifestPath = path.join(this.journalRoot, `${migrationKey}.json`);
      let manifest = await this._loadManifest(manifestPath);
      const pendingManifest =
        manifest ??
        {
          version: MANIFEST_VERSION,
          migrationId: `migration_${crypto.randomUUID().replaceAll("-", "")}`,
          token: crypto.randomBytes(32).toString("hex"),
          sourceIdentity: sourceLease.identity,
          targetIdentity: null,
          targetVolumeIdentity: targetVolume.identity ?? null,
          phase: "copying",
          files: entries.map((entry) => ({ ...entry, copied: false })),
        };
      const targetExists = await this._exists(target);
      let markedTargetIdentity = null;
      if (!targetExists) {
        parentLease = await this.directoryLeaseProvider.acquire(targetVolume.anchorPath);
        await this._assertLeaseCurrent(parentLease);
        await this._createMissingTarget(targetVolume.anchorPath, target);
      }
      if (manifest === null) {
        if (!(await this._isEmptyDirectory(target))) throw new Error("destination is unsafe");
        await this._ensureOwnershipMarker(target, pendingManifest, { allowCreate: true });
        markedTargetIdentity = await this.directoryIdentityProvider(target);
      }
      targetLease = await this.directoryLeaseProvider.acquire(target);
      await this._assertLeaseCurrent(targetLease);
      if (markedTargetIdentity !== null) {
        await this._assertDirectoryIdentity(markedTargetIdentity);
      }
      await this._assertSameVolume(target, targetVolume);
      if (manifest) {
        this._validateManifest(
          manifest,
          source,
          target,
          entries,
          targetVolume,
          sourceLease,
          targetLease
        );
      } else {
        manifest = {
          ...pendingManifest,
          targetIdentity: targetLease.identity,
        };
        await this._ensureOwnershipMarker(target, manifest);
        await this._writeManifest(manifestPath, manifest);
      }
      if (manifest.phase === "copying") {
        await this._ensureOwnershipMarker(target, manifest);
        await this._assertExactTree(
          target,
          manifest.files.filter((entry) => entry.copied),
          new Set([OWNERSHIP_MARKER])
        );
      } else {
        await this._removeOwnershipMarker(target, manifest, { required: false });
      }
      await parentLease?.release();
      parentLease = null;

      if (manifest.phase === "copying") {
        let copiedThisRun = 0;
        for (const entry of manifest.files) {
          this._throwIfAborted(signal);
          await this._assertLeaseCurrent(sourceLease);
          await this._assertLeaseCurrent(targetLease);
          const sourceFile = this._inside(source, entry.relative);
          const stagedFile = this._inside(target, entry.relative);
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

        this.onProgress({
          state: "verifying",
          completedFiles: 0,
          totalFiles: manifest.files.length,
        });
        for (const [index, entry] of manifest.files.entries()) {
          if (!(await this._verifiedFile(this._inside(target, entry.relative), entry))) {
            throw new Error("migration verification failed");
          }
          this.onProgress({
            state: "verifying",
            completedFiles: index + 1,
            totalFiles: manifest.files.length,
          });
        }
        manifest.phase = "verified";
        await this._writeManifest(manifestPath, manifest);
        await this.faultInjector("copy-verified-before-marker-release", {
          source,
          target,
          migrationId: manifest.migrationId,
          token: manifest.token,
        });
        await this._removeOwnershipMarker(target, manifest);
        await this._assertExactTree(target, manifest.files);
        await this._assertLeaseCurrent(targetLease);
        await this._assertDirectoryIdentity(targetVolume.anchor);
        await this._assertSameVolume(target, targetVolume);
      } else {
        if (!['verified', 'relocating', 'relocated', 'activated'].includes(manifest.phase)) {
          throw new Error("destination is unsafe");
        }
        if (manifest.phase === 'relocating') {
          await this._assertNoUnexpectedTree(target, manifest.files, manifest);
        } else {
          await this._assertExactTree(target, manifest.files);
          this.onProgress({
            state: "verifying",
            completedFiles: 0,
            totalFiles: manifest.files.length,
          });
          for (const [index, entry] of manifest.files.entries()) {
            const verified = ['relocated', 'activated'].includes(manifest.phase)
              ? await this._verifiedTargetFile(this._inside(target, entry.relative), entry)
              : await this._verifiedFile(this._inside(target, entry.relative), entry);
            if (!verified) throw new Error("migration verification failed");
            this.onProgress({
              state: "verifying",
              completedFiles: index + 1,
              totalFiles: manifest.files.length,
            });
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
      if (manifest.phase === "verified") {
        manifest.phase = "relocating";
        await this._writeManifest(manifestPath, manifest);
      }
      if (manifest.phase === "relocating") {
        await this._assertLeaseCurrent(sourceLease);
        await this._assertLeaseCurrent(targetLease);
        await this._restoreTargetFromSource(source, target, manifest);
        await this.relocateTarget({
          oldRoot: source,
          newRoot: target,
          migrationId: manifest.migrationId,
          token: manifest.token,
        });
        if (failAfterRelocation) throw new Error("migration interrupted");
        await this._recordTargetHashes(target, manifest.files);
        manifest.phase = "relocated";
        await this._writeManifest(manifestPath, manifest);
      }
      if (manifest.phase !== "relocated") throw new Error("migration manifest is invalid");
      await this._assertLeaseCurrent(sourceLease);
      await this._assertLeaseCurrent(targetLease);
      const activationProof = {
        previous: source,
        target,
        migrationId: manifest.migrationId,
        token: manifest.token,
        sourceIdentity: sourceLease.identity,
        targetIdentity: targetLease.identity,
        manifestPath,
        manifestSha256: await sha256(manifestPath, this.fs),
      };
      await this.activationJournal.begin({
        ...activationProof,
      });
      this._throwIfAborted(signal);
      this.onProgress({
        state: "activating",
        completedFiles: entries.length,
        totalFiles: entries.length,
      });
      await this.activationJournal.mark("activating");
      try {
        await this.persistRoot(target);
        await this.activationJournal.mark("persisted");
        await this.activationJournal.mark("reopening");
        await lease.reopen(target, source);
        await this._releaseEmergencyReserve(source);
        await this.activationJournal.finalize(target);
        lease.commit(target);
      } catch {
        try {
          this.onProgress({
            state: "rollback",
            completedFiles: 0,
            totalFiles: entries.length,
          });
          await this.activationJournal.mark("rollback");
          await this.persistRoot(source);
          await lease.rollback(source);
          await this._releaseEmergencyReserve(target);
          await this.activationJournal.rollback(source);
          this.onProgress({
            state: "rollback",
            completedFiles: entries.length,
            totalFiles: entries.length,
          });
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
        const releases = [parentLease, targetLease, sourceLease]
          .filter(Boolean)
          .map(async (heldLease) => heldLease.release());
        const results = await Promise.allSettled(releases);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          // A leaked authoritative handle is more dangerous than preserving a pending return.
          lease.failClosed();
          // eslint-disable-next-line no-unsafe-finally
          throw new AggregateError(
            failures.map((result) => result.reason),
            "directory lease release failed"
          );
        }
      }
      }, { previousRoot: source });
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

  async validateActivationTarget(candidate, state) {
    let sourceLease = null;
    let targetLease = null;
    try {
      const target = this._safeAbsolute(candidate, "activation target");
      if (!state || typeof state !== "object" || state.target !== target) return false;
      if (!["persisted", "reopening"].includes(state.phase)) return false;
      const source = this._safeAbsolute(state.previous, "activation source");
      sourceLease = await this.directoryLeaseProvider.acquire(source);
      targetLease = await this.directoryLeaseProvider.acquire(target);
      await this._assertLeaseCurrent(sourceLease);
      await this._assertLeaseCurrent(targetLease);
      if (
        sourceLease.identity !== state.sourceIdentity ||
        targetLease.identity !== state.targetIdentity
      ) {
        return false;
      }
      const manifestPath = this._safeAbsolute(state.manifestPath, "activation manifest");
      if (
        manifestPath === this.journalRoot ||
        !isWithin(this.journalRoot, manifestPath) ||
        !/^migration_[0-9a-f]{32}$/.test(state.migrationId) ||
        !/^[a-f0-9]{64}$/.test(state.token) ||
        !/^[a-f0-9]{64}$/.test(state.manifestSha256) ||
        (await sha256(manifestPath, this.fs)) !== state.manifestSha256
      ) {
        return false;
      }
      const expectedManifestName = `${crypto
        .createHash("sha256")
        .update(`${source}\0${target}`)
        .digest("hex")}.json`;
      if (path.basename(manifestPath) !== expectedManifestName) return false;
      const manifest = await this._loadManifest(manifestPath);
      if (
        manifest?.version !== MANIFEST_VERSION ||
        !["relocated", "activated"].includes(manifest.phase) ||
        manifest.migrationId !== state.migrationId ||
        manifest.token !== state.token ||
        manifest.sourceIdentity !== state.sourceIdentity ||
        manifest.targetIdentity !== state.targetIdentity ||
        !Array.isArray(manifest.files)
      ) {
        return false;
      }
      await this._assertSafeTargetAncestors(source, target);
      const targetVolume = await this.volumeInspector.inspect(target);
      if (!targetVolume || targetVolume.kind !== "fixed" || targetVolume.writable === false) {
        return false;
      }
      if (
        manifest.targetVolumeIdentity !== null &&
        targetVolume.identity !== manifest.targetVolumeIdentity
      ) {
        return false;
      }
      await this._assertExactTree(target, manifest.files);
      for (const entry of manifest.files) {
        if (!(await this._verifiedTargetFile(this._inside(target, entry.relative), entry))) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      await Promise.allSettled(
        [targetLease, sourceLease].filter(Boolean).map((lease) => lease.release())
      );
    }
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
    const anchorPath = await this._assertSafeTargetAncestors(source, target);
    const inspected = await this.volumeInspector.inspect(target);
    if (!inspected || inspected.writable === false || inspected.kind !== "fixed") {
      throw new Error("destination is unsafe");
    }
    return {
      ...inspected,
      anchorPath,
      anchor: await this.directoryIdentityProvider(anchorPath),
    };
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
        if (prefix === "" && ["jarvis.db-wal", "jarvis.db-shm"].includes(child.name)) {
          throw new Error("source contains active SQLite residue");
        }
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

  _validateManifest(
    manifest,
    source,
    target,
    entries,
    targetVolume,
    sourceLease,
    targetLease
  ) {
    if (
      manifest?.version !== MANIFEST_VERSION ||
      typeof manifest.migrationId !== "string" ||
      !/^migration_[0-9a-f]{32}$/.test(manifest.migrationId) ||
      typeof manifest.token !== "string" ||
      !/^[0-9a-f]{64}$/.test(manifest.token) ||
      manifest.sourceIdentity !== sourceLease.identity ||
      manifest.targetIdentity !== targetLease.identity ||
      manifest.targetVolumeIdentity !== (targetVolume.identity ?? null) ||
      !Array.isArray(manifest.files) ||
      !["copying", "verified", "relocating", "relocated", "activated"].includes(manifest.phase) ||
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
      if (
        ["relocated", "activated"].includes(manifest.phase) &&
        (!Number.isSafeInteger(actual.targetSize) ||
          actual.targetSize < 0 ||
          typeof actual.targetSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(actual.targetSha256))
      ) {
        throw new Error("migration manifest is invalid");
      }
    }
  }

  async _verifiedTargetFile(filePath, expected) {
    const stat = await this.fs.lstat(filePath).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== expected.targetSize
    ) {
      return false;
    }
    return (await sha256(filePath, this.fs)) === expected.targetSha256;
  }

  async _restoreTargetFromSource(source, target, manifest) {
    const files = manifest.files;
    await this._assertNoUnexpectedTree(target, files, manifest);
    for (const entry of files) {
      const sourceFile = this._inside(source, entry.relative);
      if (!(await this._verifiedFile(sourceFile, entry))) {
        throw new Error("migration source changed; restart migration with a new destination");
      }
      const targetFile = this._inside(target, entry.relative);
      await this.fs.mkdir(path.dirname(targetFile), { recursive: true });
      const temporary = `${targetFile}.${manifest.migrationId}.${manifest.token}.${crypto.randomUUID()}.restore`;
      try {
        await this.fs.copyFile(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
        await this._fsyncFile(temporary);
        await this.fs.rm(targetFile, { force: true });
        await this.fs.rename(temporary, targetFile);
        await this._fsyncDirectory(path.dirname(targetFile));
      } catch (error) {
        await this.fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
    await this._assertNoUnexpectedTree(target, files, manifest);
    for (const entry of files) {
      if (!(await this._verifiedFile(this._inside(target, entry.relative), entry))) {
        throw new Error("migration verification failed");
      }
    }
  }

  async _recordTargetHashes(target, files) {
    await this._assertExactTree(target, files);
    for (const entry of files) {
      const targetFile = this._inside(target, entry.relative);
      const stat = await this.fs.lstat(targetFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("migration verification failed");
      }
      entry.targetSize = stat.size;
      entry.targetSha256 = await sha256(targetFile, this.fs);
    }
  }

  async _assertSafeTargetAncestors(source, target) {
    let cursor = target;
    const missing = [];
    let anchor = null;
    while (true) {
      const stat = await this.fs.lstat(cursor).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (stat) {
        if (stat.isSymbolicLink()) throw new Error("destination is unsafe");
        const inspectedPath = await this.pathInspector.inspect(cursor, stat);
        if (inspectedPath?.reparse || inspectedPath?.mountPoint) {
          throw new Error("destination is unsafe");
        }
        if (anchor === null) {
          anchor = cursor;
          const real = await this.fs.realpath(cursor);
          const resolvedTarget = path.resolve(real, ...missing.reverse());
          const realSource = await this.fs.realpath(source);
          if (isWithin(realSource, resolvedTarget) || isWithin(resolvedTarget, realSource)) {
            throw new Error("destination is unsafe");
          }
        }
      } else if (anchor !== null) {
        throw new Error("destination is unsafe");
      } else {
        missing.push(path.basename(cursor));
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        if (anchor === null) throw new Error("destination is unsafe");
        return anchor;
      }
      cursor = parent;
    }
  }

  async _ensureJournalRoot() {
    await this.fs.mkdir(this.journalRoot, { recursive: true, mode: 0o700 });
    const stat = await this.fs.lstat(this.journalRoot);
    const inspected = await this.pathInspector.inspect(this.journalRoot, stat);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      inspected?.reparse ||
      inspected?.mountPoint
    ) {
      throw new Error("migration journal is unsafe");
    }
  }

  async _assertLeaseCurrent(lease) {
    if (!lease || typeof lease.identity !== "string" || lease.identity.length === 0) {
      throw new Error("directory lease identity unavailable");
    }
    if (typeof lease.assertCurrent === "function") await lease.assertCurrent();
    else if (typeof lease.assertActive === "function") lease.assertActive();
    else throw new Error("directory lease validation unavailable");
  }

  async _createMissingTarget(anchor, target) {
    const relative = path.relative(anchor, target);
    if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) {
      throw new Error("destination is unsafe");
    }
    let cursor = anchor;
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component);
      await this.fs.mkdir(cursor, { recursive: false, mode: 0o700 });
      const stat = await this.fs.lstat(cursor);
      const inspected = await this.pathInspector.inspect(cursor, stat);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        inspected?.reparse ||
        inspected?.mountPoint
      ) {
        throw new Error("destination is unsafe");
      }
    }
  }

  async _ensureOwnershipMarker(target, manifest, { allowCreate = false } = {}) {
    const markerPath = this._inside(target, OWNERSHIP_MARKER);
    const expected = `${manifest.migrationId}:${manifest.token}`;
    const existing = await this.fs.lstat(markerPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing === null) {
      if (
        !allowCreate ||
        manifest.files.some((entry) => entry.copied) ||
        (await this.fs.readdir(target)).length !== 0
      ) {
        throw new Error("migration ownership marker is invalid");
      }
      const handle = await this.fs.open(markerPath, "wx", 0o600);
      try {
        await handle.writeFile(expected, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this._fsyncDirectory(target);
      return;
    }
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error("migration ownership marker is invalid");
    }
    if ((await this.fs.readFile(markerPath, "utf8")) !== expected) {
      throw new Error("migration ownership marker is invalid");
    }
  }

  async _removeOwnershipMarker(target, manifest, { required = true } = {}) {
    const markerPath = this._inside(target, OWNERSHIP_MARKER);
    const expected = `${manifest.migrationId}:${manifest.token}`;
    const actual = await this.fs.readFile(markerPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT" && !required) return null;
      throw error;
    });
    if (actual === null) return false;
    if (actual !== expected) throw new Error("migration ownership marker is invalid");
    await this.fs.rm(markerPath, { force: false });
    await this._fsyncDirectory(target);
    return true;
  }

  async _captureDirectoryIdentity(directory) {
    const handle = await this.fs.open(directory, "r");
    try {
      const [handleStat, pathStat, finalPath, volume] = await Promise.all([
        handle.stat(),
        this.fs.lstat(directory),
        this.fs.realpath(directory),
        this.volumeInspector.inspect(directory),
      ]);
      if (
        !handleStat.isDirectory() ||
        !pathStat.isDirectory() ||
        pathStat.isSymbolicLink() ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino ||
        !volume ||
        volume.kind !== "fixed" ||
        volume.writable === false
      ) {
        throw new Error("directory identity unavailable");
      }
      if (this.volumeInspector.requiresStableIdentity && !volume.identity) {
        throw new Error("directory volume identity unavailable");
      }
      return Object.freeze({
        path: path.resolve(directory),
        dev: String(handleStat.dev),
        ino: String(handleStat.ino),
        finalPath: path.resolve(finalPath),
        volumeIdentity: volume.identity ?? null,
      });
    } finally {
      await handle.close();
    }
  }

  async _assertDirectoryIdentity(expected) {
    if (!expected) throw new Error("directory identity unavailable");
    const actual = await this.directoryIdentityProvider(expected.path);
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.finalPath !== expected.finalPath ||
      actual.volumeIdentity !== expected.volumeIdentity
    ) {
      throw new Error("destination directory identity changed");
    }
  }

  async _assertExactTree(root, expectedFiles, ignoredRootEntries = new Set()) {
    const expected = new Set(expectedFiles.map((entry) => path.normalize(entry.relative)));
    const actual = new Set();
    const walk = async (directory, prefix = "") => {
      const entries = await this.fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relative = path.join(prefix, entry.name);
        if (prefix === "" && ignoredRootEntries.has(entry.name)) continue;
        const absolute = this._inside(root, relative);
        const stat = await this.fs.lstat(absolute);
        const inspected = await this.pathInspector.inspect(absolute, stat);
        if (stat.isSymbolicLink() || inspected?.reparse || inspected?.mountPoint) {
          throw new Error("migration staging tree is invalid");
        }
        if (stat.isDirectory()) await walk(absolute, relative);
        else if (stat.isFile()) actual.add(path.normalize(relative));
        else throw new Error("migration staging tree is invalid");
      }
    };
    await walk(root);
    if (
      actual.size !== expected.size ||
      [...actual].some((relative) => !expected.has(relative))
    ) {
      throw new Error("migration staging tree is invalid");
    }
  }

  async _assertNoUnexpectedTree(root, expectedFiles, manifest = null) {
    const expected = new Map(
      expectedFiles.map((entry) => [path.normalize(entry.relative), entry])
    );
    const walk = async (directory, prefix = "") => {
      const entries = await this.fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relative = path.join(prefix, entry.name);
        const absolute = this._inside(root, relative);
        const stat = await this.fs.lstat(absolute);
        const inspected = await this.pathInspector.inspect(absolute, stat);
        if (stat.isSymbolicLink() || inspected?.reparse || inspected?.mountPoint) {
          throw new Error("migration staging tree is invalid");
        }
        if (stat.isDirectory()) {
          await walk(absolute, relative);
          continue;
        }
        if (!stat.isFile()) throw new Error("migration staging tree is invalid");
        const normalized = path.normalize(relative);
        if (expected.has(normalized)) continue;
        if (manifest) {
          const escapedMigrationId = manifest.migrationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const escapedToken = manifest.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const ownedTemporary = normalized.match(
            new RegExp(
              `^(.*)\\.${escapedMigrationId}\\.${escapedToken}\\.[0-9a-f-]{36}\\.(tmp|restore)$`,
              "i"
            )
          );
          if (ownedTemporary) {
            const original = expected.get(path.normalize(ownedTemporary[1]));
            const isSidecarTemporary =
              ownedTemporary[2].toLowerCase() === "tmp" &&
              path.normalize(ownedTemporary[1]).endsWith(".wav.recovery.json");
            const isRestoreTemporary = ownedTemporary[2].toLowerCase() === "restore";
            if (
              original &&
              (isSidecarTemporary || isRestoreTemporary) &&
              (stat.nlink === undefined || stat.nlink === 1) &&
              path.dirname(absolute) === path.dirname(this._inside(root, original.relative))
            ) {
              await this.fs.rm(absolute, { force: true });
              continue;
            }
          }
          const workDatabase = `.jarvis-relocate-${manifest.migrationId}-${manifest.token}.db`;
          const workKinds = new Map([
            [workDatabase, "db"],
            [`${workDatabase}-wal`, "wal"],
            [`${workDatabase}-shm`, "shm"],
          ]);
          const workKind = workKinds.get(normalized);
          if (
            workKind &&
            path.dirname(absolute) === path.resolve(root) &&
            (stat.nlink === undefined || stat.nlink === 1) &&
            (await this._validSqliteResidue(absolute, workKind))
          ) {
            continue;
          }
        }
        throw new Error("migration staging tree is invalid");
      }
    };
    await walk(root);
  }

  async _validSqliteResidue(filePath, kind) {
    const stat = await this.fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (kind === "shm") return stat.size >= 32 * 1024 && stat.size % (32 * 1024) === 0;
    if (kind === "db") {
      if (stat.size < 100) return false;
      const header = Buffer.alloc(16);
      const handle = await this.fs.open(filePath, "r");
      try {
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        return bytesRead === header.length && header.toString("binary") === "SQLite format 3\u0000";
      } finally {
        await handle.close();
      }
    }
    if (stat.size < 32) return false;
    const header = Buffer.alloc(32);
    const handle = await this.fs.open(filePath, "r");
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length) return false;
    } finally {
      await handle.close();
    }
    const magic = header.readUInt32BE(0);
    const pageSizeField = header.readUInt32BE(8);
    const pageSize = pageSizeField === 1 ? 65_536 : pageSizeField;
    return (
      [0x377f0682, 0x377f0683].includes(magic) &&
      pageSize >= 512 &&
      pageSize <= 65_536 &&
      (pageSize & (pageSize - 1)) === 0
    );
  }

  async _isEmptyDirectory(directory) {
    const stat = await this.fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("destination is unsafe");
    const inspected = await this.pathInspector.inspect(directory, stat);
    if (inspected?.reparse || inspected?.mountPoint) throw new Error("destination is unsafe");
    return (await this.fs.readdir(directory)).length === 0;
  }

  async _releaseEmergencyReserve(root) {
    const reservePath = path.join(root, ".emergency-reserve");
    const stat = await this.fs.lstat(reservePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return false;
    return releaseReserve({
      filePath: reservePath,
      sizeBytes: stat.size,
      fsImpl: this.fs,
      validate: async (_candidate, candidateStat) => {
        if (
          !candidateStat.isFile() ||
          candidateStat.isSymbolicLink() ||
          candidateStat.nlink !== 1 ||
          candidateStat.size !== stat.size
        ) {
          throw new Error("emergency reserve file is unsafe");
        }
      },
    });
  }

  async _assertSameVolume(candidate, expected) {
    const actual = await this.volumeInspector.inspect(candidate);
    if (!actual || actual.writable === false || actual.kind !== "fixed") {
      throw new Error("destination is unsafe");
    }
    if (expected?.identity && actual.identity !== expected.identity) {
      throw new Error("destination volume changed");
    }
  }

  async _writeManifest(manifestPath, manifest) {
    await this.fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    const handle = await this.fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(manifest), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.fs.rename(temporary, manifestPath);
      await this._fsyncDirectory(path.dirname(manifestPath));
    } catch (error) {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
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
DataDirectoryMigrator.DefaultPathInspector = DefaultPathInspector;

module.exports = DataDirectoryMigrator;
