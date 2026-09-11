"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const JarvisNotificationScheduler = require("../../src/jarvis/main/JarvisNotificationScheduler");
const { createElectronNotificationDelivery } = JarvisNotificationScheduler;
const { TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

const IDLE_CONTEXT = Object.freeze({
  fullscreenGame: false,
  meetingActive: false,
  presentationActive: false,
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function insertTodo(
  repository,
  id,
  { title = id, verificationState = "confirmed", occurredAt = 2, dueText = null } = {}
) {
  repository.db
    .prepare(
      `INSERT INTO todos_v2 (
         id, canonical_base_key, instance_key, title, status, provenance, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'open', 'suggestion', 1, 1)`
    )
    .run(id, hash(`base:${id}`), hash(`instance:${id}`), title);
  repository.db
    .prepare(
      `INSERT INTO todo_revisions (
         id, todo_instance_id, revision, previous_revision_id, title, due_text,
         source_analysis_input_id, provenance, created_at
       ) VALUES (?, ?, 1, NULL, ?, ?, NULL, 'suggestion', 1)`
    )
    .run(`revision_${id}`, id, title, dueText);
  repository.db
    .prepare(
      `INSERT INTO todo_verification_decisions (
         id, todo_instance_id, state, reason, actor, source_analysis_input_id, occurred_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      `verification_${id}`,
      id,
      verificationState,
      verificationState === "confirmed" ? "user_confirmed" : "assigned_and_accepted",
      verificationState === "confirmed" ? "user" : "system",
      occurredAt
    );
}

test("v47 upgrades to durable explicit reminders without inferring due_text", (t) => {
  const root = path.resolve(
    __dirname,
    "..",
    "..",
    ".tmp-tests",
    `restrained-notification-migration-${crypto.randomUUID()}`
  );
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, "jarvis.db");
  let repository = new JarvisRepository(databasePath);
  t.after(() => {
    repository?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  insertTodo(repository, "todo_due_text", {
    title: "Has an AI due date",
    dueText: "tomorrow",
  });
  repository.db.exec(`
    DROP TRIGGER IF EXISTS cancel_todo_reminder_on_terminal_state;
    DROP TABLE todo_reminders;
  `);
  repository.db.pragma("user_version = 47");
  repository.close();

  repository = new JarvisRepository(databasePath);
  assert.ok(TARGET_VERSION >= 48);
  assert.equal(repository.db.pragma("user_version", { simple: true }), TARGET_VERSION);
  assert.equal(
    repository.db.prepare("SELECT COUNT(*) AS count FROM todo_reminders").get().count,
    0
  );
  assert.deepEqual(repository.db.pragma("foreign_key_check"), []);
});

test("only a confirmed formal todo can receive an explicit durable reminder", (t) => {
  let now = 1_000;
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_pending", { verificationState: "pending_confirmation" });
  insertTodo(repository, "todo_confirmed", { title: "Call the customer" });

  assert.throws(
    () =>
      repository.setTodoReminder({
        todoId: "todo_pending",
        reminderAt: 2_000,
        at: now,
      }),
    (error) => error?.code === "JARVIS_TODO_REMINDER_CONFIRMATION_REQUIRED"
  );
  assert.equal(repository.getTodoReminder("todo_pending"), null);

  const scheduled = repository.setTodoReminder({
    todoId: "todo_confirmed",
    reminderAt: 2_000,
    at: now,
  });
  assert.equal(scheduled.reminderSource, "user");
  assert.equal(scheduled.state, "scheduled");
  assert.equal(scheduled.generation, 1);
  assert.equal(
    repository.setTodoReminder({
      todoId: "todo_confirmed",
      reminderAt: 2_000,
      at: now + 1,
    }).generation,
    1,
    "renderer retries must not create a second delivery generation"
  );

  repository.memoryRepository.completeTodo({ todoId: "todo_confirmed" });
  assert.equal(repository.getTodoReminder("todo_confirmed").state, "cancelled");
});

test("fullscreen defers due reminders and recovery emits one consolidated notification", async (t) => {
  let now = 10_000;
  let context = { ...IDLE_CONTEXT, fullscreenGame: true };
  const deliveries = [];
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_first", { title: "First confirmed reminder" });
  insertTodo(repository, "todo_second", { title: "Second confirmed reminder" });
  for (const todoId of ["todo_first", "todo_second"]) {
    repository.setTodoReminder({ todoId, reminderAt: now, at: now });
  }

  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => context,
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });
  const deferred = await scheduler.runOnce();
  assert.equal(deferred.notifiedCount, 0);
  assert.equal(deferred.deferredCount, 2);
  assert.equal(repository.getTodoReminder("todo_first").state, "deferred");
  assert.equal(repository.getTodoReminder("todo_first").deferredReason, "active_focus_context");

  context = IDLE_CONTEXT;
  now += 1;
  const delivered = await scheduler.runOnce();
  assert.equal(delivered.notifiedCount, 2);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].count, 2);
  assert.match(deliveries[0].body, /2/u);
  assert.equal(repository.getTodoReminder("todo_first").state, "delivered");

  const restarted = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => IDLE_CONTEXT,
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });
  assert.equal((await restarted.runOnce()).notifiedCount, 0);
  assert.equal(deliveries.length, 1, "restart must not replay a claimed Windows notification");
});

test("focus and temporary mute stay deferred until the user allows notifications", async (t) => {
  let now = 20_000;
  const deliveries = [];
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_focus", { title: "Focused reminder" });
  repository.setTodoReminder({ todoId: "todo_focus", reminderAt: now, at: now });
  repository.setNotificationPreferences({ focusMode: true, mutedUntil: null, at: now });
  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => IDLE_CONTEXT,
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });

  assert.equal((await scheduler.runOnce()).notifiedCount, 0);
  assert.equal(repository.getTodoReminder("todo_focus").deferredReason, "focus_mode");
  repository.setNotificationPreferences({
    focusMode: false,
    mutedUntil: now + 5_000,
    at: now + 1,
  });
  assert.equal((await scheduler.runOnce()).notifiedCount, 0);
  assert.equal(repository.getTodoReminder("todo_focus").deferredReason, "temporarily_muted");

  now += 5_001;
  assert.equal((await scheduler.runOnce()).notifiedCount, 1);
  assert.equal(deliveries.length, 1);
});

test("a failed native delivery is released for bounded retry instead of being lost", async (t) => {
  let now = 30_000;
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_retry", { title: "Retry reminder" });
  repository.setTodoReminder({ todoId: "todo_retry", reminderAt: now, at: now });
  let attempts = 0;
  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => IDLE_CONTEXT,
    notify: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("native delivery failed");
    },
    now: () => now,
  });

  assert.equal((await scheduler.runOnce()).deliveryFailed, true);
  assert.equal(repository.getTodoReminder("todo_retry").state, "deferred");
  assert.equal(repository.getTodoReminder("todo_retry").deferredReason, "delivery_failed");
  now += 15_000;
  assert.equal((await scheduler.runOnce()).notifiedCount, 1);
  assert.equal(attempts, 2);
});

test("an asynchronous Electron failure releases the claimed generation", async (t) => {
  const now = 35_000;
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_async_failure", { title: "Retry native failure" });
  repository.setTodoReminder({ todoId: "todo_async_failure", reminderAt: now, at: now });

  class FailedNotification extends EventEmitter {
    static isSupported() {
      return true;
    }

    show() {
      queueMicrotask(() => this.emit("failed", {}, "native notification rejected"));
    }
  }

  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => IDLE_CONTEXT,
    notify: createElectronNotificationDelivery({
      Notification: FailedNotification,
      onClick: () => {},
      confirmationTimeoutMs: 100,
    }),
    now: () => now,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.deliveryFailed, true);
  assert.equal(result.notifiedCount, 0);
  assert.equal(repository.getTodoReminder("todo_async_failure").state, "deferred");
  assert.equal(repository.getTodoReminder("todo_async_failure").deferredReason, "delivery_failed");
});

test("Electron delivery settles once on show and has a bounded acknowledgement timeout", async () => {
  let notification;
  class ControlledNotification extends EventEmitter {
    static isSupported() {
      return true;
    }

    constructor(options) {
      super();
      this.options = options;
      this.closed = false;
      notification = this;
    }

    show() {}

    close() {
      this.closed = true;
    }
  }

  let timeoutCallback = null;
  let cleared = 0;
  const notify = createElectronNotificationDelivery({
    Notification: ControlledNotification,
    onClick: () => {},
    confirmationTimeoutMs: 50,
    setTimeoutImpl(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {
      cleared += 1;
    },
  });

  const shown = notify({ title: "Jarvis", body: "Shown" });
  notification.emit("show", {});
  notification.emit("failed", {}, "late failure must not reverse acknowledgement");
  await shown;
  assert.equal(cleared, 1);
  assert.equal(notification.closed, false);

  const timedOut = notify({ title: "Jarvis", body: "No acknowledgement" });
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();
  await assert.rejects(
    timedOut,
    (error) => error?.code === "JARVIS_OS_NOTIFICATION_CONFIRMATION_TIMEOUT"
  );
  assert.equal(notification.closed, true);

  const synchronousFailure = new Error("show failed synchronously");
  class ThrowingNotification extends EventEmitter {
    static isSupported() {
      return true;
    }

    show() {
      throw synchronousFailure;
    }

    close() {}
  }
  const throwingNotify = createElectronNotificationDelivery({
    Notification: ThrowingNotification,
    onClick: () => {},
    confirmationTimeoutMs: 50,
  });
  await assert.rejects(
    throwingNotify({ title: "Jarvis", body: "Synchronous failure" }),
    (error) => error === synchronousFailure
  );
});

test("missing foreground context fails closed instead of interrupting a possible presentation", async (t) => {
  const now = 40_000;
  const deliveries = [];
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_context", { title: "Protected reminder" });
  repository.setTodoReminder({ todoId: "todo_context", reminderAt: now, at: now });
  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: async () => {
      throw new Error("foreground telemetry unavailable");
    },
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.notifiedCount, 0);
  assert.equal(deliveries.length, 0);
  assert.equal(repository.getTodoReminder("todo_context").state, "deferred");
  assert.equal(repository.getTodoReminder("todo_context").deferredReason, "active_focus_context");
});

test("the default foreground context fails closed during startup telemetry gaps", async (t) => {
  const now = 50_000;
  const deliveries = [];
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  insertTodo(repository, "todo_startup", { title: "Startup protected reminder" });
  repository.setTodoReminder({ todoId: "todo_startup", reminderAt: now, at: now });
  const scheduler = new JarvisNotificationScheduler({
    repository,
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.notifiedCount, 0);
  assert.equal(deliveries.length, 0);
  assert.equal(repository.getTodoReminder("todo_startup").state, "deferred");
  assert.equal(repository.getTodoReminder("todo_startup").deferredReason, "active_focus_context");
});

test("more than 200 overdue reminders continue in the next immediate drain", async (t) => {
  const now = 60_000;
  const deliveries = [];
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  for (let index = 0; index < 201; index += 1) {
    const todoId = `todo_batch_${String(index).padStart(3, "0")}`;
    insertTodo(repository, todoId, { title: `Batch reminder ${index}` });
    repository.setTodoReminder({ todoId, reminderAt: now, at: now });
  }
  const scheduler = new JarvisNotificationScheduler({
    repository,
    contextProvider: () => IDLE_CONTEXT,
    notify: (notification) => deliveries.push(notification),
    now: () => now,
  });

  const first = await scheduler.runOnce();
  assert.equal(first.notifiedCount, 200);
  assert.equal(first.nextDelayMs, 1);
  assert.equal(
    repository.db
      .prepare(
        "SELECT COUNT(*) AS count FROM todo_reminders WHERE state IN ('scheduled','deferred')"
      )
      .get().count,
    1
  );

  const second = await scheduler.runOnce();
  assert.equal(second.notifiedCount, 1);
  assert.equal(deliveries.length, 2);
  assert.equal(
    repository.db
      .prepare(
        "SELECT COUNT(*) AS count FROM todo_reminders WHERE state IN ('scheduled','deferred')"
      )
      .get().count,
    0
  );
});
