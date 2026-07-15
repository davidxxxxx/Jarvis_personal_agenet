const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertCanonicalIanaTimezone,
  monthKeyAt,
  resolveLocalMonth,
} = require("../../src/jarvis/main/ZonedCalendar");

const HOUR_MS = 60 * 60 * 1000;

test("canonical IANA zones are accepted while aliases and invalid zones are rejected", () => {
  assert.equal(assertCanonicalIanaTimezone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(assertCanonicalIanaTimezone("UTC"), "UTC");
  assert.equal(assertCanonicalIanaTimezone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(assertCanonicalIanaTimezone("Europe/Kyiv"), "Europe/Kyiv");
  assert.throws(() => assertCanonicalIanaTimezone("Asia/Calcutta"), /canonical/i);
  assert.throws(() => assertCanonicalIanaTimezone("Europe/Kiev"), /canonical/i);
  assert.throws(() => assertCanonicalIanaTimezone("US/Pacific"), /canonical/i);
  assert.throws(() => assertCanonicalIanaTimezone("Mars/Olympus"), /IANA/i);
  assert.throws(() => assertCanonicalIanaTimezone(" Asia/Shanghai "), /IANA/i);
});

test("Asia Shanghai month boundaries are exact half-open UTC instants", () => {
  assert.deepEqual(resolveLocalMonth({ monthKey: "2026-07", timezone: "Asia/Shanghai" }), {
    monthKey: "2026-07",
    timezone: "Asia/Shanghai",
    startsAt: Date.UTC(2026, 5, 30, 16),
    endsAt: Date.UTC(2026, 6, 31, 16),
    durationMs: 31 * 24 * HOUR_MS,
  });
  assert.equal(
    monthKeyAt({ at: Date.UTC(2026, 5, 30, 15, 59, 59, 999), timezone: "Asia/Shanghai" }),
    "2026-06"
  );
  assert.equal(monthKeyAt({ at: Date.UTC(2026, 5, 30, 16), timezone: "Asia/Shanghai" }), "2026-07");
});

test("DST spring and fall months use 23-hour and 25-hour transition days", () => {
  const spring = resolveLocalMonth({ monthKey: "2026-03", timezone: "America/Los_Angeles" });
  const fall = resolveLocalMonth({ monthKey: "2026-11", timezone: "America/Los_Angeles" });

  assert.equal(spring.startsAt, Date.UTC(2026, 2, 1, 8));
  assert.equal(spring.endsAt, Date.UTC(2026, 3, 1, 7));
  assert.equal(spring.durationMs, (31 * 24 - 1) * HOUR_MS);
  assert.equal(fall.startsAt, Date.UTC(2026, 10, 1, 7));
  assert.equal(fall.endsAt, Date.UTC(2026, 11, 1, 8));
  assert.equal(fall.durationMs, (30 * 24 + 1) * HOUR_MS);
});

test("month keys and timestamps reject normalization and unsafe values", () => {
  for (const monthKey of ["2026-00", "2026-13", "2026-7", "2026-07-01", 202607]) {
    assert.throws(() => resolveLocalMonth({ monthKey, timezone: "UTC" }), /monthKey/i);
  }
  assert.throws(
    () => monthKeyAt({ at: Number.MAX_SAFE_INTEGER + 1, timezone: "UTC" }),
    /safe integer/i
  );
  assert.throws(() => monthKeyAt({ at: -1, timezone: "UTC" }), /supported range/i);
  assert.throws(
    () => monthKeyAt({ at: Date.UTC(10_000, 0, 1), timezone: "UTC" }),
    /supported range/i
  );
  assert.throws(
    () => resolveLocalMonth({ monthKey: "1969-12", timezone: "UTC" }),
    /supported year/i
  );
  assert.throws(
    () => resolveLocalMonth({ monthKey: "1970-01", timezone: "Asia/Shanghai" }),
    /supported year/i
  );
  assert.throws(
    () => resolveLocalMonth({ monthKey: "9999-12", timezone: "UTC" }),
    /supported year/i
  );
});
