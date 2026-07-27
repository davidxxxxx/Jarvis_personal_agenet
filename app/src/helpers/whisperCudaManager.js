const crypto = require("node:crypto");
const fs = require("node:fs");
const { promises: fsPromises } = fs;
const path = require("node:path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  extractArchive,
} = require("./downloadUtils");
const { processWriteGate } = require("../jarvis/main/UnifiedRootWriteGate");
const {
  WHISPER_CUDA_MANIFEST,
  APPROVED_WHISPER_CUDA_MANIFESTS,
  getWhisperCudaDownloadUrl,
} = require("../jarvis/main/WhisperCudaManifest");

const WINDOWS_BINARY = "whisper-server-win32-x64-cuda.exe";
const POINTER_FILE = "current.json";
const DECLINE_FILE = "first-run-declined.json";
const RECORD_FILE = "verification.json";
const INTEGRITY_MODE = "all-regular-files-v1";
const EXTRACTED_SIZE_LIMIT = 3_000_000_000;
const DISK_SAFETY_MARGIN = 1_000_000_000;
const TRANSIENT_VERIFICATION_REASONS = new Set([
  "cuda_launch_failed",
  "cuda_out_of_memory",
  "cuda_driver_failure",
  "verification_timeout",
]);

function cudaError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isSafeName(value) {
  return /^[A-Za-z0-9_.-]+$/.test(String(value || "")) && value !== "." && value !== "..";
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSafeArchivePath(entryPath) {
  if (typeof entryPath !== "string" || !entryPath || entryPath.includes("\0")) return false;
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

async function inspectZipArchive(archivePath) {
  const unzipper = require("unzipper");
  const directory = await unzipper.Open.file(archivePath);
  return directory.files.map((entry) => {
    const unixMode = Number(entry.vars?.externalFileAttributes || 0) >>> 16;
    const isUnixSymlink = (unixMode & 0o170000) === 0o120000;
    return {
      path: entry.path,
      type: isUnixSymlink ? "SymbolicLink" : entry.type,
      size: Number(entry.uncompressedSize || entry.vars?.uncompressedSize || 0),
    };
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function sha256FileSync(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

async function fsyncJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fsPromises.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsPromises.rename(tempPath, filePath);
  try {
    const directory = await fsPromises.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows does not consistently allow directory fsync. The file itself is already durable.
  }
}

class WhisperCudaManager {
  constructor({
    platform = process.platform,
    componentRoot = null,
    manifest = WHISPER_CUDA_MANIFEST,
    approvedManifests = null,
    downloadFile: downloadImpl = downloadFile,
    checkDiskSpace: diskSpaceImpl = checkDiskSpace,
    inspectArchive: inspectArchiveImpl = inspectZipArchive,
    extractArchive: extractImpl = extractArchive,
    verifyRuntime = null,
    sha256FileSync: sha256FileSyncImpl = sha256FileSync,
    now = Date.now,
    extractedSizeEstimate = null,
    diskSafetyMargin = DISK_SAFETY_MARGIN,
  } = {}) {
    this.platform = platform;
    this._configuredRoot = componentRoot;
    this._binDir = null;
    this.manifest = Object.freeze({ ...manifest });
    const approved =
      approvedManifests ||
      (manifest === WHISPER_CUDA_MANIFEST ? APPROVED_WHISPER_CUDA_MANIFESTS : [manifest]);
    this.approvedManifests = approved.map((entry) => Object.freeze({ ...entry }));
    this.downloadFileImpl = downloadImpl;
    this.checkDiskSpaceImpl = diskSpaceImpl;
    this.inspectArchiveImpl = inspectArchiveImpl;
    this.extractArchiveImpl = extractImpl;
    this.verifyRuntime = verifyRuntime;
    this.sha256FileSyncImpl = sha256FileSyncImpl;
    this.now = now;
    this.extractedSizeEstimate =
      extractedSizeEstimate == null ? this.manifest.size * 2 : extractedSizeEstimate;
    this.diskSafetyMargin = diskSafetyMargin;
    this._downloadSignal = null;
    this._downloading = false;
    this._activeDownload = null;
    this._quiesced = false;
    this._bootFailures = 0;
    this._lastIntegrityReason = null;
    this._pointerIntegrityCache = new Map();
  }

  isSupportedPlatform() {
    return this.platform === "win32";
  }

  getCudaBinaryDir() {
    if (!this._binDir) {
      if (this._configuredRoot) {
        this._binDir = path.resolve(this._configuredRoot);
      } else {
        const dataRoot = process.env.JARVIS_DATA_ROOT;
        this._binDir =
          dataRoot && path.isAbsolute(dataRoot)
            ? path.join(dataRoot, "components", "cuda")
            : path.join(app.getPath("userData"), "components", "cuda");
      }
      fs.mkdirSync(this._binDir, { recursive: true });
      const rootStat = fs.lstatSync(this._binDir);
      if (rootStat.isSymbolicLink())
        throw cudaError("CUDA_UNSAFE_COMPONENT_ROOT", "CUDA component root cannot be a link");
    }
    return this._binDir;
  }

  resetDataRoot() {
    this._binDir = null;
    this._configuredRoot = null;
    this._lastIntegrityReason = null;
    this._pointerIntegrityCache.clear();
  }

  _readPointer(pointerFile = POINTER_FILE) {
    let pointerPath = null;
    try {
      const root = this.getCudaBinaryDir();
      pointerPath = path.join(root, pointerFile);
      const pointerText = fs.readFileSync(pointerPath, "utf8");
      const pointerSignature = crypto.createHash("sha256").update(pointerText).digest("hex");
      const cached = this._pointerIntegrityCache.get(pointerPath);
      if (
        cached?.pointerSignature === pointerSignature &&
        cached.runtimeFingerprint === this._runtimeFingerprint(cached.value.runtimeDir)
      ) {
        this._lastIntegrityReason = null;
        return { ...cached.value };
      }

      const pointer = JSON.parse(pointerText);
      if (!isSafeName(pointer.version) || !/^[a-f0-9]{64}$/.test(pointer.sha256 || "")) return null;
      const approved = this.approvedManifests.some(
        (candidate) =>
          candidate.tag === pointer.version &&
          candidate.sha256 === pointer.sha256 &&
          candidate.asset === pointer.asset
      );
      if (!approved) return null;
      if (pointer.verification?.ok !== true || pointer.verification.backend !== "cuda") return null;
      if (
        typeof pointer.binary !== "string" ||
        !isSafeArchivePath(pointer.binary) ||
        path.basename(pointer.binary) !== WINDOWS_BINARY
      ) {
        return null;
      }
      if (typeof pointer.directory !== "string" || !isSafeArchivePath(pointer.directory))
        return null;
      const runtimeDir = path.join(root, pointer.directory);
      const binaryPath = path.join(runtimeDir, pointer.binary);
      if (!isWithin(root, runtimeDir) || !isWithin(runtimeDir, binaryPath)) return null;
      if (!fs.existsSync(binaryPath)) return null;
      const runtimeStat = fs.lstatSync(runtimeDir);
      const binaryStat = fs.lstatSync(binaryPath);
      if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || binaryStat.isSymbolicLink())
        return null;
      if (!this._validatePointerIntegrity(pointer, runtimeDir)) return null;
      const value = { ...pointer, runtimeDir, binaryPath };
      this._pointerIntegrityCache.set(pointerPath, {
        pointerSignature,
        runtimeFingerprint: this._runtimeFingerprint(runtimeDir),
        value,
      });
      this._lastIntegrityReason = null;
      return { ...value };
    } catch (error) {
      if (pointerPath) this._pointerIntegrityCache.delete(pointerPath);
      if (error?.code?.startsWith("CUDA_INTEGRITY")) this._lastIntegrityReason = error.code;
      return null;
    }
  }

  _runtimeFingerprint(runtimeDir) {
    return JSON.stringify(
      this._listRuntimeFiles(runtimeDir).map((relativePath) => {
        const stat = fs.lstatSync(path.join(runtimeDir, relativePath));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw cudaError("CUDA_INTEGRITY_FILE_SET_MISMATCH", "CUDA runtime file set changed");
        }
        return [relativePath, stat.size, stat.mtimeMs, stat.ctimeMs];
      })
    );
  }

  _validatePointerIntegrity(pointer, runtimeDir) {
    if (pointer.schemaVersion !== 2 || pointer.integrityMode !== INTEGRITY_MODE) {
      throw cudaError(
        "CUDA_INTEGRITY_METADATA_MISSING",
        "CUDA runtime complete-file integrity metadata is missing"
      );
    }
    if (!Array.isArray(pointer.files) || pointer.files.length < 3) {
      throw cudaError(
        "CUDA_INTEGRITY_METADATA_MISSING",
        "CUDA runtime integrity metadata is missing"
      );
    }
    const expectedPaths = new Set();
    for (const file of pointer.files) {
      if (!isSafeArchivePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) {
        throw cudaError(
          "CUDA_INTEGRITY_METADATA_INVALID",
          "CUDA runtime integrity metadata is invalid"
        );
      }
      const candidate = path.join(runtimeDir, file.path);
      if (!isWithin(runtimeDir, candidate))
        throw cudaError("CUDA_INTEGRITY_PATH", "CUDA integrity path escaped runtime");
      if (expectedPaths.has(file.path)) {
        throw cudaError("CUDA_INTEGRITY_METADATA_INVALID", "CUDA integrity path is duplicated");
      }
      expectedPaths.add(file.path);
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
        throw cudaError("CUDA_INTEGRITY_SIZE_MISMATCH", "CUDA runtime file size changed");
      }
    }
    const actualPaths = this._listRuntimeFiles(runtimeDir);
    if (
      actualPaths.length !== expectedPaths.size ||
      actualPaths.some((relativePath) => !expectedPaths.has(relativePath))
    ) {
      throw cudaError(
        "CUDA_INTEGRITY_FILE_SET_MISMATCH",
        "CUDA runtime file set does not match integrity metadata"
      );
    }
    for (const file of pointer.files) {
      const candidate = path.join(runtimeDir, file.path);
      const digest = this.sha256FileSyncImpl(candidate);
      if (digest !== file.sha256)
        throw cudaError("CUDA_INTEGRITY_HASH_MISMATCH", "CUDA runtime file hash changed");
    }
    return true;
  }

  _listRuntimeFiles(runtimeDir) {
    const files = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (!isWithin(runtimeDir, candidate)) {
          throw cudaError("CUDA_INTEGRITY_PATH", "CUDA runtime path escaped runtime");
        }
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) {
          throw cudaError("CUDA_INTEGRITY_LINK", "CUDA runtime contains a link");
        }
        if (stat.isDirectory()) walk(candidate);
        else if (stat.isFile()) {
          files.push(path.relative(runtimeDir, candidate).replaceAll("\\", "/"));
        }
      }
    };
    walk(runtimeDir);
    return files.sort();
  }

  getCudaBinaryPath() {
    if (!this.isSupportedPlatform()) return null;
    return this._readPointer()?.binaryPath || null;
  }

  isDownloaded() {
    return this._hasManagedArtifacts();
  }

  isVerified({ gpuUuid = process.env.TRANSCRIPTION_GPU_UUID || null } = {}) {
    const pointer = this._readPointer();
    if (!pointer || pointer.verification?.ok !== true || pointer.verification.backend !== "cuda")
      return false;
    if (gpuUuid && pointer.verification.gpuUuid !== gpuUuid) return false;
    return true;
  }

  getVerifiedStartOptions({
    enabled = process.env.WHISPER_CUDA_ENABLED === "true",
    gpuUuid = process.env.TRANSCRIPTION_GPU_UUID || null,
  } = {}) {
    if (!enabled) return { useCuda: false, gpuUuid: null };
    const pointer = this._readPointer();
    const verifiedGpuUuid = gpuUuid || pointer?.verification?.gpuUuid || null;
    if (!verifiedGpuUuid || !this.isVerified({ gpuUuid: verifiedGpuUuid })) {
      return { useCuda: false, gpuUuid: null };
    }
    return { useCuda: true, gpuUuid: verifiedGpuUuid };
  }

  getStatus({ gpuUuid = process.env.TRANSCRIPTION_GPU_UUID || null } = {}) {
    const pointer = this._readPointer();
    const currentIntegrityReason = this._lastIntegrityReason;
    const rollbackPointer = this._readPointer("previous.json");
    const record = this._readVerificationRecord();
    const present = this._hasManagedArtifacts();
    const recordMatchesPointer = Boolean(
      pointer &&
      record?.ok === true &&
      record.backend === "cuda" &&
      record.version === pointer.version &&
      record.digest === pointer.sha256 &&
      record.gpuUuid === pointer.verification?.gpuUuid
    );
    const peakVramMb =
      recordMatchesPointer && Number.isFinite(record?.peakVramMb) && record.peakVramMb > 0
        ? record.peakVramMb
        : null;
    return {
      downloaded: present,
      present,
      downloading: this.isDownloading(),
      verified: this.isVerified({ gpuUuid }),
      path: pointer?.binaryPath || null,
      version: pointer?.version || record?.version || null,
      reason:
        currentIntegrityReason ||
        pointer?.verification?.reason ||
        record?.reason ||
        (pointer ? "verification_required" : "not_installed"),
      verification: pointer?.verification ? { ...pointer.verification, peakVramMb } : null,
      declined: this.hasDeclinedFirstRun(),
      canRollback: !!rollbackPointer,
      actions: [
        "retry",
        ...(rollbackPointer ? ["rollback"] : []),
        ...(present || rollbackPointer ? ["remove"] : []),
      ],
    };
  }

  isDownloading() {
    return this._downloading;
  }

  getPinnedReleaseInfo() {
    if (!this.isSupportedPlatform())
      throw cudaError("CUDA_PLATFORM_UNSUPPORTED", `CUDA runtime not pinned for ${this.platform}`);
    return {
      url: getWhisperCudaDownloadUrl(this.manifest),
      size: this.manifest.size,
      version: this.manifest.tag,
      sha256: this.manifest.sha256,
    };
  }

  async fetchReleaseInfo() {
    return this.getPinnedReleaseInfo();
  }

  download(progressCallback, options = {}) {
    // Keep the legacy producer seam used by storage-migration coordination tests and
    // downstream embedders while routing the built-in producer to the pinned installer.
    if (Object.prototype.hasOwnProperty.call(this, "_download")) {
      if (this._quiesced) {
        return Promise.reject(
          cudaError("STORAGE_MIGRATION_IN_PROGRESS", "storage migration in progress")
        );
      }
      const operation = processWriteGate.runWithWriteLease("cuda-component-download", () =>
        this._download(progressCallback, options)
      );
      this._activeDownload = operation;
      operation
        .finally(() => {
          if (this._activeDownload === operation) this._activeDownload = null;
        })
        .catch(() => {});
      return operation;
    }
    return this.installPinnedCudaRuntime({
      consent: true,
      onProgress: progressCallback,
      ...options,
    });
  }

  installPinnedCudaRuntime(options = {}) {
    if (options.consent !== true) {
      if (options.recordDecline === true) this.recordFirstRunDecline();
      return Promise.resolve({
        success: false,
        code: "CONSENT_REQUIRED",
        requiredBytes: this.manifest.size,
      });
    }
    if (this._quiesced) {
      return Promise.reject(
        cudaError("STORAGE_MIGRATION_IN_PROGRESS", "storage migration in progress")
      );
    }
    if (this._activeDownload) return this._activeDownload;
    const operation = processWriteGate.runWithWriteLease("cuda-component-download", () =>
      this._installPinnedCudaRuntime(options)
    );
    this._activeDownload = operation;
    operation
      .finally(() => {
        if (this._activeDownload === operation) this._activeDownload = null;
      })
      .catch(() => {});
    return operation;
  }

  verifyInstalledCudaRuntime(verification = {}) {
    return processWriteGate.runWithWriteLease("cuda-component-verify", async () => {
      const pointer = this._readPointer();
      if (!pointer)
        throw cudaError(
          "CUDA_RUNTIME_NOT_INSTALLED",
          "No integrity-checked CUDA runtime is installed"
        );
      const verify = verification.verify || this.verifyRuntime;
      if (typeof verify !== "function")
        throw cudaError("CUDA_VERIFIER_REQUIRED", "CUDA verifier is required");
      const verifyResult = await verify({
        runtimeDir: pointer.runtimeDir,
        binaryPath: pointer.binaryPath,
        manifest: this.manifest,
        modelPath: verification.modelPath,
        fixturePath: verification.fixturePath,
        gpuUuid: verification.gpuUuid || process.env.TRANSCRIPTION_GPU_UUID || null,
        signal: verification.signal,
      });
      const verificationFailed = !verifyResult?.ok || verifyResult.backend !== "cuda";
      const transient =
        verificationFailed && TRANSIENT_VERIFICATION_REASONS.has(verifyResult?.reason);
      this._bootFailures = verificationFailed ? (transient ? this._bootFailures + 1 : 0) : 0;
      await this._recordVerification({
        version: this.manifest.tag,
        digest: this.manifest.sha256,
        result: verifyResult,
        verification,
      });
      if (verificationFailed) {
        if (transient && this._bootFailures >= 3) {
          await fsyncJsonAtomic(
            path.join(this.getCudaBinaryDir(), "previous.json"),
            this._serializablePointer(pointer)
          );
          await this._recordQuarantine(verifyResult.reason);
          await fsPromises.rename(
            path.join(this.getCudaBinaryDir(), POINTER_FILE),
            path.join(this.getCudaBinaryDir(), `quarantined-current-${this.now()}.json`)
          );
        }
        return (
          verifyResult || {
            ok: false,
            backend: "unknown",
            gpuUuid: null,
            reason: "verification_failed",
          }
        );
      }
      const boundedVerification = {
        ok: true,
        backend: "cuda",
        gpuUuid: verifyResult.gpuUuid || null,
        reason: verifyResult.reason || "verified",
        verifiedAt: new Date(this.now()).toISOString(),
      };
      await fsyncJsonAtomic(path.join(this.getCudaBinaryDir(), POINTER_FILE), {
        schemaVersion: pointer.schemaVersion,
        integrityMode: pointer.integrityMode,
        version: pointer.version,
        asset: pointer.asset,
        directory: pointer.directory,
        sha256: pointer.sha256,
        binary: pointer.binary,
        files: pointer.files,
        verification: boundedVerification,
      });
      this._bootFailures = 0;
      return boundedVerification;
    });
  }

  async _installPinnedCudaRuntime({ signal: externalSignal, onProgress, verification = {} } = {}) {
    if (this._downloading)
      throw cudaError("CUDA_INSTALL_IN_PROGRESS", "CUDA install already in progress");
    if (!this.isSupportedPlatform())
      throw cudaError("CUDA_PLATFORM_UNSUPPORTED", `CUDA runtime not pinned for ${this.platform}`);
    if (typeof (verification.verify || this.verifyRuntime) !== "function") {
      throw cudaError(
        "CUDA_VERIFIER_REQUIRED",
        "CUDA runtime verification is required before install"
      );
    }
    this._downloading = true;
    this.clearFirstRunDecline();
    const root = this.getCudaBinaryDir();
    const operationId = `${process.pid}-${this.now()}-${crypto.randomUUID()}`;
    const partialDir = path.join(root, `${this.manifest.tag}.partial-${operationId}`);
    const stagingDir = path.join(root, `${this.manifest.tag}.staging-${operationId}`);
    const archivePath = path.join(partialDir, this.manifest.asset);
    const versionsRoot = path.join(root, "versions");
    const versionName = `${this.manifest.tag}-${this.manifest.sha256.slice(0, 16)}`;
    const versionDir = path.join(versionsRoot, versionName);
    let promoted = false;
    let promotedDisposition = "failed";
    const localDownload = createDownloadSignal();
    this._downloadSignal = localDownload;
    const signal = localDownload.signal;
    const externalAbortListener = () => localDownload.abort();
    if (externalSignal?.addEventListener) {
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
    if (externalSignal?.aborted) localDownload.abort();
    try {
      const requiredBytes = this.manifest.size + this.extractedSizeEstimate + this.diskSafetyMargin;
      const space = await this.checkDiskSpaceImpl(root, requiredBytes);
      if (!space || space.ok !== true || !Number.isFinite(Number(space.availableBytes))) {
        throw cudaError(
          "CUDA_DISK_SPACE_UNKNOWN",
          "Unable to verify free disk space for CUDA runtime"
        );
      }
      if (Number(space.availableBytes) < requiredBytes) {
        throw cudaError("CUDA_DISK_SPACE_LOW", "Not enough disk space for CUDA runtime");
      }
      this._throwIfAborted(signal);
      await fsPromises.mkdir(partialDir, { recursive: false });
      await this.downloadFileImpl(getWhisperCudaDownloadUrl(this.manifest), archivePath, {
        timeout: 600_000,
        signal,
        expectedSize: this.manifest.size,
        onProgress: (downloaded, total) =>
          onProgress?.({
            type: "progress",
            downloaded_bytes: downloaded,
            total_bytes: total,
            percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
          }),
      });
      this._throwIfAborted(signal);
      const archiveStat = await fsPromises.stat(archivePath);
      if (archiveStat.size !== this.manifest.size) {
        throw cudaError("CUDA_ARCHIVE_SIZE_MISMATCH", "Pinned CUDA archive size mismatch");
      }
      const digest = await sha256File(archivePath);
      if (digest !== this.manifest.sha256) {
        throw cudaError("CUDA_ARCHIVE_HASH_MISMATCH", "Pinned CUDA archive SHA-256 mismatch");
      }
      const entries = await this.inspectArchiveImpl(archivePath);
      this._validateArchiveEntries(entries);
      await fsPromises.mkdir(stagingDir, { recursive: false });
      await this.extractArchiveImpl(archivePath, stagingDir);
      const structure = await this._validateExtractedRuntime(stagingDir);
      let binaryPath = path.join(versionDir, path.relative(stagingDir, structure.binaryPath));
      let pointerBinary = path.relative(stagingDir, structure.binaryPath).replaceAll("\\", "/");
      let pointerFiles = structure.criticalFiles.map((file) => ({
        path: path.relative(stagingDir, file.path).replaceAll("\\", "/"),
        size: file.size,
        sha256: file.sha256,
      }));
      this._throwIfAborted(signal);

      await fsPromises.mkdir(versionsRoot, { recursive: true });
      if (fs.existsSync(versionDir)) {
        const current = this._readPointer();
        const previous = this._readPointer("previous.json");
        if (
          current?.runtimeDir === versionDir &&
          current.sha256 === this.manifest.sha256 &&
          current.version === this.manifest.tag &&
          this.isVerified({ gpuUuid: verification.gpuUuid || null })
        ) {
          return {
            success: true,
            reused: true,
            path: current.binaryPath,
            verification: current.verification,
          };
        }
        if (current?.runtimeDir === versionDir) {
          throw cudaError(
            "CUDA_CURRENT_RUNTIME_UNVERIFIED",
            "Refusing to replace the current CUDA runtime"
          );
        }
        if (previous?.runtimeDir === versionDir) {
          binaryPath = previous.binaryPath;
          pointerBinary = previous.binary;
          pointerFiles = previous.files;
          await fsPromises.rm(stagingDir, { recursive: true, force: true });
        } else {
          const quarantine = path.join(root, `${versionName}.quarantine-${operationId}`);
          await fsPromises.rename(versionDir, quarantine);
          await fsPromises.rename(stagingDir, versionDir);
          promoted = true;
        }
      } else {
        await fsPromises.rename(stagingDir, versionDir);
        promoted = true;
      }
      const verify = verification.verify || this.verifyRuntime;
      const verifyResult = await verify({
        runtimeDir: versionDir,
        binaryPath,
        manifest: this.manifest,
        modelPath: verification.modelPath,
        fixturePath: verification.fixturePath,
        gpuUuid: verification.gpuUuid || process.env.TRANSCRIPTION_GPU_UUID || null,
        signal,
      });
      const verificationFailed = !verifyResult?.ok || verifyResult.backend !== "cuda";
      const transient =
        verificationFailed && TRANSIENT_VERIFICATION_REASONS.has(verifyResult?.reason);
      this._bootFailures = verificationFailed ? (transient ? this._bootFailures + 1 : 0) : 0;
      if (verificationFailed) {
        await this._recordVerification({
          version: this.manifest.tag,
          digest: this.manifest.sha256,
          result: verifyResult || {
            ok: false,
            backend: "unknown",
            gpuUuid: null,
            reason: "verification_failed",
          },
          verification,
        });
        promotedDisposition = transient && this._bootFailures < 3 ? "failed" : "quarantine";
        throw cudaError(
          "CUDA_VERIFICATION_FAILED",
          verifyResult?.reason || "CUDA verification failed"
        );
      }
      const boundedVerification = {
        ok: true,
        backend: "cuda",
        gpuUuid: verifyResult.gpuUuid || null,
        reason: verifyResult.reason || "verified",
        verifiedAt: new Date(this.now()).toISOString(),
      };
      await this._recordVerification({
        version: this.manifest.tag,
        asset: this.manifest.asset,
        digest: this.manifest.sha256,
        result: boundedVerification,
        verification,
      });
      const previous = this._readPointer();
      if (previous && previous.runtimeDir !== versionDir) {
        await fsyncJsonAtomic(
          path.join(root, "previous.json"),
          this._serializablePointer(previous)
        );
      }
      await fsyncJsonAtomic(path.join(root, POINTER_FILE), {
        schemaVersion: 2,
        integrityMode: INTEGRITY_MODE,
        version: this.manifest.tag,
        asset: this.manifest.asset,
        directory: path.relative(root, versionDir).replaceAll("\\", "/"),
        sha256: this.manifest.sha256,
        binary: pointerBinary,
        files: pointerFiles,
        verification: boundedVerification,
      });
      this._bootFailures = 0;
      onProgress?.({ type: "complete", percentage: 100 });
      debugLogger.info("Pinned CUDA runtime installed and verified", {
        version: this.manifest.tag,
        gpuUuid: boundedVerification.gpuUuid,
      });
      return { success: true, path: binaryPath, verification: boundedVerification };
    } catch (error) {
      if (
        new Set([
          "CUDA_ARCHIVE_SIZE_MISMATCH",
          "CUDA_ARCHIVE_HASH_MISMATCH",
          "CUDA_ARCHIVE_UNSAFE_PATH",
          "CUDA_ARCHIVE_LINK_REJECTED",
          "CUDA_ARCHIVE_EXPANDED_SIZE",
          "CUDA_BINARY_MISSING",
          "CUDA_COMPANION_LIBRARY_MISSING",
          "CUDA_EXTRACTED_LINK_REJECTED",
          "CUDA_EXTRACTION_ESCAPED",
        ]).has(error?.code)
      ) {
        await this._recordQuarantine(error.code);
      }
      if (error?.isAbort || signal?.aborted)
        throw cudaError("CUDA_INSTALL_CANCELLED", "CUDA install cancelled");
      throw error;
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
      externalSignal?.removeEventListener?.("abort", externalAbortListener);
      await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (promoted && this._readPointer()?.runtimeDir !== versionDir) {
        const failedDir = path.join(
          root,
          `${this.manifest.tag}.${promotedDisposition}-${operationId}`
        );
        await fsPromises.rename(versionDir, failedDir).catch(() => {});
      }
    }
  }

  _throwIfAborted(signal) {
    if (signal?.aborted)
      throw Object.assign(new Error("CUDA install cancelled"), { isAbort: true });
  }

  _serializablePointer(pointer) {
    return {
      schemaVersion: pointer.schemaVersion,
      integrityMode: pointer.integrityMode,
      version: pointer.version,
      asset: pointer.asset,
      directory: pointer.directory,
      sha256: pointer.sha256,
      binary: pointer.binary,
      files: pointer.files,
      verification: pointer.verification,
    };
  }

  _validateArchiveEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0)
      throw cudaError("CUDA_ARCHIVE_INVALID", "CUDA archive is empty");
    let total = 0;
    for (const entry of entries) {
      if (!isSafeArchivePath(entry.path))
        throw cudaError("CUDA_ARCHIVE_UNSAFE_PATH", "CUDA archive contains an unsafe path");
      if (String(entry.type).toLowerCase().includes("symbolic")) {
        throw cudaError("CUDA_ARCHIVE_LINK_REJECTED", "CUDA archive contains a symbolic link");
      }
      total += Number(entry.size || 0);
      if (!Number.isSafeInteger(total) || total > EXTRACTED_SIZE_LIMIT) {
        throw cudaError(
          "CUDA_ARCHIVE_EXPANDED_SIZE",
          "CUDA archive expands beyond the safety limit"
        );
      }
    }
  }

  async _validateExtractedRuntime(stagingDir) {
    let total = 0;
    let binaryPath = null;
    const libraries = [];
    const runtimeFiles = [];
    const walk = async (directory) => {
      for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (!isWithin(stagingDir, candidate))
          throw cudaError("CUDA_EXTRACTION_ESCAPED", "CUDA extraction escaped staging");
        const stat = await fsPromises.lstat(candidate);
        if (stat.isSymbolicLink())
          throw cudaError("CUDA_EXTRACTED_LINK_REJECTED", "CUDA runtime contains a link");
        if (stat.isDirectory()) await walk(candidate);
        else if (stat.isFile()) {
          runtimeFiles.push(candidate);
          total += stat.size;
          if (total > EXTRACTED_SIZE_LIMIT)
            throw cudaError("CUDA_ARCHIVE_EXPANDED_SIZE", "CUDA runtime exceeds the safety limit");
          if (entry.name === WINDOWS_BINARY) binaryPath = candidate;
          if (/\.dll$/i.test(entry.name)) libraries.push(entry.name);
        }
      }
    };
    await walk(stagingDir);
    if (!binaryPath)
      throw cudaError("CUDA_BINARY_MISSING", `CUDA runtime is missing ${WINDOWS_BINARY}`);
    const hasCublas = libraries.some((name) => /^cublas(?:lt)?64/i.test(name));
    const hasCudart = libraries.some((name) => /^cudart64/i.test(name));
    if (!hasCublas || !hasCudart) {
      throw cudaError(
        "CUDA_COMPANION_LIBRARY_MISSING",
        "CUDA runtime companion libraries are incomplete"
      );
    }
    const criticalFiles = [];
    for (const filePath of runtimeFiles.sort()) {
      const stat = await fsPromises.stat(filePath);
      criticalFiles.push({ path: filePath, size: stat.size, sha256: await sha256File(filePath) });
    }
    return { binaryPath, libraries, total, criticalFiles };
  }

  _findByBasename(root, basename) {
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.name === basename) return candidate;
      }
    }
    throw cudaError("CUDA_COMPANION_LIBRARY_MISSING", `Missing ${basename}`);
  }

  async _recordVerification({ version, digest, result, verification }) {
    const proofMetadata = verification.getMetadata?.() || null;
    const record = {
      schemaVersion: 1,
      version,
      digest,
      gpuUuid: result.gpuUuid || null,
      driver: verification.driver || null,
      modelId: verification.modelId || null,
      peakVramMb: Number(proofMetadata?.peakVramMb ?? verification.peakVramMb) || null,
      verifiedAt: new Date(this.now()).toISOString(),
      ok: result.ok === true,
      backend: result.backend || "unknown",
      reason: result.reason || "verification_failed",
      bootFailureCount: result.ok ? 0 : this._bootFailures,
    };
    await fsyncJsonAtomic(path.join(this.getCudaBinaryDir(), RECORD_FILE), record);
  }

  async _recordQuarantine(reason) {
    await fsyncJsonAtomic(path.join(this.getCudaBinaryDir(), "quarantine.json"), {
      schemaVersion: 1,
      version: this.manifest.tag,
      digest: this.manifest.sha256,
      quarantined: true,
      reason,
      quarantinedAt: new Date(this.now()).toISOString(),
    });
  }

  _readVerificationRecord() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.getCudaBinaryDir(), RECORD_FILE), "utf8"));
    } catch {
      return null;
    }
  }

  _hasManagedArtifacts() {
    const root = this.getCudaBinaryDir();
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      return entries.some((entry) => {
        if ([POINTER_FILE, "previous.json", RECORD_FILE, "quarantine.json"].includes(entry.name)) {
          return entry.isFile();
        }
        if (entry.name === "versions") return entry.isDirectory() && !entry.isSymbolicLink();
        return (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /\.(?:failed|quarantine)-/.test(entry.name)
        );
      });
    } catch {
      return false;
    }
  }

  _readPointerRaw(pointerFile) {
    try {
      const root = this.getCudaBinaryDir();
      const pointer = JSON.parse(fs.readFileSync(path.join(root, pointerFile), "utf8"));
      if (typeof pointer.directory !== "string" || !isSafeArchivePath(pointer.directory))
        return null;
      const runtimeDir = path.join(root, pointer.directory);
      return isWithin(root, runtimeDir) && runtimeDir !== root ? { pointer, runtimeDir } : null;
    } catch {
      return null;
    }
  }

  recordFirstRunDecline() {
    const root = this.getCudaBinaryDir();
    fs.writeFileSync(
      path.join(root, DECLINE_FILE),
      `${JSON.stringify({ declinedAt: new Date(this.now()).toISOString() })}\n`,
      { mode: 0o600 }
    );
  }

  clearFirstRunDecline() {
    try {
      fs.unlinkSync(path.join(this.getCudaBinaryDir(), DECLINE_FILE));
    } catch {}
  }

  hasDeclinedFirstRun() {
    return fs.existsSync(path.join(this.getCudaBinaryDir(), DECLINE_FILE));
  }

  async quiesce() {
    this._quiesced = true;
    const active = this._activeDownload;
    if (!active) return;
    await this.cancelDownload();
    await active.catch(() => {});
  }

  resume() {
    this._quiesced = false;
  }

  async cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      this._downloadSignal = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  delete() {
    return processWriteGate.runWithWriteLease("cuda-component-delete", () => this._delete());
  }

  rollback() {
    return processWriteGate.runWithWriteLease("cuda-component-rollback", async () => {
      const previous = this._readPointer("previous.json");
      if (!previous) return { success: false, error: "No verified CUDA rollback is available" };
      const current = this._readPointer();
      await fsyncJsonAtomic(
        path.join(this.getCudaBinaryDir(), POINTER_FILE),
        this._serializablePointer(previous)
      );
      if (current) {
        await fsyncJsonAtomic(
          path.join(this.getCudaBinaryDir(), "previous.json"),
          this._serializablePointer(current)
        );
      }
      return { success: true, path: this.getCudaBinaryPath() };
    });
  }

  async _delete() {
    const root = this.getCudaBinaryDir();
    const pointer = this._readPointer();
    const previous = this._readPointer("previous.json");
    const rawCurrent = this._readPointerRaw(POINTER_FILE);
    const rawPrevious = this._readPointerRaw("previous.json");
    const hadManagedArtifacts = this._hasManagedArtifacts();
    let freedBytes = 0;
    const managedPaths = new Set(
      [
        pointer?.runtimeDir,
        previous?.runtimeDir,
        rawCurrent?.runtimeDir,
        rawPrevious?.runtimeDir,
      ].filter(Boolean)
    );
    const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (
        entry.name === "versions" ||
        (entry.isDirectory() && /\.(?:failed|quarantine)-/.test(entry.name))
      ) {
        managedPaths.add(path.join(root, entry.name));
      }
    }
    for (const managedPath of managedPaths) {
      if (!isWithin(root, managedPath) || managedPath === root) continue;
      const stat = await fsPromises.lstat(managedPath).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      freedBytes += await this._sumRegularFileBytes(managedPath);
      await fsPromises.rm(managedPath, { recursive: true, force: true });
    }
    await fsPromises.unlink(path.join(root, POINTER_FILE)).catch(() => {});
    await fsPromises.unlink(path.join(root, "previous.json")).catch(() => {});
    await fsPromises.unlink(path.join(root, RECORD_FILE)).catch(() => {});
    await fsPromises.unlink(path.join(root, "quarantine.json")).catch(() => {});
    for (const entry of entries) {
      if (/^quarantined-current-\d+\.json$/.test(entry.name)) {
        await fsPromises.unlink(path.join(root, entry.name)).catch(() => {});
      }
    }
    return {
      success: hadManagedArtifacts,
      deleted_count:
        Number(!!pointer) + Number(!!previous && previous.runtimeDir !== pointer?.runtimeDir),
      freed_bytes: freedBytes,
      freed_mb: Math.round(freedBytes / (1024 * 1024)),
    };
  }

  async _sumRegularFileBytes(target) {
    const stat = await fsPromises.lstat(target).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    let total = 0;
    for (const entry of await fsPromises.readdir(target)) {
      total += await this._sumRegularFileBytes(path.join(target, entry));
    }
    return total;
  }
}

module.exports = WhisperCudaManager;
module.exports.inspectZipArchive = inspectZipArchive;
module.exports.isSafeArchivePath = isSafeArchivePath;
