const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getFFmpegPath } = require("../../helpers/ffmpegUtils");
const { isTransientIoError } = require("./AudioEvidenceErrors");

class FfmpegFlacEncoder {
  constructor({ spawnImpl = spawn, getPath = getFFmpegPath } = {}) {
    this.spawn = spawnImpl;
    this.getPath = getPath;
  }

  encode(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = this.getPath();
      if (!ffmpegPath) {
        reject(new Error("FFmpeg not found - required for FLAC evidence compression"));
        return;
      }
      const child = this.spawn(
        ffmpegPath,
        [
          "-v",
          "error",
          "-i",
          inputPath,
          "-map",
          "0:a:0",
          "-c:a",
          "flac",
          "-compression_level",
          "8",
          "-f",
          "flac",
          "-y",
          outputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
      );
      let stderr = "";
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      child.stderr.on("data", (data) => {
        stderr = `${stderr}${data}`.slice(-4_096);
      });
      child.on("error", (error) =>
        settle(reject, new Error(`FFmpeg process error: ${error.message}`))
      );
      child.on("close", (code) => {
        if (code === 0) settle(resolve);
        else
          settle(
            reject,
            new Error(`FFmpeg FLAC encode exited with code ${code}: ${stderr.trim()}`)
          );
      });
    });
  }
}

class FlacCompressionWorker {
  constructor({
    store,
    recordingsRoot,
    encoder = new FfmpegFlacEncoder(),
    reader,
    fsImpl = fs.promises,
    now = Date.now,
    faultInjector = () => {},
    onRecoveryError = () => {},
  }) {
    if (!store || typeof store.getChunk !== "function") {
      throw new TypeError("store.getChunk must be a function");
    }
    if (typeof store.promoteChunkToFlac !== "function") {
      throw new TypeError("store.promoteChunkToFlac must be a function");
    }
    if (typeof recordingsRoot !== "string" || !path.isAbsolute(recordingsRoot)) {
      throw new TypeError("recordingsRoot must be an absolute path");
    }
    if (!encoder || typeof encoder.encode !== "function") {
      throw new TypeError("encoder.encode must be a function");
    }
    if (!reader || typeof reader.readVerifiedPcm !== "function") {
      throw new TypeError("reader.readVerifiedPcm must be a function");
    }
    this.store = store;
    this.getMaintenanceChunk =
      typeof store.getChunkForMaintenance === "function"
        ? store.getChunkForMaintenance.bind(store)
        : store.getChunk.bind(store);
    this.recordingsRoot = path.resolve(recordingsRoot);
    this.encoder = encoder;
    this.reader = reader;
    this.fs = fsImpl;
    this.now = now;
    this.faultInjector = faultInjector;
    if (typeof onRecoveryError !== "function") {
      throw new TypeError("onRecoveryError must be a function");
    }
    this.onRecoveryError = onRecoveryError;
    this.fixedRoot = null;
    this.operationTail = Promise.resolve();
  }

