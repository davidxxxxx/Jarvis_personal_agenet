"use strict";

const ACTIONS = new Set(["edit", "archive", "restore", "delete"]);

function id(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError(`${name} must be a bounded id`);
  }
  return value.trim();
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function title(value) {
  if (typeof value !== "string") throw new TypeError("learning goal title must be a string");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || Array.from(normalized).length > 500) {
    throw new RangeError("learning goal title must contain 1 to 500 characters");
  }
  return normalized;
}

function normalizedTitle(value) {
  return title(value).toLocaleLowerCase("zh-CN");
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    archivedAt: row.archived_at,
  };
}

function eventSnapshot(row) {
  return {
    title: row.title,
    state: row.state,
  };
}

class LearningGoalRepository {
  constructor(db, { createId, now = Date.now } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("an open better-sqlite3 database is required");
    }
    if (typeof createId !== "function") throw new TypeError("createId must be a function");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.db = db;
    this.createId = createId;
    this.now = now;
    this.getStatement = db.prepare("SELECT * FROM learning_goals WHERE id = ?");
    this.findActiveByTitle = db.prepare(`
      SELECT * FROM learning_goals
      WHERE normalized_title = ? AND state <> 'deleted'
      ORDER BY created_at, id LIMIT 1
    `);
    this.listStatement = db.prepare(`
      SELECT * FROM learning_goals
      WHERE state <> 'deleted'
      ORDER BY CASE state WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC, id
    `);
  }

  _appendEvent({ goalId, action, previous, next, at }) {
    this.db
      .prepare(
        `INSERT INTO learning_goal_events (
           id, learning_goal_id, action, previous_json, next_json, actor, occurred_at
         ) VALUES (?, ?, ?, ?, ?, 'user', ?)`
      )
      .run(
        id(this.createId("learning-goal-event"), "learningGoalEventId"),
        goalId,
        action,
        previous === null ? null : JSON.stringify(previous),
        JSON.stringify(next),
        at
      );
  }

  create({ title: rawTitle, at = this.now() } = {}) {
    const goalTitle = title(rawTitle);
    const canonicalTitle = normalizedTitle(goalTitle);
    const occurredAt = timestamp(at, "at");
    const transaction = this.db.transaction(() => {
      const existing = this.findActiveByTitle.get(canonicalTitle);
      if (existing) return { status: "existing", goal: mapRow(existing) };
      const goalId = id(this.createId("learning-goal"), "learningGoalId");
      this.db
        .prepare(
          `INSERT INTO learning_goals (
             id, title, normalized_title, state, created_at, updated_at,
             confirmed_at, archived_at, deleted_at
           ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, NULL, NULL)`
        )
        .run(goalId, goalTitle, canonicalTitle, occurredAt, occurredAt, occurredAt);
      const row = this.getStatement.get(goalId);
      this._appendEvent({
        goalId,
        action: "created",
        previous: null,
        next: eventSnapshot(row),
        at: occurredAt,
      });
      return { status: "created", goal: mapRow(row) };
    });
    return transaction.immediate();
  }

  list() {
    return this.listStatement.all().map(mapRow);
  }

  listConfirmed() {
    return this.list().filter((goal) => goal.state === "confirmed");
  }

  decide({ goalId: rawGoalId, action, title: rawTitle, at = this.now() } = {}) {
    const goalId = id(rawGoalId, "learningGoalId");
    if (!ACTIONS.has(action)) throw new TypeError("learning goal action is invalid");
    const occurredAt = timestamp(at, "at");
    const transaction = this.db.transaction(() => {
      const current = this.getStatement.get(goalId);
      if (!current || current.state === "deleted") {
        throw new Error("learning goal does not exist");
      }
      const previous = eventSnapshot(current);
      let nextTitle = current.title;
      let nextNormalizedTitle = current.normalized_title;
      let nextState = current.state;
      let archivedAt = current.archived_at;
      let deletedAt = current.deleted_at;
      let eventAction =
        action === "edit"
          ? "edited"
          : action === "archive"
            ? "archived"
            : action === "restore"
              ? "restored"
              : "deleted";

      if (action === "edit") {
        nextTitle = title(rawTitle);
        nextNormalizedTitle = normalizedTitle(nextTitle);
      } else if (action === "archive") {
        if (current.state === "archived")
          return { status: "already_archived", goal: mapRow(current) };
        nextState = "archived";
        archivedAt = occurredAt;
      } else if (action === "restore") {
        if (current.state === "confirmed")
          return { status: "already_confirmed", goal: mapRow(current) };
        nextState = "confirmed";
        archivedAt = null;
      } else {
        nextState = "deleted";
        archivedAt = null;
        deletedAt = occurredAt;
      }

      if (
        action === "edit" &&
        nextTitle === current.title &&
        nextNormalizedTitle === current.normalized_title
      ) {
        return { status: "unchanged", goal: mapRow(current) };
      }
      this.db
        .prepare(
          `UPDATE learning_goals
           SET title = ?, normalized_title = ?, state = ?, updated_at = ?,
               archived_at = ?, deleted_at = ?
           WHERE id = ?`
        )
        .run(nextTitle, nextNormalizedTitle, nextState, occurredAt, archivedAt, deletedAt, goalId);
      const next = this.getStatement.get(goalId);
      this._appendEvent({
        goalId,
        action: eventAction,
        previous,
        next: eventSnapshot(next),
        at: occurredAt,
      });
      return { status: eventAction, goal: mapRow(next) };
    });
    return transaction.immediate();
  }
}

module.exports = LearningGoalRepository;
