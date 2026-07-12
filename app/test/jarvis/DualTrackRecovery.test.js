const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisService = require("../../src/jarvis/main/JarvisService");

const ONE_SECOND_BYTES = 24_000 * 2;

function safeFs() {
  const implementation = Object.create(fs);
  implementation.statfsSync = () => ({
    bsize: 1,
    blocks: 200 * 1024 ** 3,
    bavail: 20 * 1024 ** 3,
  });
  return implementation;
}

function dualSources() {
  return [
    {
      sourceType: "mic",
      deviceId: "physical-mic",
      deviceLabel: "Physical microphone",
      strategy: "web-audio",
    },
    {
      sourceType: "system",
      deviceId: null,
      deviceLabel: "Windows output",
      strategy: "wasapi-loopback",
    },
  ];
}

function snapshot(repository, sessionId) {
  return {
    session: repository.getSession(sessionId),
    tracks: repository.db
      .prepare("SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY source_type")
      .all(sessionId),
    gaps: repository.db
      .prepare(
        "SELECT g.* FROM audio_gaps g JOIN audio_tracks t ON t.id = g.track_id WHERE t.session_id = ? ORDER BY g.started_at, g.id"
      )
      .all(sessionId),
    chunks: repository.db
      .prepare(
        "SELECT * FROM audio_chunks WHERE session_id = ? ORDER BY source_type, sequence_number"
      )
      .all(sessionId),
    jobs: repository.db
      .prepare("SELECT * FROM processing_jobs WHERE session_id = ? ORDER BY chunk_id, id")
      .all(sessionId),
  };
}

function createRuntime(testRoot, sessionId) {
  const dbPath = path.join(testRoot, "jarvis.sqlite");
  const recordingsDir = path.join(testRoot, "recordings");
  let clock = 1_000;
  let repository = new JarvisRepository(dbPath);
  repository.createSession({
    id: sessionId,
    startedAt: clock,
    micDeviceId: "physical-mic",
    captureMode: "dual",
  });
  let service = new JarvisService({
    repository,
    userDataDir: testRoot,
    recordingsDir,
    broadcast() {},
    now: () => clock,
    fsImpl: safeFs(),
  });
  service.startCapture({
    sessionId,
    startedAt: clock,
    captureMode: "dual",
    sources: dualSources(),
  });

  return {
    get repository() {
      return repository;
    },
    get service() {
      return service;
    },
    setClock(value) {
      clock = value;
    },
    feed(sourceType, byte) {
      return service.appendPcm(sessionId, sourceType, Buffer.alloc(ONE_SECOND_BYTES, byte));
    },
    interrupt(sourceType, at, reason = "device-change") {
      clock = at;
      return service.sourceInterrupted(sessionId, sourceType, { at, reason });
    },
    restore(sourceType, at) {
      clock = at;
      return service.sourceRestored(sessionId, sourceType, {
        at,
        deviceId: sourceType === "mic" ? `physical-mic-${at}` : null,
        deviceLabel: sourceType === "mic" ? "Physical microphone" : "Windows output",
        strategy: sourceType === "mic" ? "web-audio" : "wasapi-loopback",
      });
    },
    restartAndRecover(at, fsImpl = safeFs()) {
      repository.close();
      repository = new JarvisRepository(dbPath);
      service = new JarvisService({
        repository,
        userDataDir: testRoot,
        recordingsDir,
        broadcast() {},
        now: () => at,
        fsImpl,
      });
      return service.recoverOpenSessions(at);
    },
    close() {
      repository.close();
    },
  };
}

function leaveMicRecoverySidecar(runtime, testRoot, sessionId) {
  const originalCommitChunk = runtime.repository.commitChunk.bind(runtime.repository);
  let failMicCommit = true;
  runtime.repository.commitChunk = (chunk) => {
    if (failMicCommit && chunk.sourceType === "mic") {
      failMicCommit = false;
      throw new Error("simulated crash before SQLite commit");
    }
    return originalCommitChunk(chunk);
  };

  runtime.setClock(61_000);
  assert.equal(
    runtime.service.appendPcm(sessionId, "mic", Buffer.alloc(ONE_SECOND_BYTES * 60, 0x5a)),
    false
  );

  const recordingDir = path.join(testRoot, "recordings", sessionId, "mic");
  const sidecarName = fs
    .readdirSync(recordingDir)
    .find((entry) => entry.endsWith(".recovery.json"));
  assert.ok(sidecarName);
  const sidecarPath = path.join(recordingDir, sidecarName);
  return {
    sidecarPath,
    metadata: JSON.parse(fs.readFileSync(sidecarPath, "utf8")),
  };
}

