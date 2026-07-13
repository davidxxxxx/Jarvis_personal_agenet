const assert = require("node:assert/strict");
const test = require("node:test");

const MigrationCoordinator = require("../../src/jarvis/main/MigrationCoordinator");

test("closes the process gate before draining providers and keeps it closed through resume", async () => {
  const events = [];
  let releaseQuiesce;
  const quiesceBarrier = new Promise((resolve) => {
    releaseQuiesce = resolve;
  });
  const coordinator = new MigrationCoordinator({
    providers: [
      {
        name: "capture",
        async quiesce() {
          events.push("quiesce:start");
          await quiesceBarrier;
          events.push("quiesce:end");
        },
        async close() {
          events.push("close");
        },
        async reopen(root) {
          events.push(`reopen:${root}`);
        },
        async rollback(root) {
          events.push(`rollback:${root}`);
        },
        async resume() {
          events.push("resume");
        },
      },
    ],
  });

  const migration = coordinator.runExclusive(async (lease) => {
    events.push("operation");
    await lease.reopen("new-root");
    return "migrated";
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => coordinator.assertProducerAllowed("capture"),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
  assert.deepEqual(events, ["quiesce:start"]);

  releaseQuiesce();
  assert.equal(await migration, "migrated");
  assert.deepEqual(events, [
    "quiesce:start",
    "quiesce:end",
    "close",
    "operation",
    "reopen:new-root",
    "resume",
  ]);
  assert.doesNotThrow(() => coordinator.assertProducerAllowed("capture"));
});

test("rolls every closed provider back in reverse order and does not open the gate early", async () => {
  const events = [];
  const provider = (name, failReopen = false) => ({
    name,
    async quiesce() {
      events.push(`quiesce:${name}`);
    },
    async close() {
      events.push(`close:${name}`);
    },
    async reopen() {
      events.push(`reopen:${name}`);
      if (failReopen) throw new Error("reopen failed");
    },
    async rollback() {
      events.push(`rollback:${name}`);
    },
    async resume() {
      assert.doesNotThrow(() => coordinator.assertProducerAllowed("resume-check"));
      events.push(`resume:${name}`);
    },
  });
  const coordinator = new MigrationCoordinator({
    providers: [provider("one"), provider("two", true)],
  });

  await assert.rejects(
    coordinator.runExclusive(async (lease) => lease.reopen("new-root")),
    /reopen failed/
  );

  assert.deepEqual(events, [
    "quiesce:one",
    "quiesce:two",
    "close:one",
    "close:two",
    "reopen:one",
    "reopen:two",
    "rollback:two",
    "rollback:one",
    "resume:two",
    "resume:one",
  ]);
  assert.doesNotThrow(() => coordinator.assertProducerAllowed("capture"));
});

test("rolls closed providers back when copying fails before reopen", async () => {
  const events = [];
  const coordinator = new MigrationCoordinator({
    providers: [
      {
        name: "database",
        async quiesce() {
          events.push("quiesce");
        },
        async close() {
          events.push("close");
        },
        async reopen() {
          events.push("reopen");
        },
        async rollback(root) {
          events.push(`rollback:${root}`);
        },
        async resume() {
          events.push("resume");
        },
      },
    ],
  });

  await assert.rejects(
    coordinator.runExclusive(
      async () => {
        throw new Error("copy interrupted");
      },
      { previousRoot: "old-root" }
    ),
    /copy interrupted/
  );
  assert.deepEqual(events, ["quiesce", "close", "rollback:old-root", "resume"]);
});

test("keeps committed providers on the new root and leaves the gate closed after a post-commit failure", async () => {
  const events = [];
  const coordinator = new MigrationCoordinator({
    providers: [
      {
        name: "database",
        async quiesce() {
          events.push("quiesce");
        },
        async close() {
          events.push("close");
        },
        async reopen(root) {
          events.push(`reopen:${root}`);
        },
        async rollback(root) {
          events.push(`rollback:${root}`);
        },
        async resume() {
          events.push("resume");
        },
      },
    ],
  });

  await assert.rejects(
    coordinator.runExclusive(
      async (lease) => {
        await lease.reopen("new-root");
        lease.commit("new-root");
        throw new Error("lease release failed");
      },
      { previousRoot: "old-root" }
    ),
    /lease release failed/
  );

  assert.deepEqual(events, ["quiesce", "close", "reopen:new-root", "resume"]);
  assert.throws(
    () => coordinator.assertProducerAllowed(),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
});

test("leaves the write gate closed when provider rollback cannot be completed", async (t) => {
  const coordinator = new MigrationCoordinator({
    providers: [
      {
        name: "database",
        async quiesce() {},
        async close() {},
        async reopen() {},
        async rollback() {
          throw new Error("rollback failed");
        },
        async resume() {},
      },
    ],
  });
  t.after(() => coordinator.writeGate.open());

  await assert.rejects(
    coordinator.runExclusive(
      async () => {
        throw new Error("copy failed");
      },
      { previousRoot: "old-root" }
    ),
    /migration operation and rollback failed/
  );

  assert.throws(
    () => coordinator.assertProducerAllowed(),
    (error) => error?.code === "STORAGE_MIGRATION_IN_PROGRESS"
  );
});
