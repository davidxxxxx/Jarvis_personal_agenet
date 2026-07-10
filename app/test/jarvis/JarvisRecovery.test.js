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
