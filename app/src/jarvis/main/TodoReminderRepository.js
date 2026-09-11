"use strict";

const MAX_DUE_REMINDERS = 200;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertReason(value) {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,128}$/u.test(value)) {
    throw new TypeError("reminder reason must be a safe identifier");
  }
  return value;
}

function normalizeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DUE_REMINDERS) {
    throw new RangeError(`reminder limit must be between 1 and ${MAX_DUE_REMINDERS}`);
  }
  return value;
}

function toReminder(row) {
  if (!row) return null;
  return {
    todoId: row.todo_instance_id,
    title: row.title ?? null,
    reminderAt: row.reminder_at,
    reminderSource: row.reminder_source,
    generation: row.generation,
    state: row.state,
    deferredReason: row.deferred_reason,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verificationState: row.verification_state ?? null,
  };
}

class TodoReminderRepository {
  constructor(db, { now = Date.now } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("database is required");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.db = db;
    this.now = now;
  }

  _todoState(todoId) {
    return this.db
      .prepare(
        `SELECT todo.id, todo.title, todo.status,
                (
                  SELECT decision.effective_state
                  FROM todo_effective_verification AS decision
                  WHERE decision.todo_instance_id = todo.id
                ) AS verification_state
         FROM todos_v2 AS todo
         WHERE todo.id = ?`
      )
      .get(todoId);
  }

  _get(todoId) {
    return this.db
      .prepare(
        `SELECT reminder.*, todo.title,
                (
                  SELECT decision.effective_state
                  FROM todo_effective_verification AS decision
                  WHERE decision.todo_instance_id = todo.id
                ) AS verification_state
         FROM todo_reminders AS reminder
         JOIN todos_v2 AS todo ON todo.id = reminder.todo_instance_id
         WHERE reminder.todo_instance_id = ?`
      )
      .get(todoId);
  }

  get(todoId) {
    return toReminder(this._get(assertId(todoId, "todoId")));
  }

