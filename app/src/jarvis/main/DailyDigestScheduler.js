const { assertId } = require("../shared/contracts");
const {
  assertCanonicalIanaTimezone,
  localDateAt,
  resolveLocalDate,
} = require("./ZonedCalendar");

const MAX_SESSION_DAYS = 366;

function requiredMethod(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} must be a function`);
  }
}

function exactLocalDateInput(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, "localDate")
  ) {
    throw new TypeError(`${name} must contain only localDate`);
  }
  return value;
}

function timestamp(value, name = "scheduler clock") {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${name} must be a supported safe integer`);
  }
  return value;
}

class DailyDigestScheduler {
  constructor({
    service,
    repository,
    timezoneProvider,
    now = Date.now,
    maxCatchupDays = 31,
    log = () => {},
  } = {}) {
    for (const method of ["prepare", "getLatest", "regenerate"]) {
      requiredMethod(service, method, "service");
    }
    requiredMethod(repository, "getSession", "repository");
    if (typeof timezoneProvider !== "function") {
      throw new TypeError("timezoneProvider must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(maxCatchupDays) || maxCatchupDays < 1 || maxCatchupDays > 31) {
      throw new TypeError("maxCatchupDays must be a safe integer from 1 to 31");
    }
    if (typeof log !== "function") throw new TypeError("log must be a function");
    this.service = service;
    this.repository = repository;
    this.timezoneProvider = timezoneProvider;
    this.now = now;
    this.maxCatchupDays = maxCatchupDays;
    this.log = log;
    this.active = false;
    this.epoch = 0;
    this.tail = Promise.resolve();
    this.startPromise = null;
    this.stopPromise = null;
    this.observedTimezone = null;
    this.observedLocalDate = null;
  }

  _timezone() {
    return assertCanonicalIanaTimezone(this.timezoneProvider());
  }

  _now() {
    return timestamp(this.now());
  }

  _serialize(operation, epoch = this.epoch) {
    const result = this.tail.then(() => {
      if (!this.active || this.epoch !== epoch) return [];
      return operation();
    });
    this.tail = result.catch((error) => {
      this.log(error);
    });
    return result;
  }

  async _prepareDate(localDate) {
    const result = await Promise.resolve(this.service.prepare({ localDate }));
    return { ...result, localDate };
  }

  async _initializeZone({ at, timezone }) {
    const currentLocalDate = localDateAt({ at, timezone });
    const { startsAt } = resolveLocalDate({ localDate: currentLocalDate, timezone });
    const previousLocalDate = localDateAt({ at: startsAt - 1, timezone });
    const result = await this._prepareDate(previousLocalDate);
    this.observedTimezone = timezone;
    this.observedLocalDate = currentLocalDate;
    return [result];
  }

  async _catchUp({ at, timezone }) {
    if (this.observedTimezone !== timezone || this.observedLocalDate === null) {
      return this._initializeZone({ at, timezone });
    }
    const results = [];
    while (results.length < this.maxCatchupDays) {
      const boundary = resolveLocalDate({
        localDate: this.observedLocalDate,
        timezone,
      });
      if (boundary.endsAt > at) break;
      results.push(await this._prepareDate(this.observedLocalDate));
      this.observedLocalDate = localDateAt({ at: boundary.endsAt, timezone });
    }
    return results;
  }

  start() {
    if (this.active) return this.startPromise;
    this.active = true;
    this.epoch += 1;
    this.stopPromise = null;
    const epoch = this.epoch;
    this.startPromise = this._serialize(() => {
      const at = this._now();
      const timezone = this._timezone();
      return this.observedLocalDate === null
        ? this._initializeZone({ at, timezone })
        : this._catchUp({ at, timezone });
    }, epoch);
    return this.startPromise;
  }

  tick() {
    if (!this.active) return Promise.resolve([]);
    return this._serialize(() => this._catchUp({ at: this._now(), timezone: this._timezone() }));
  }

  onSessionReady(sessionId) {
    const id = assertId(sessionId, "sessionId");
    if (!this.active) return Promise.resolve([]);
    return this._serialize(async () => {
      const session = this.repository.getSession(id);
      if (
        !session ||
        !["completed", "recovered"].includes(session.status) ||
        session.processing_state !== "ready"
      ) {
        return [];
      }
      const startedAt = timestamp(session.started_at, "session.started_at");
      const endedAt = timestamp(session.ended_at, "session.ended_at");
      if (endedAt <= startedAt) throw new TypeError("ready session must have a positive interval");
      const timezone = this._timezone();
      const lastLocalDate = localDateAt({ at: endedAt - 1, timezone });
      let cursor = localDateAt({ at: startedAt, timezone });
      const results = [];
      while (true) {
        results.push(await this._prepareDate(cursor));
        if (cursor === lastLocalDate) return results;
        if (results.length >= MAX_SESSION_DAYS) {
          throw new RangeError("ready session spans too many local dates");
        }
        const { endsAt } = resolveLocalDate({ localDate: cursor, timezone });
        cursor = localDateAt({ at: endsAt, timezone });
      }
    });
  }

  getLatest(input) {
    const request = exactLocalDateInput(input, "daily digest latest input");
    resolveLocalDate({ localDate: request.localDate, timezone: this._timezone() });
    return this.service.getLatest(request);
  }

  getPublicStatus(input) {
    const request = exactLocalDateInput(input, "daily digest status input");
    resolveLocalDate({ localDate: request.localDate, timezone: this._timezone() });
    if (typeof this.service.getPublicStatus !== "function") {
      return Object.freeze({
        state: "not_generated",
        retryable: false,
        errorCode: null,
        nextRetryAt: null,
        attemptCount: 0,
      });
    }
    return this.service.getPublicStatus(request);
  }

  regenerate(input) {
    const request = exactLocalDateInput(input, "daily digest regenerate input");
    resolveLocalDate({ localDate: request.localDate, timezone: this._timezone() });
    if (!this.active) {
      const error = new Error("daily digest runtime is unavailable");
      error.code = "DAILY_DIGEST_RUNTIME_UNAVAILABLE";
      return Promise.reject(error);
    }
    return this._serialize(() => this.service.regenerate(request));
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.active = false;
    this.startPromise = null;
    this.stopPromise = this.tail.then(() => undefined);
    return this.stopPromise;
  }
}

module.exports = DailyDigestScheduler;
