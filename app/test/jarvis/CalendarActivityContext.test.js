const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const DatabaseManager = require("../../src/helpers/database");

test("calendar activity context returns only confirmed timed events overlapping the session", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_all_day INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      attendees_count INTEGER,
      hangout_link TEXT,
      conference_data TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO calendar_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    "overlap",
    "2026-08-03T01:00:00.000Z",
    "2026-08-03T02:00:00.000Z",
    0,
    "confirmed",
    "Project sync",
    2,
    null,
    null
  );
  insert.run(
    "cancelled",
    "2026-08-03T01:00:00.000Z",
    "2026-08-03T02:00:00.000Z",
    0,
    "cancelled",
    "Cancelled meeting",
    2,
    null,
    null
  );
  insert.run(
    "all-day",
    "2026-08-03T00:00:00.000Z",
    "2026-08-04T00:00:00.000Z",
    1,
    "confirmed",
    "Holiday",
    0,
    null,
    null
  );

  const manager = Object.create(DatabaseManager.prototype);
  manager.db = db;
  const events = manager.getCalendarEventsOverlapping(
    Date.parse("2026-08-03T01:30:00.000Z"),
    Date.parse("2026-08-03T01:45:00.000Z")
  );

  assert.deepEqual(events, [
    {
      summary: "Project sync",
      attendees_count: 2,
      hangout_link: null,
      conference_data: null,
    },
  ]);
});

test("calendar activity context rejects invalid ranges before querying", () => {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = { prepare: () => assert.fail("invalid ranges must not query SQLite") };

  assert.throws(
    () => manager.getCalendarEventsOverlapping(2_000, 2_000),
    /calendar range must be a positive millisecond interval/u
  );
});