  set({ todoId, reminderAt, at = this.now() } = {}) {
    const id = assertId(todoId, "todoId");
    const changedAt = assertTimestamp(at, "reminder updatedAt");
    if (reminderAt !== null) assertTimestamp(reminderAt, "reminderAt");

    const transaction = this.db.transaction(() => {
      const todo = this._todoState(id);
      if (!todo) throw codedError("JARVIS_TODO_NOT_FOUND");
      const existing = this._get(id);

      if (reminderAt === null) {
        if (!existing) return null;
        if (existing.state !== "cancelled") {
          this.db
            .prepare(
              `UPDATE todo_reminders
               SET state = 'cancelled', deferred_reason = NULL, delivered_at = NULL,
                   cancelled_at = ?, updated_at = MAX(updated_at, ?)
               WHERE todo_instance_id = ?`
            )
            .run(changedAt, changedAt, id);
        }
        return toReminder(this._get(id));
      }

      if (todo.status !== "open") throw codedError("JARVIS_TODO_NOT_OPEN");
      if (todo.verification_state !== "confirmed") {
        throw codedError("JARVIS_TODO_REMINDER_CONFIRMATION_REQUIRED");
      }

      // Exact retries from the renderer are idempotent, including after delivery. A new
      // notification requires a newly selected timestamp rather than replaying an old one.
      if (existing && existing.reminder_at === reminderAt && existing.state !== "cancelled") {
        return toReminder(existing);
      }

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO todo_reminders (
               todo_instance_id, reminder_at, reminder_source, generation, state,
               deferred_reason, delivered_at, cancelled_at, created_at, updated_at
             ) VALUES (?, ?, 'user', 1, 'scheduled', NULL, NULL, NULL, ?, ?)`
          )
          .run(id, reminderAt, changedAt, changedAt);
      } else {
        this.db
          .prepare(
            `UPDATE todo_reminders
             SET reminder_at = ?, reminder_source = 'user', generation = generation + 1,
                 state = 'scheduled', deferred_reason = NULL, delivered_at = NULL,
                 cancelled_at = NULL, updated_at = MAX(updated_at, ?)
             WHERE todo_instance_id = ?`
          )
          .run(reminderAt, changedAt, id);
      }
      return toReminder(this._get(id));
    });
    return transaction.immediate();
  }

  listDue(at = this.now(), limit = 100) {
    const dueAt = assertTimestamp(at, "due reminder time");
    const boundedLimit = normalizeLimit(limit);
    return this.db
      .prepare(
        `SELECT reminder.*, todo.title, 'confirmed' AS verification_state
         FROM todo_reminders AS reminder
         JOIN todos_v2 AS todo ON todo.id = reminder.todo_instance_id
         JOIN todo_effective_verification AS decision
           ON decision.todo_instance_id = todo.id
         WHERE reminder.state IN ('scheduled','deferred')
           AND reminder.reminder_at <= ?
           AND reminder.reminder_source = 'user'
           AND todo.status = 'open'
           AND decision.effective_state = 'confirmed'
         ORDER BY reminder.reminder_at, reminder.todo_instance_id
         LIMIT ?`
      )
      .all(dueAt, boundedLimit)
      .map(toReminder);
  }

  nextScheduledAt(after = this.now()) {
    assertTimestamp(after, "next reminder time");
    const row = this.db
      .prepare(
        `SELECT MIN(reminder.reminder_at) AS reminder_at
         FROM todo_reminders AS reminder
         JOIN todos_v2 AS todo ON todo.id = reminder.todo_instance_id
         JOIN todo_effective_verification AS decision
           ON decision.todo_instance_id = todo.id
         WHERE reminder.state IN ('scheduled','deferred')
           AND reminder.reminder_source = 'user'
           AND todo.status = 'open'
           AND decision.effective_state = 'confirmed'`
      )
      .get();
    return Number.isSafeInteger(row?.reminder_at) ? row.reminder_at : null;
  }

  reconcile(at = this.now()) {
    const reconciledAt = assertTimestamp(at, "reminder reconciliation time");
    return this.db
      .prepare(
        `UPDATE todo_reminders AS reminder
         SET state = 'cancelled', deferred_reason = NULL, delivered_at = NULL,
             cancelled_at = ?, updated_at = MAX(updated_at, ?)
         WHERE reminder.state IN ('scheduled','deferred')
           AND NOT EXISTS (
             SELECT 1
             FROM todos_v2 AS todo
             JOIN todo_effective_verification AS decision
               ON decision.todo_instance_id = todo.id
             WHERE todo.id = reminder.todo_instance_id
               AND todo.status = 'open'
               AND decision.effective_state = 'confirmed'
           )`
      )
      .run(reconciledAt, reconciledAt).changes;
  }

  defer(items, reason, at = this.now()) {
    const deferredAt = assertTimestamp(at, "reminder deferredAt");
    const deferredReason = assertReason(reason);
    const normalized = this._normalizeItems(items);
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(
        `UPDATE todo_reminders
         SET state = 'deferred', deferred_reason = ?, updated_at = MAX(updated_at, ?)
         WHERE todo_instance_id = ? AND generation = ?
           AND state IN ('scheduled','deferred')`
      );
      let changed = 0;
      for (const item of normalized) {
        changed += update.run(deferredReason, deferredAt, item.todoId, item.generation).changes;
      }
      return changed;
    });
    return transaction.immediate();
  }

  claimDelivery(items, at = this.now()) {
    const deliveredAt = assertTimestamp(at, "reminder deliveredAt");
    const normalized = this._normalizeItems(items);
    const transaction = this.db.transaction(() => {
      const claim = this.db.prepare(
        `UPDATE todo_reminders
         SET state = 'delivered', deferred_reason = NULL, delivered_at = ?,
             cancelled_at = NULL, updated_at = MAX(updated_at, ?)
         WHERE todo_instance_id = ? AND generation = ?
           AND state IN ('scheduled','deferred')
           AND reminder_source = 'user'
           AND EXISTS (
             SELECT 1
             FROM todos_v2 AS todo
             JOIN todo_effective_verification AS decision
               ON decision.todo_instance_id = todo.id
             WHERE todo.id = todo_reminders.todo_instance_id
               AND todo.status = 'open'
               AND decision.effective_state = 'confirmed'
           )`
      );
      const claimed = [];
      for (const item of normalized) {
        if (claim.run(deliveredAt, deliveredAt, item.todoId, item.generation).changes === 1) {
          const row = this._get(item.todoId);
          if (row) claimed.push(toReminder(row));
        }
      }
      return claimed;
    });
    return transaction.immediate();
  }

  releaseDelivery(items, { claimedAt, reason = "delivery_failed", at = this.now() } = {}) {
    const deliveryAt = assertTimestamp(claimedAt, "claimedAt");
    const releasedAt = assertTimestamp(at, "reminder release time");
    const deferredReason = assertReason(reason);
    const normalized = this._normalizeItems(items);
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(
        `UPDATE todo_reminders
         SET state = 'deferred', deferred_reason = ?, delivered_at = NULL,
             updated_at = MAX(updated_at, ?)
         WHERE todo_instance_id = ? AND generation = ?
           AND state = 'delivered' AND delivered_at = ?`
      );
      let changed = 0;
      for (const item of normalized) {
        changed += update.run(
          deferredReason,
          releasedAt,
          item.todoId,
          item.generation,
          deliveryAt
        ).changes;
      }
      return changed;
    });
    return transaction.immediate();
  }

  _normalizeItems(items) {
    if (!Array.isArray(items) || items.length > MAX_DUE_REMINDERS) {
      throw new TypeError("reminder items must be a bounded array");
    }
    const seen = new Set();
    return items.map((item) => {
      const todoId = assertId(item?.todoId, "todoId");
      if (seen.has(todoId)) throw new TypeError("reminder items must be unique");
      seen.add(todoId);
      if (!Number.isSafeInteger(item?.generation) || item.generation < 1) {
        throw new TypeError("reminder generation must be a positive safe integer");
      }
      return { todoId, generation: item.generation };
    });
  }
}

module.exports = TodoReminderRepository;
module.exports.MAX_DUE_REMINDERS = MAX_DUE_REMINDERS;
