const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

test("startup marks interrupted recording sessions recovered without resuming them", () => {
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: null });
  repository.setSessionStatus("s1", "recording", 1_000);

  try {
    const recovered = repository.recoverOpenSessions(5_000);

    assert.deepEqual(
      recovered.map((row) => row.id),
      ["s1"]
    );
    assert.equal(repository.getSession("s1").status, "recovered");
    assert.equal(repository.getSession("s1").ended_at, 5_000);
  } finally {
    repository.close();
  }
});

test("startup recovery finalizes every degraded dual track and open gap", () => {
  const repository = new JarvisRepository(":memory:");
  repository.createSession({ id: "s1", startedAt: 1_000, micDeviceId: "mic-1" });
  repository.createTracks([
    {
      id: "tm",
      sessionId: "s1",
      sourceType: "mic",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
      state: "active",
    },
    {
      id: "ts",
      sessionId: "s1",
      sourceType: "system",
      sampleRate: 24_000,
      channels: 1,
      startedAt: 1_000,
      state: "active",
    },
  ]);
  repository.interruptTrack({
    trackId: "ts",
    gap: { id: "g1", trackId: "ts", startedAt: 2_000, reason: "device-change" },
  });

  try {
    const recovered = repository.recoverOpenSessions(5_000);

    assert.deepEqual(recovered.map((row) => row.id), ["s1"]);
    assert.deepEqual(repository.db.prepare("SELECT status, ended_at FROM sessions").get(), {
      status: "recovered",
      ended_at: 5_000,
    });
    assert.deepEqual(repository.db.prepare("SELECT DISTINCT state, ended_at FROM audio_tracks").all(), [
      { state: "recovered", ended_at: 5_000 },
    ]);
    assert.equal(
      repository.db.prepare("SELECT count(*) count FROM audio_gaps WHERE ended_at IS NULL").get().count,
      0
    );
    assert.equal(repository.db.prepare("SELECT ended_at FROM audio_gaps WHERE id='g1'").get().ended_at, 5_000);
  } finally {
    repository.close();
  }
});