for (const failureOrder of [
  ["system", "mic"],
  ["mic", "system"],
]) {
  test(`dual evidence survives ${failureOrder.join(" then ")} interruption and restart`, () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dual-recovery-"));
    const sessionId = `session-${failureOrder.join("-")}`;
    const runtime = createRuntime(testRoot, sessionId);

    try {
      assert.equal(runtime.feed("mic", 0x11), true);
      assert.equal(runtime.feed("system", 0x21), true);

      let at = 2_000;
      for (const sourceType of failureOrder) {
        const survivingSource = sourceType === "mic" ? "system" : "mic";
        const interrupted = runtime.interrupt(sourceType, at);
        assert.equal(interrupted.status, "degraded");
        assert.equal(interrupted.sources[sourceType].state, "reconnecting");
        assert.equal(interrupted.sources[survivingSource].state, "active");

        const duplicate = runtime.interrupt(sourceType, at + 1, "stale-ended-callback");
        assert.equal(duplicate.sources[sourceType].state, "reconnecting");
        assert.equal(runtime.feed(sourceType, 0x7f), false);
        assert.equal(runtime.feed(survivingSource, sourceType === "mic" ? 0x22 : 0x12), true);

        const restored = runtime.restore(sourceType, at + 500);
        assert.equal(restored.status, "recording");
        assert.equal(restored.sources[sourceType].state, "active");
        assert.equal(runtime.feed(sourceType, sourceType === "mic" ? 0x31 : 0x41), true);
        at += 1_500;
      }

      const openSource = failureOrder[0];
      runtime.interrupt(openSource, at, "output-route-changed");
      const beforeRestart = snapshot(runtime.repository, sessionId);
      assert.equal(beforeRestart.session.status, "recording");
      assert.equal(beforeRestart.session.capture_mode, "dual");
      assert.equal(beforeRestart.tracks.length, 2);
      assert.equal(beforeRestart.gaps.filter((gap) => gap.ended_at === null).length, 1);
      assert.ok(beforeRestart.chunks.length >= 2);
      assert.equal(beforeRestart.jobs.length, beforeRestart.chunks.length * 2);
      for (const chunk of beforeRestart.chunks) {
        assert.deepEqual(
          beforeRestart.jobs
            .filter((job) => job.chunk_id === chunk.id)
            .map((job) => job.job_type)
            .sort(),
          ["compress_chunk", "transcribe_chunk"]
        );
      }
      assert.deepEqual(
        [...new Set(beforeRestart.chunks.map((chunk) => chunk.source_type))].sort(),
        ["mic", "system"]
      );
      assert.equal(
        fs
          .readdirSync(path.join(testRoot, "recordings"), { recursive: true })
          .some((entry) => entry.endsWith(".tmp") || entry.endsWith(".recovery.json")),
        false,
        "committed writers must not retain temporary files or open recovery sidecars"
      );

      for (const chunk of beforeRestart.chunks) {
        const pcm = fs.readFileSync(chunk.path).subarray(44);
        assert.equal(pcm.length, chunk.duration_ms * 48);
        assert.equal(
          require("node:crypto").createHash("sha256").update(pcm).digest("hex"),
          chunk.sha256
        );
      }

      const recovered = runtime.restartAndRecover(at + 1_000);
      assert.deepEqual(
        recovered.map((session) => session.id),
        [sessionId]
      );
      const afterRecovery = snapshot(runtime.repository, sessionId);
      assert.equal(afterRecovery.session.status, "recovered");
      assert.equal(afterRecovery.session.ended_at, at + 1_000);
      assert.deepEqual(
        afterRecovery.tracks.map(({ source_type, state, ended_at }) => ({
          sourceType: source_type,
          state,
          endedAt: ended_at,
        })),
        [
          { sourceType: "mic", state: "recovered", endedAt: at + 1_000 },
          { sourceType: "system", state: "recovered", endedAt: at + 1_000 },
        ]
      );
      assert.equal(
        afterRecovery.gaps.every((gap) => gap.ended_at !== null),
        true
      );
      assert.equal(afterRecovery.jobs.length, afterRecovery.chunks.length * 2);

      const stableCounts = {
        chunks: afterRecovery.chunks.length,
        jobs: afterRecovery.jobs.length,
        gaps: afterRecovery.gaps.length,
      };
      assert.deepEqual(runtime.service.recoverOpenSessions(at + 2_000), []);
      const afterSecondRecovery = snapshot(runtime.repository, sessionId);
      assert.deepEqual(
        {
          chunks: afterSecondRecovery.chunks.length,
          jobs: afterSecondRecovery.jobs.length,
          gaps: afterSecondRecovery.gaps.length,
        },
        stableCounts
      );
      assert.equal(
        runtime.repository.db
          .prepare(
            "SELECT count(*) count FROM audio_chunks c LEFT JOIN processing_jobs j ON j.chunk_id = c.id AND j.job_type = 'transcribe_chunk' WHERE c.session_id = ? AND j.id IS NULL"
          )
          .get(sessionId).count,
        0
      );
    } finally {
      runtime.close();
      // On Windows this recursive removal also fails if either the abandoned writer or the
      // restarted repository leaked a file handle.
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
}

test("startup reconciles a renamed WAV sidecar before finalizing its interrupted session", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sidecar-recovery-"));
  const sessionId = "session-sidecar-recovery";
  const runtime = createRuntime(testRoot, sessionId);

  try {
    const originalCommitChunk = runtime.repository.commitChunk.bind(runtime.repository);
    let failMicCommit = true;
    runtime.repository.commitChunk = (chunk) => {
      if (failMicCommit && chunk.sourceType === "mic") {
        failMicCommit = false;
        throw new Error("simulated crash before SQLite commit");
      }
      return originalCommitChunk(chunk);
    };

    runtime.setClock(61_000);
    assert.equal(
      runtime.service.appendPcm(
        "session-sidecar-recovery",
        "mic",
        Buffer.alloc(ONE_SECOND_BYTES * 60, 0x5a)
      ),
      false
    );
    const recordingFiles = fs.readdirSync(path.join(testRoot, "recordings"), { recursive: true });
    assert.equal(recordingFiles.filter((entry) => entry.endsWith(".wav")).length, 1);
    assert.equal(recordingFiles.filter((entry) => entry.endsWith(".recovery.json")).length, 1);
    assert.equal(snapshot(runtime.repository, sessionId).chunks.length, 0);
    assert.equal(snapshot(runtime.repository, sessionId).jobs.length, 0);
    const interruptedEvidence = snapshot(runtime.repository, sessionId);
    const micTrack = interruptedEvidence.tracks.find((track) => track.source_type === "mic");
    const micGap = interruptedEvidence.gaps.find((gap) => gap.track_id === micTrack.id);
    assert.equal(micTrack.ended_at, 61_000);
    assert.equal(micGap.started_at, 61_000);

    const micDir = path.join(testRoot, "recordings", sessionId, "mic");
    const validSidecarName = fs
      .readdirSync(micDir)
      .find((entry) => entry.endsWith(".recovery.json"));
    assert.ok(validSidecarName);
    const validSidecarPath = path.join(micDir, validSidecarName);
    const validMetadata = JSON.parse(fs.readFileSync(validSidecarPath, "utf8"));
    const conflictingWavPath = path.join(micDir, "zz-conflict.wav");
    const conflictingSidecarPath = `${conflictingWavPath}.recovery.json`;
    fs.copyFileSync(validMetadata.path, conflictingWavPath);
    fs.writeFileSync(
      conflictingSidecarPath,
      JSON.stringify({ ...validMetadata, id: "zz-conflict", path: conflictingWavPath })
    );
    const invalidSidecarPath = path.join(micDir, "zz-invalid.wav.recovery.json");
    fs.writeFileSync(
      invalidSidecarPath,
      JSON.stringify({
        ...validMetadata,
        id: "zz-invalid",
        path: path.join(testRoot, "outside-recordings.wav"),
      })
    );

    const recovered = runtime.restartAndRecover(62_000);
    assert.deepEqual(
      recovered.map((session) => session.id),
      [sessionId]
    );
    const evidence = snapshot(runtime.repository, sessionId);
    assert.equal(evidence.session.status, "recovered");
    assert.equal(evidence.chunks.length, 1);
    assert.equal(evidence.jobs.length, 2);
    assert.equal(
      evidence.jobs.every((job) => job.chunk_id === evidence.chunks[0].id),
      true
    );
    assert.deepEqual(evidence.jobs.map((job) => job.job_type).sort(), [
      "compress_chunk",
      "transcribe_chunk",
    ]);
    const remainingSidecars = fs
      .readdirSync(micDir)
      .filter((entry) => entry.endsWith(".recovery.json"))
      .sort();
    assert.deepEqual(remainingSidecars, [
      path.basename(conflictingSidecarPath),
      path.basename(invalidSidecarPath),
    ]);

    assert.deepEqual(runtime.service.recoverOpenSessions(63_000), []);
    const stableEvidence = snapshot(runtime.repository, sessionId);
    assert.equal(stableEvidence.chunks.length, 1);
    assert.equal(stableEvidence.jobs.length, 2);
    assert.deepEqual(
      fs
        .readdirSync(micDir)
        .filter((entry) => entry.endsWith(".recovery.json"))
        .sort(),
      remainingSidecars
    );
  } finally {
    runtime.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("startup rejects an oversized recovery WAV before reading its contents", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-oversized-sidecar-"));
  const sessionId = "session-oversized-sidecar";
  const runtime = createRuntime(testRoot, sessionId);

  try {
    const originalCommitChunk = runtime.repository.commitChunk.bind(runtime.repository);
    let failMicCommit = true;
    runtime.repository.commitChunk = (chunk) => {
      if (failMicCommit && chunk.sourceType === "mic") {
        failMicCommit = false;
        throw new Error("simulated crash before SQLite commit");
      }
      return originalCommitChunk(chunk);
    };

    runtime.setClock(61_000);
    assert.equal(
      runtime.service.appendPcm(sessionId, "mic", Buffer.alloc(ONE_SECOND_BYTES * 60, 0x5a)),
      false
    );

    const micDir = path.join(testRoot, "recordings", sessionId, "mic");
    const sidecarName = fs.readdirSync(micDir).find((entry) => entry.endsWith(".recovery.json"));
    assert.ok(sidecarName);
    const sidecarPath = path.join(micDir, sidecarName);
    const metadata = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    fs.appendFileSync(metadata.path, Buffer.of(0));

    const guardedFs = safeFs();
    const originalReadFileSync = guardedFs.readFileSync.bind(guardedFs);
    let oversizedWavReads = 0;
    guardedFs.readFileSync = (filePath, ...args) => {
      if (path.resolve(filePath) === path.resolve(metadata.path)) oversizedWavReads += 1;
      return originalReadFileSync(filePath, ...args);
    };

    runtime.restartAndRecover(62_000, guardedFs);

    assert.equal(oversizedWavReads, 0);
    assert.equal(fs.existsSync(sidecarPath), true);
    assert.equal(snapshot(runtime.repository, sessionId).chunks.length, 0);
  } finally {
    runtime.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("startup preserves a valid recovery sidecar whose timeline starts before its track and session", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-early-sidecar-"));
  const sessionId = "session-early-sidecar";
  const runtime = createRuntime(testRoot, sessionId);

  try {
    const { sidecarPath, metadata } = leaveMicRecoverySidecar(runtime, testRoot, sessionId);
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        ...metadata,
        startedAt: 0,
        endedAt: 60_000,
      })
    );

    runtime.restartAndRecover(62_000);

    const evidence = snapshot(runtime.repository, sessionId);
    assert.equal(evidence.chunks.length, 0);
    assert.equal(evidence.jobs.length, 0);
    assert.equal(fs.existsSync(sidecarPath), true);
  } finally {
    runtime.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("startup preserves a valid far-future recovery sidecar beyond existing track and session ends", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-late-sidecar-"));
  const sessionId = "session-late-sidecar";
  const runtime = createRuntime(testRoot, sessionId);

  try {
    const { sidecarPath, metadata } = leaveMicRecoverySidecar(runtime, testRoot, sessionId);
    const farFutureStartedAt = Date.UTC(2200, 0, 1);
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        ...metadata,
        startedAt: farFutureStartedAt,
        endedAt: farFutureStartedAt + metadata.durationMs,
      })
    );
    runtime.repository.db
      .prepare("UPDATE audio_tracks SET state = 'ended', ended_at = ? WHERE session_id = ?")
      .run(62_000, sessionId);
    runtime.repository.db
      .prepare("UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?")
      .run(62_000, sessionId);

    runtime.restartAndRecover(63_000);

    const evidence = snapshot(runtime.repository, sessionId);
    assert.equal(evidence.chunks.length, 0);
    assert.equal(evidence.jobs.length, 0);
    assert.equal(fs.existsSync(sidecarPath), true);
  } finally {
    runtime.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
