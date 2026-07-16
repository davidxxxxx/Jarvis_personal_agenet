const MAX_TIMEZONE_CODE_POINTS = 64;
const SEARCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MIN_SUPPORTED_YEAR = 1971;
const MAX_SUPPORTED_YEAR = 9998;

const LEGACY_IANA_PRIMARY_NAMES = new Map([
  ["Africa/Asmera", "Africa/Asmara"],
  ["America/Godthab", "America/Nuuk"],
  ["Asia/Calcutta", "Asia/Kolkata"],
  ["Asia/Katmandu", "Asia/Kathmandu"],
  ["Asia/Rangoon", "Asia/Yangon"],
  ["Europe/Kiev", "Europe/Kyiv"],
  ["Pacific/Ponape", "Pacific/Pohnpei"],
  ["Pacific/Truk", "Pacific/Chuuk"],
]);

const formatterCache = new Map();

function assertCanonicalIanaTimezone(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    Array.from(value).length > MAX_TIMEZONE_CODE_POINTS
  ) {
    throw new TypeError("timezone must be a supported canonical IANA timezone");
  }
  let canonical;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new TypeError("timezone must be a supported canonical IANA timezone");
  }
  if (LEGACY_IANA_PRIMARY_NAMES.has(value)) {
    throw new TypeError("timezone must use its canonical IANA name");
  }
  const stableCanonical = LEGACY_IANA_PRIMARY_NAMES.get(canonical) ?? canonical;
  if (stableCanonical !== value) {
    throw new TypeError("timezone must use its canonical IANA name");
  }
  return value;
}

function assertSafeTimestamp(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("at must be a safe integer");
  if (!Number.isFinite(new Date(value).getTime())) throw new RangeError("at is outside Date range");
  return value;
}

function parseMonthKey(value) {
  if (typeof value !== "string") throw new TypeError("monthKey must use YYYY-MM");
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match || Number(match[1]) === 0) throw new TypeError("monthKey must use YYYY-MM");
  const year = Number(match[1]);
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    throw new RangeError(
      `monthKey must use a supported year ${MIN_SUPPORTED_YEAR}-${MAX_SUPPORTED_YEAR}`
    );
  }
  return { year, month: Number(match[2]) };
}

function parseLocalDate(value) {
  if (typeof value !== "string") throw new TypeError("localDate must use YYYY-MM-DD");
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match || Number(match[1]) === 0) {
    throw new TypeError("localDate must use YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    throw new RangeError(
      `localDate must use a supported year ${MIN_SUPPORTED_YEAR}-${MAX_SUPPORTED_YEAR}`
    );
  }
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new TypeError("localDate must be a valid calendar date");
  }
  return { year, month, day };
}

function formatterFor(timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function dateKeyAt(at, timezone) {
  const values = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(at))) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
  }
  if (!values.year || !values.month || !values.day) {
    throw new Error("timezone formatter did not return a complete date");
  }
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

function utcMidnight(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  const value = date.getTime();
  if (!Number.isSafeInteger(value)) throw new RangeError("monthKey is outside Date range");
  return value;
}

function firstInstantOfLocalDate({ year, month, day, timezone }) {
  const target = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const candidate = utcMidnight(year, month, day);
  let low = candidate - SEARCH_WINDOW_MS;
  let high = candidate + SEARCH_WINDOW_MS;
  if (dateKeyAt(low, timezone) >= target || dateKeyAt(high, timezone) < target) {
    throw new RangeError("timezone boundary is outside the supported search window");
  }
  while (low + 1 < high) {
    const midpoint = low + Math.floor((high - low) / 2);
    if (dateKeyAt(midpoint, timezone) < target) low = midpoint;
    else high = midpoint;
  }
  if (dateKeyAt(high, timezone) !== target) {
    throw new RangeError("local calendar date does not exist in timezone");
  }
  return high;
}

function monthKeyAt({ at, timezone }) {
  const safeAt = assertSafeTimestamp(at);
  const safeTimezone = assertCanonicalIanaTimezone(timezone);
  const monthKey = dateKeyAt(safeAt, safeTimezone).slice(0, 7);
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const year = match ? Number(match[1]) : Number.NaN;
  if (!match || year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    throw new RangeError("at is outside the supported range");
  }
  return monthKey;
}

function localDateAt({ at, timezone }) {
  const safeAt = assertSafeTimestamp(at);
  const safeTimezone = assertCanonicalIanaTimezone(timezone);
  const localDate = dateKeyAt(safeAt, safeTimezone);
  const year = Number(localDate.slice(0, 4));
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    throw new RangeError("at is outside the supported range");
  }
  return localDate;
}

function resolveLocalDate({ localDate, timezone }) {
  const { year, month, day } = parseLocalDate(localDate);
  const safeTimezone = assertCanonicalIanaTimezone(timezone);
  const following = new Date(0);
  following.setUTCHours(0, 0, 0, 0);
  following.setUTCFullYear(year, month - 1, day + 1);
  const startsAt = firstInstantOfLocalDate({ year, month, day, timezone: safeTimezone });
  const endsAt = firstInstantOfLocalDate({
    year: following.getUTCFullYear(),
    month: following.getUTCMonth() + 1,
    day: following.getUTCDate(),
    timezone: safeTimezone,
  });
  return { localDate, timezone: safeTimezone, startsAt, endsAt };
}

function resolveLocalMonth({ monthKey, timezone }) {
  const { year, month } = parseMonthKey(monthKey);
  const safeTimezone = assertCanonicalIanaTimezone(timezone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const startsAt = firstInstantOfLocalDate({ year, month, day: 1, timezone: safeTimezone });
  const endsAt = firstInstantOfLocalDate({
    year: nextYear,
    month: nextMonth,
    day: 1,
    timezone: safeTimezone,
  });
  return {
    monthKey,
    timezone: safeTimezone,
    startsAt,
    endsAt,
    durationMs: endsAt - startsAt,
  };
}

module.exports = {
  assertCanonicalIanaTimezone,
  localDateAt,
  monthKeyAt,
  resolveLocalDate,
  resolveLocalMonth,
};