  _enqueueOperation(operation) {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  waitForIdle() {
    return this.operationTail;
  }

  shutdown() {
    return this.waitForIdle();
  }

  run(job, leaseContext) {
    return this._enqueueOperation(() => this._run(job, leaseContext));
  }

  async _run(job, leaseContext) {
    if (leaseContext === null || leaseContext === undefined) {
      throw this._leaseLostError();
    }
    if (
      typeof leaseContext !== "object" ||
      typeof leaseContext.owner !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(leaseContext.owner)
    ) {
      throw new TypeError("compression lease owner must be a safe identifier");
    }
    if (typeof this.store.getCompressionJob !== "function") {
      throw new TypeError("store.getCompressionJob must be a function");
    }
    if (typeof this.store.promoteLeasedChunkToFlac !== "function") {
      throw new TypeError("store.promoteLeasedChunkToFlac must be a function");
    }
    const requestedJob = this._job(job);
    const persistedJob = this.store.getCompressionJob(requestedJob.id);
    if (
      !persistedJob ||
      persistedJob.state !== "running" ||
      persistedJob.lease_owner !== leaseContext.owner ||
      !Number.isSafeInteger(persistedJob.lease_expires_at) ||
      persistedJob.lease_expires_at <= this.now()
    ) {
      throw this._leaseLostError();
    }
    const normalizedJob = this._job(persistedJob);
    const chunk = this.getMaintenanceChunk(normalizedJob.chunkId);
    if (!chunk) throw new Error(`chunk ${normalizedJob.chunkId} does not exist`);
    if (chunk.deleted_at !== null) throw new Error("audio_deleted");
    if (chunk.expires_at <= this.now()) throw new Error("audio_expired");
    if (chunk.pcm_sha256 !== normalizedJob.inputHash) throw new Error("pcm_hash_mismatch");
    if (chunk.format === "flac") {
      return this._replayPromotedFlac(chunk);
    }
    if (chunk.format !== "wav") throw new Error("chunk_not_authoritative_wav");

    await this._cleanupRetiredArtifact(chunk.id);

    const wavPath = this._contained(chunk.path);
    const parsed = path.parse(wavPath);
    const flacPath = this._contained(path.join(parsed.dir, `${parsed.name}.flac`));
    const partialPath = `${flacPath}.partial`;
    await this._assertSafeExistingFile(wavPath);
    await this._assertSafeTarget(partialPath);
    if (await this._exists(partialPath)) throw new Error("compression_partial_already_exists");
    if (await this._exists(flacPath)) throw new Error("compression_final_already_exists");
    const sourcePcm = await this.reader.readVerifiedPcm(chunk);
    this._assertMetadata(sourcePcm, chunk);

    let renamedFinal = false;
    let promotedAuthority = false;
    let fileSha256 = null;
    try {
      await this.encoder.encode(wavPath, partialPath);
      await this._assertSafeExistingFile(partialPath);
      const partialHandle = await this.fs.open(partialPath, "r+");
      try {
        await partialHandle.sync();
      } finally {
        await partialHandle.close();
      }
      const encodedPcm = await this.reader.readVerifiedPcm({
        ...chunk,
        path: partialPath,
        format: "flac",
      });
      this._assertMetadata(encodedPcm, chunk);
      if (Math.abs(encodedPcm.sampleCount - sourcePcm.sampleCount) > 1) {
        throw new Error("duration_mismatch");
      }
      const encodedBytes = await this.fs.readFile(partialPath);
      fileSha256 = crypto.createHash("sha256").update(encodedBytes).digest("hex");
      await this._injectFault("before_rename");
      await this.fs.rename(partialPath, flacPath);
      renamedFinal = true;
      await this._injectFault("after_rename");
      await this._assertSafeExistingFile(flacPath);
      const promotedBytes = await this.fs.readFile(flacPath);
      if (crypto.createHash("sha256").update(promotedBytes).digest("hex") !== fileSha256) {
        throw new Error("audio evidence file hash changed before promotion");
      }
      const completedAt = this.now();
      const promotion = {
        chunkId: chunk.id,
        jobId: normalizedJob.id,
        encoderVersion: normalizedJob.encoderVersion,
        pcmSha256: chunk.pcm_sha256,
        wavPath,
        flacPath,
        fileSha256,
        fileBytes: promotedBytes.length,
        sampleRate: chunk.sample_rate,
        channels: chunk.channels,
        completedAt,
      };
      const promoted = this.store.promoteLeasedChunkToFlac({
        ...promotion,
        owner: leaseContext.owner,
      });
      if (!promoted) {
        throw this._leaseLostError();
      }
      promotedAuthority = true;
      await this._injectFault("before_wav_delete");
      await this._assertSafeExistingFile(wavPath);
      await this.fs.unlink(wavPath);
      return { chunk: promoted, replayed: false };
    } catch (error) {
      if (!error.flacCrashPoint) {
        try {
          await this._safeUnlink(partialPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
        if (renamedFinal && !promotedAuthority) {
          await this._removeUnownedFinal(chunk.id, flacPath, fileSha256);
        }
      }
      throw error;
    }
  }

  _leaseLostError() {
    const error = new Error("compression job lease was lost before FLAC promotion");
    error.code = "JOB_LEASE_LOST";
    return error;
  }

  async _replayPromotedFlac(chunk) {
    const flacPath = this._contained(chunk.path);
    await this._assertSafeExistingFile(flacPath);
    const flacBytes = await this.fs.readFile(flacPath);
    const fileSha256 = crypto.createHash("sha256").update(flacBytes).digest("hex");
    if (!chunk.file_sha256 || fileSha256 !== chunk.file_sha256) {
      throw new Error("file_hash_mismatch");
    }
    const authoritativePcm = await this.reader.readVerifiedPcm(chunk);
    this._assertMetadata(authoritativePcm, chunk);

    const parsed = path.parse(flacPath);
    const wavPath = this._contained(path.join(parsed.dir, `${parsed.name}.wav`));
    if (await this._exists(wavPath)) {
      const wavPcm = await this.reader.readVerifiedPcm({ ...chunk, path: wavPath, format: "wav" });
      this._assertMetadata(wavPcm, chunk);
      if (Math.abs(wavPcm.sampleCount - authoritativePcm.sampleCount) > 1) {
        throw new Error("duration_mismatch");
      }
      await this._safeUnlink(wavPath);
    }
    return { chunk: this.store.getChunk(chunk.id) ?? chunk, replayed: true };
  }

  async _injectFault(point) {
    try {
      await this.faultInjector(point);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.flacCrashPoint = point;
      throw error;
    }
  }

  runPending() {
    const error = new Error("ordinary compression requires the governed processing runtime");
    error.code = "GOVERNED_RUNTIME_REQUIRED";
    return Promise.reject(error);
  }

  recoverStartup() {
    return this._enqueueOperation(() => this._recoverStartup());
  }

  async _requiresDeepStartupRecovery(chunk, job) {
    if (chunk.retired_path) return true;
    if (job.state === "running") return true;
    if (
      ["flac_authority_temporarily_unreadable", "flac_authority_invalid_recovered"].includes(
        job.error_code
      )
    ) {
      return true;
    }

    const authorityPath = this._contained(chunk.path);
    const parsed = path.parse(authorityPath);
    const wavPath = this._contained(path.join(parsed.dir, `${parsed.name}.wav`));
    const flacPath = this._contained(path.join(parsed.dir, `${parsed.name}.flac`));
    const crashArtifacts =
      chunk.format === "wav"
        ? [flacPath, `${flacPath}.partial`, `${flacPath}.tmp`]
        : [wavPath, `${flacPath}.partial`, `${flacPath}.tmp`];
    for (const candidate of crashArtifacts) {
      if (await this._exists(candidate)) return true;
    }
    return false;
  }

  async _recoverStartup() {
    if (typeof this.store.listCompressionRecoveryCandidates !== "function") {
      throw new TypeError("store.listCompressionRecoveryCandidates must be a function");
    }
    const result = { promoted: 0, deletedWavs: 0, removedInvalid: 0, rolledBack: 0 };
    for (const candidate of this.store.listCompressionRecoveryCandidates()) {
      const { chunk, job } = candidate;
      if (!job) continue;
      try {
        await this._cleanupRetiredArtifact(chunk.id);
        if (chunk.deleted_at !== null || chunk.expires_at <= this.now()) {
          result.removedInvalid += await this._cleanupRetiredChunk(chunk, this.now());
          continue;
        }
        if (!(await this._requiresDeepStartupRecovery(chunk, job))) {
          continue;
        }
        if (chunk.format === "wav") {
          await this._recoverWav(chunk, this._job(job), result);
        } else if (chunk.format === "flac") {
          await this._recoverFlac(chunk, this._job(job), result);
        }
      } catch {
        try {
          this.onRecoveryError({
            chunkId: chunk.id,
            jobId: job.id,
            code: "flac_recovery_failed",
          });
        } catch {
          // Recovery telemetry must not block independent authoritative rows.
        }
      }
    }
    return result;
  }

  runMaintenance(at = this.now()) {
    return this._enqueueOperation(() => this._runMaintenance(at));
  }

  async _runMaintenance(at = this.now()) {
    const recovery = { promoted: 0, deletedWavs: 0, removedInvalid: 0, rolledBack: 0 };
    let retry = 0;
    if (typeof this.store.listCompressionRecoveryCandidates === "function") {
      for (const candidate of this.store.listCompressionRecoveryCandidates()) {
        const { chunk, job } = candidate;
        if (
          !job ||
          job.error_code !== "flac_authority_temporarily_unreadable" ||
          chunk.deleted_at !== null ||
          chunk.expires_at <= at ||
          chunk.format !== "flac"
        ) {
          continue;
        }
        try {
          await this._recoverFlac(chunk, this._job(job), recovery);
          if (this.store.getCompressionJob?.(job.id)?.state === "retry") retry += 1;
        } catch {
          retry += 1;
          try {
            this.onRecoveryError({
              chunkId: chunk.id,
              jobId: job.id,
              code: "flac_recovery_failed",
            });
          } catch {
            // Maintenance telemetry must not block independent rows.
          }
        }
      }
    }
    const retired = await this._cleanupRetiredBacklog();
    return { removed: retired.removed, retry: retired.retry + retry };
  }

  cleanupRetiredBacklog() {
    return this._enqueueOperation(() => this._cleanupRetiredBacklog());
  }

  async _cleanupRetiredBacklog() {
    if (typeof this.store.listRetiredArtifactBacklog !== "function") {
      return { removed: 0, retry: 0 };
    }
    let removed = 0;
    let retry = 0;
    for (const chunk of this.store.listRetiredArtifactBacklog()) {
      try {
        removed += await this._cleanupRetiredArtifact(chunk.id);
      } catch {
        retry += 1;
        try {
          this.onRecoveryError({
            chunkId: chunk.id,
            jobId: null,
            code: "retired_artifact_cleanup_failed",
          });
        } catch {
          // Maintenance telemetry must not block independent rows.
        }
      }
    }
    return { removed, retry };
  }

  cleanupRetiredChunk(chunk, at = this.now()) {
    return this._enqueueOperation(() => this._cleanupRetiredChunk(chunk, at));
  }

  async _cleanupRetiredChunk(chunk, at = this.now()) {
    if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
    await this._validatedRoot();
    const current = this.getMaintenanceChunk(chunk.id);
    if (!current) return 0;
    if (current.deleted_at === null && current.expires_at > at) return 0;
    let removed = await this._cleanupRetiredArtifact(current.id);
    const authorityPath =
      current.deleted_at === null
        ? current.path
        : (current.retired_path ?? chunk.retired_path ?? chunk.path);
    if (typeof authorityPath !== "string" || !path.isAbsolute(authorityPath)) return 0;
    const parsed = path.parse(this._contained(authorityPath));
    const wavPath = this._contained(path.join(parsed.dir, `${parsed.name}.wav`));
    const flacPath = this._contained(path.join(parsed.dir, `${parsed.name}.flac`));
    for (const candidate of [`${flacPath}.partial`, `${flacPath}.tmp`]) {
      if (await this._exists(candidate)) {
        await this._safeUnlink(candidate);
        removed += 1;
      }
    }
    const retiredFormat = current.retired_format ?? current.format;
    if (retiredFormat === "wav" && (await this._exists(flacPath))) {
      try {
        const encodedPcm = await this.reader.readVerifiedPcm({
          ...current,
          path: flacPath,
          format: "flac",
        });
        this._assertMetadata(encodedPcm, current);
        await this._safeUnlink(flacPath);
        removed += 1;
      } catch {
        // Preserve an artifact that cannot be proven to belong to this evidence row.
      }
    }
    if (retiredFormat === "flac" && (await this._exists(wavPath))) {
      try {
        const wavPcm = await this.reader.readVerifiedPcm({
          ...current,
          path: wavPath,
          format: "wav",
        });
        this._assertMetadata(wavPcm, current);
        await this._safeUnlink(wavPath);
        removed += 1;
      } catch {
        // Preserve an artifact that cannot be proven to belong to this evidence row.
      }
    }
    return removed;
  }

  async _removeUnownedFinal(chunkId, flacPath, expectedFileHash) {
    const current = this.getMaintenanceChunk(chunkId);
    if (current?.format === "flac" && path.resolve(current.path) === path.resolve(flacPath)) return;
    if (!(await this._exists(flacPath))) return;
    await this._safeUnlink(flacPath, expectedFileHash);
  }

  async _safeUnlink(candidate, expectedFileHash = null, revalidate = null) {
    const safe = await this._assertSafeExistingFile(candidate);
    const initialStat = await this.fs.lstat(safe);
    if (expectedFileHash) {
      const bytes = await this.fs.readFile(safe);
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual !== expectedFileHash) throw new Error("audio evidence file hash changed");
    }
    if (revalidate && !(await revalidate())) return false;
    const finalStat = await this.fs.lstat(safe);
    if (
      !finalStat.isFile() ||
      finalStat.isSymbolicLink() ||
      (finalStat.nlink !== undefined && finalStat.nlink !== 1) ||
      (initialStat.dev !== undefined && finalStat.dev !== initialStat.dev) ||
      (initialStat.ino !== undefined && finalStat.ino !== initialStat.ino) ||
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs
    ) {
      throw new Error("audio evidence file identity changed");
    }
    await this.fs.unlink(safe);
    return true;
  }

  _retiredIdentityStillValid(identity) {
    const current = this.getMaintenanceChunk(identity.chunkId);
    return Boolean(
      current &&
      current.retired_path === identity.retiredPath &&
      current.retired_file_sha256 === identity.retiredFileSha256 &&
      path.resolve(current.path) !== path.resolve(identity.retiredPath)
    );
  }

  async _cleanupRetiredArtifact(chunkId) {
    if (typeof this.store.clearRetiredArtifact !== "function") return 0;
    const chunk = this.getMaintenanceChunk(chunkId);
    if (!chunk?.retired_path) return 0;
    const retiredPath = this._contained(chunk.retired_path);
    if (path.resolve(chunk.path) === path.resolve(retiredPath)) return 0;
    let identity = {
      chunkId: chunk.id,
      retiredPath: chunk.retired_path,
      retiredFormat: chunk.retired_format,
      retiredFileSha256: chunk.retired_file_sha256,
    };
    try {
      await this._assertSafeExistingFile(retiredPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.store.clearRetiredArtifact({ ...identity, occurredAt: this.now() });
      return 1;
    }
    const retiredStat = await this.fs.lstat(retiredPath);
    if (
      typeof chunk.retired_file_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(chunk.retired_file_sha256)
    ) {
      if (typeof this.store.setRetiredArtifactHash !== "function") return 0;
      const bytes = await this.fs.readFile(retiredPath);
      const retiredFileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const recorded = this.store.setRetiredArtifactHash({
        ...identity,
        retiredFileSha256,
      });
      if (recorded !== 1) return 0;
      identity = { ...identity, retiredFileSha256 };
    }
    const removed = await this._safeUnlink(retiredPath, identity.retiredFileSha256, () =>
      this._retiredIdentityStillValid(identity)
    );
    if (!removed) return 0;
    this.store.clearRetiredArtifact({
      ...identity,
      fileBytes: retiredStat.size,
      occurredAt: this.now(),
    });
    return 1;
  }

  async _recoverWav(chunk, job, result) {
    const wavPath = this._contained(chunk.path);
    const parsed = path.parse(wavPath);
    const flacPath = this._contained(path.join(parsed.dir, `${parsed.name}.flac`));
    const partialPath = `${flacPath}.partial`;
    const temporaryPath = `${flacPath}.tmp`;
    let sourcePcm;
    try {
      await this._assertSafeExistingFile(wavPath);
      await this._assertSafeTarget(flacPath);
      sourcePcm = await this.reader.readVerifiedPcm(chunk);
      this._assertMetadata(sourcePcm, chunk);
    } catch {
      return;
    }

    if (await this._exists(temporaryPath)) {
      await this._safeUnlink(temporaryPath);
      result.removedInvalid += 1;
    }
    if (await this._exists(partialPath)) {
      try {
        await this._verifiedFlac(chunk, sourcePcm, partialPath);
        if (await this._exists(flacPath)) {
          await this._safeUnlink(partialPath);
          result.removedInvalid += 1;
        } else {
          await this.fs.rename(partialPath, flacPath);
        }
      } catch {
        await this._safeUnlink(partialPath);
        result.removedInvalid += 1;
      }
    }
    if (!(await this._exists(flacPath))) return;

    let verified;
    try {
      verified = await this._verifiedFlac(chunk, sourcePcm, flacPath);
    } catch {
      await this._safeUnlink(flacPath);
      result.rolledBack += 1;
      return;
    }
    const promoted = this.store.promoteChunkToFlac({
      chunkId: chunk.id,
      jobId: job.id,
      encoderVersion: job.encoderVersion,
      pcmSha256: chunk.pcm_sha256,
      wavPath,
      flacPath,
      fileSha256: verified.fileSha256,
      fileBytes: verified.fileBytes,
      sampleRate: chunk.sample_rate,
      channels: chunk.channels,
      completedAt: this.now(),
    });
    if (promoted.format !== "flac") throw new Error("FLAC recovery did not switch authority");
    result.promoted += 1;
    await this._safeUnlink(wavPath);
  }

  async _recoverFlac(chunk, job, result) {
    const flacPath = this._contained(chunk.path);
    let authoritativePcm;
    let fileBytes;
    try {
      await this._assertSafeExistingFile(flacPath);
      fileBytes = await this.fs.readFile(flacPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this._recoverInvalidFlacAuthority(chunk, job, flacPath, null, result);
        return;
      }
      this._markTemporarilyUnreadableFlac(chunk, job, flacPath);
      return;
    }
    const actualFileSha256 = crypto.createHash("sha256").update(fileBytes).digest("hex");
    try {
      if (chunk.file_sha256 && actualFileSha256 !== chunk.file_sha256) {
        throw new Error("file_hash_mismatch");
      }
      authoritativePcm = await this.reader.readVerifiedPcm(chunk);
      this._assertMetadata(authoritativePcm, chunk);
    } catch (error) {
      if (isTransientIoError(error)) {
        this._markTemporarilyUnreadableFlac(chunk, job, flacPath);
        return;
      }
      await this._recoverInvalidFlacAuthority(chunk, job, flacPath, actualFileSha256, result);
      return;
    }

    this.store.markCompressionRecoveryVerified?.({
      chunkId: chunk.id,
      jobId: job.id,
      encoderVersion: job.encoderVersion,
      verifiedAt: this.now(),
    });

    const parsed = path.parse(flacPath);
    for (const suffix of [".partial", ".tmp"]) {
      const candidate = `${flacPath}${suffix}`;
      if (await this._exists(candidate)) {
        await this._safeUnlink(candidate);
        result.removedInvalid += 1;
      }
    }
    const wavPath = this._contained(path.join(parsed.dir, `${parsed.name}.wav`));
    if (!(await this._exists(wavPath))) return;
    try {
      const wavPcm = await this.reader.readVerifiedPcm({ ...chunk, path: wavPath, format: "wav" });
      this._assertMetadata(wavPcm, chunk);
      if (Math.abs(wavPcm.sampleCount - authoritativePcm.sampleCount) > 1) return;
      await this._assertSafeExistingFile(wavPath);
      await this._safeUnlink(wavPath);
      result.deletedWavs += 1;
    } catch {
      // A conflicting non-authoritative file is preserved for diagnosis.
    }
  }

  _markTemporarilyUnreadableFlac(chunk, job, flacPath) {
    if (typeof this.store.markCompressionRecoveryRetry !== "function") return;
    this.store.markCompressionRecoveryRetry({
      chunkId: chunk.id,
      jobId: job.id,
      encoderVersion: job.encoderVersion,
      flacPath,
      fileSha256: chunk.file_sha256,
    });
  }

  async _recoverInvalidFlacAuthority(chunk, job, flacPath, retiredFileSha256, result) {
    const parsed = path.parse(flacPath);
    const wavPath = this._contained(path.join(parsed.dir, `${parsed.name}.wav`));
    let wavPcm;
    try {
      await this._assertSafeExistingFile(wavPath);
      wavPcm = await this.reader.readVerifiedPcm({ ...chunk, path: wavPath, format: "wav" });
      this._assertMetadata(wavPcm, chunk);
    } catch {
      this.store.markCompressionRecoveryFailure({
        chunkId: chunk.id,
        jobId: job.id,
        encoderVersion: job.encoderVersion,
        failedAt: this.now(),
      });
      return;
    }
    const rolledBack = this.store.rollbackChunkToWav({
      chunkId: chunk.id,
      jobId: job.id,
      encoderVersion: job.encoderVersion,
      pcmSha256: chunk.pcm_sha256,
      flacPath,
      wavPath,
      fileSha256: chunk.file_sha256,
      retiredFileSha256,
    });
    if (rolledBack.format !== "wav") throw new Error("WAV authority rollback failed");
    result.rolledBack += 1;
    try {
      result.removedInvalid += await this._cleanupRetiredArtifact(chunk.id);
    } catch {
      try {
        this.onRecoveryError({
          chunkId: chunk.id,
          jobId: job.id,
          code: "retired_flac_cleanup_failed",
        });
      } catch {
        // Recovery telemetry cannot make the durable rollback fail.
      }
    }
  }

  async _verifiedFlac(chunk, sourcePcm, candidatePath) {
    await this._assertSafeExistingFile(candidatePath);
    const encodedPcm = await this.reader.readVerifiedPcm({
      ...chunk,
      path: candidatePath,
      format: "flac",
    });
    this._assertMetadata(encodedPcm, chunk);
    if (Math.abs(encodedPcm.sampleCount - sourcePcm.sampleCount) > 1) {
      throw new Error("duration_mismatch");
    }
    const bytes = await this.fs.readFile(candidatePath);
    return {
      fileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      fileBytes: bytes.length,
    };
  }

  async _exists(candidate) {
    try {
      const stat = await this.fs.lstat(candidate);
      return (
        stat.isFile() && !stat.isSymbolicLink() && (stat.nlink === undefined || stat.nlink === 1)
      );
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  _assertMetadata(pcm, chunk) {
    if (pcm.sampleRate !== chunk.sample_rate) throw new Error("sample_rate_mismatch");
    if (pcm.channels !== chunk.channels) throw new Error("channels_mismatch");
    if (!Number.isSafeInteger(pcm.sampleCount) || pcm.sampleCount <= 0) {
      throw new Error("duration_mismatch");
    }
    const durationMs = Math.max(1, Math.round((pcm.sampleCount * 1_000) / pcm.sampleRate));
    if (durationMs !== chunk.duration_ms) throw new Error("duration_mismatch");
  }

  async _assertSafeExistingFile(candidate) {
    const resolved = this._contained(candidate);
    const stat = await this.fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== undefined && stat.nlink !== 1)) {
      throw new Error("audio evidence path must be a single-link regular file");
    }
    const [rootReal, candidateReal] = await Promise.all([
      this._validatedRoot(),
      this.fs.realpath(resolved),
    ]);
    if (!this._isContained(rootReal, candidateReal)) {
      throw new Error("audio evidence path escapes recordings root");
    }
    return resolved;
  }

  async _assertSafeTarget(candidate) {
    const resolved = this._contained(candidate);
    const parent = path.dirname(resolved);
    const parentStat = await this.fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error("audio evidence target parent is a symbolic link");
    }
    const [rootReal, parentReal] = await Promise.all([
      this._validatedRoot(),
      this.fs.realpath(parent),
    ]);
    if (!this._isContained(rootReal, parentReal, true)) {
      throw new Error("audio evidence target escapes recordings root");
    }
    try {
      const targetStat = await this.fs.lstat(resolved);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error("audio evidence target is a symbolic link or not a regular file");
      }
      await this._assertSafeExistingFile(resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return resolved;
  }

  async _validatedRoot() {
    const stat = await this.fs.lstat(this.recordingsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("recordings root must be a real directory, not a junction or symbolic link");
    }
    const real = await this.fs.realpath(this.recordingsRoot);
    const identity = {
      real,
      dev: stat.dev,
      ino: stat.ino,
    };
    if (this.fixedRoot === null) this.fixedRoot = identity;
    if (
      this.fixedRoot.real !== identity.real ||
      (this.fixedRoot.dev !== undefined && identity.dev !== this.fixedRoot.dev) ||
      (this.fixedRoot.ino !== undefined && identity.ino !== this.fixedRoot.ino)
    ) {
      throw new Error("recordings root identity changed");
    }
    return this.fixedRoot.real;
  }

  _contained(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new TypeError("audio evidence path must be absolute");
    }
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.recordingsRoot, resolved);
    if (
      relative.length === 0 ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("audio evidence path escapes recordings root");
    }
    return resolved;
  }

  _isContained(parent, candidate, allowSame = false) {
    const relative = path.relative(parent, candidate);
    return (
      (allowSame || relative.length > 0) &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  }

  _job(job) {
    if (!job || typeof job !== "object") throw new TypeError("compression job is required");
    const normalized = {
      id: job.id,
      chunkId: job.chunk_id ?? job.chunkId,
      inputHash: job.input_hash ?? job.inputHash,
      encoderVersion: job.model_version ?? job.encoderVersion,
      state: job.state,
    };
    if (job.job_type !== undefined && job.job_type !== "compress_chunk") {
      throw new TypeError("job must be compress_chunk");
    }
    for (const name of ["id", "chunkId", "inputHash", "encoderVersion"]) {
      if (typeof normalized[name] !== "string" || normalized[name].length === 0) {
        throw new TypeError(`compression job ${name} is required`);
      }
    }
    return normalized;
  }
}

module.exports = FlacCompressionWorker;
module.exports.FfmpegFlacEncoder = FfmpegFlacEncoder;
