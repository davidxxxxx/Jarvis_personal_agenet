const Database = require("better-sqlite3");

const { applyJarvisMigrations } = require("./JarvisMigrations");
const { assertCanonicalIanaTimezone, monthKeyAt, resolveLocalMonth } = require("./ZonedCalendar");
const { calculateUsageCostMicrousd } = require("./AnalysisBudgetPricing");

const DEFAULT_MONTHLY_LIMIT_MICROUSD = 5_000_000;
const MAX_MONTHLY_LIMIT_MICROUSD = 10_000_000;

function assertTimestamp(value, name = "at") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertMonthlyLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONTHLY_LIMIT_MICROUSD) {
    throw new TypeError(
      `monthlyLimitMicrousd must be a safe integer from 0 to ${MAX_MONTHLY_LIMIT_MICROUSD}`
    );
  }
  return value;
}

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isBusyError(error) {
  return error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_BUSY_SNAPSHOT";
}

class AnalysisBudgetRepository {
  constructor(db, { ownsDatabase = false } = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
      throw new TypeError("an open better-sqlite3 database is required");
    }
    this.db = db;
    this.ownsDatabase = ownsDatabase;
  }

  close() {
    if (this.ownsDatabase && this.db?.open) this.db.close();
  }

  _immediate(work) {
    try {
      return this.db.transaction(work).immediate();
    } catch (error) {
      if (isBusyError(error)) throw codedError("BUDGET_BUSY", error);
      throw error;
    }
  }

  _settings() {
    return this.db
      .prepare(
        `SELECT active_policy_revision, pending_policy_revision, pending_effective_at
         FROM analysis_budget_settings WHERE singleton_id = 1`
      )
      .get();
  }

  _policy(revision) {
    return this.db
      .prepare(
        `SELECT revision, monthly_limit_microusd, timezone, currency, created_at, effective_at
         FROM analysis_budget_policy_revisions WHERE revision = ?`
      )
      .get(revision);
  }

  _latestPolicy(at) {
    return this.db
      .prepare(
        `SELECT revision, monthly_limit_microusd, timezone, currency, created_at, effective_at
         FROM analysis_budget_policy_revisions
         WHERE effective_at <= ?
         ORDER BY effective_at DESC, revision DESC LIMIT 1`
      )
      .get(at);
  }

  _insertPolicy({ monthlyLimitMicrousd, timezone, createdAt, effectiveAt }) {
    return Number(
      this.db
        .prepare(
          `INSERT INTO analysis_budget_policy_revisions (
             monthly_limit_microusd, timezone, currency, created_at, effective_at
           ) VALUES (?, ?, 'USD', ?, ?)`
        )
        .run(monthlyLimitMicrousd, timezone, createdAt, effectiveAt).lastInsertRowid
    );
  }

  _findPeriod(at) {
    return this.db
      .prepare(
        `SELECT id, month_key, timezone, starts_at, ends_at, currency,
                monthly_limit_microusd, policy_revision, created_at
         FROM analysis_budget_periods
         WHERE starts_at <= ? AND ends_at > ?
         ORDER BY starts_at DESC LIMIT 1`
      )
      .get(at, at);
  }

  _createPeriod({ at, policy }) {
    const monthKey = monthKeyAt({ at, timezone: policy.timezone });
    const natural = resolveLocalMonth({ monthKey, timezone: policy.timezone });
    const previous = this.db
      .prepare(
        `SELECT ends_at FROM analysis_budget_periods
         WHERE ends_at <= ? ORDER BY ends_at DESC LIMIT 1`
      )
      .get(at);
    const startsAt = Math.max(natural.startsAt, previous?.ends_at ?? natural.startsAt);
    const result = this.db
      .prepare(
        `INSERT INTO analysis_budget_periods (
           month_key, timezone, starts_at, ends_at, currency,
           monthly_limit_microusd, policy_revision, created_at
         ) VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)`
      )
      .run(
        monthKey,
        policy.timezone,
        startsAt,
        natural.endsAt,
        policy.monthly_limit_microusd,
        policy.revision,
        at
      );
    return (
      this._findPeriod(at) ?? {
        id: Number(result.lastInsertRowid),
        month_key: monthKey,
        timezone: policy.timezone,
        starts_at: startsAt,
        ends_at: natural.endsAt,
        currency: "USD",
        monthly_limit_microusd: policy.monthly_limit_microusd,
        policy_revision: policy.revision,
        created_at: at,
      }
    );
  }

  _activatePending(settings, at) {
    const pendingMatured =
      settings.pending_policy_revision !== null && at >= settings.pending_effective_at;
    const activePolicy = this._policy(settings.active_policy_revision);
    const latestPolicy = this._latestPolicy(at);
    const latestAdvancesActive =
      latestPolicy &&
      (latestPolicy.effective_at > activePolicy.effective_at ||
        (latestPolicy.effective_at === activePolicy.effective_at &&
          latestPolicy.revision > activePolicy.revision));
    if (!pendingMatured && !latestAdvancesActive) return settings;
    const nextActiveRevision = latestAdvancesActive
      ? latestPolicy.revision
      : settings.pending_policy_revision;
    this.db
      .prepare(
        `UPDATE analysis_budget_settings
         SET active_policy_revision = ?,
             pending_policy_revision = ?,
             pending_effective_at = ?
         WHERE singleton_id = 1`
      )
      .run(
        nextActiveRevision,
        pendingMatured ? null : settings.pending_policy_revision,
        pendingMatured ? null : settings.pending_effective_at
      );
    return this._settings();
  }

  _ensureContext(at) {
    let settings = this._settings();
    if (!settings || settings.active_policy_revision === null) {
      throw codedError("BUDGET_NOT_INITIALIZED");
    }
    settings = this._activatePending(settings, at);
    const activePolicy = this._policy(settings.active_policy_revision);
    const effectivePolicy = this._latestPolicy(at);
    if (!effectivePolicy) throw codedError("BUDGET_NO_EFFECTIVE_POLICY");
    let period = this._findPeriod(at);
    if (!period) period = this._createPeriod({ at, policy: effectivePolicy });
    return { settings, activePolicy, effectivePolicy, period };
  }

  _status(at) {
    const { effectivePolicy, period } = this._ensureContext(at);
    const monthlyLimitMicrousd = effectivePolicy.monthly_limit_microusd;
    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'reconciled' THEN actual_microusd ELSE 0 END), 0)
             AS spent_microusd,
           COALESCE(SUM(CASE WHEN state IN ('reserved','started','usage_unknown')
             THEN reserved_microusd ELSE 0 END), 0) AS reserved_microusd,
           COALESCE(SUM(CASE WHEN state = 'usage_unknown' THEN 1 ELSE 0 END), 0)
             AS unknown_count
         FROM analysis_budget_attempts WHERE period_id = ?`
      )
      .get(period.id);
    const committed = totals.spent_microusd + totals.reserved_microusd;
    const remainingMicrousd = Math.max(0, monthlyLimitMicrousd - committed);
    let blockedReason = null;
    if (totals.unknown_count > 0) blockedReason = "usage_unknown";
    else if (committed > monthlyLimitMicrousd) blockedReason = "over_limit";
    else if (remainingMicrousd === 0) blockedReason = "budget_exceeded";
    return {
      monthKey: period.month_key,
      timezone: period.timezone,
      currency: "USD",
      monthlyLimitMicrousd,
      spentMicrousd: totals.spent_microusd,
      reservedMicrousd: totals.reserved_microusd,
      remainingMicrousd,
      blockedReason,
    };
  }

  _attempt(requestId) {
    return this.db
      .prepare(
        `SELECT request_id, job_id, attempt_number, period_id, policy_revision,
                provider, model, operation, price_version, currency,
                input_per_million_microusd, output_per_million_microusd,
                estimated_input_tokens, estimated_output_tokens, reserved_microusd,
                actual_input_tokens, actual_output_tokens, actual_microusd,
                state, reason_code, created_at, started_at, finalized_at
         FROM analysis_budget_attempts WHERE request_id = ?`
      )
      .get(requestId);
  }

  _price({ provider, model, operation }) {
    return this.db
      .prepare(
        `SELECT provider, model, operation, price_version, currency,
                input_per_million_microusd, output_per_million_microusd
         FROM analysis_budget_price_versions
         WHERE provider = ? AND model = ? AND operation = ?
         ORDER BY created_at DESC, price_version DESC LIMIT 1`
      )
      .get(provider, model, operation);
  }

  _periodTotals(periodId) {
    return this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'reconciled' THEN actual_microusd ELSE 0 END), 0)
             AS spent_microusd,
           COALESCE(SUM(CASE WHEN state IN ('reserved','started','usage_unknown')
             THEN reserved_microusd ELSE 0 END), 0) AS held_microusd,
           COALESCE(SUM(CASE WHEN state = 'usage_unknown' THEN 1 ELSE 0 END), 0)
             AS unknown_count
         FROM analysis_budget_attempts WHERE period_id = ?`
      )
      .get(periodId);
  }

  _matchesReservation(attempt, input) {
    return (
      attempt.job_id === input.jobId &&
      attempt.attempt_number === input.attemptNumber &&
      attempt.provider === input.provider &&
      attempt.model === input.model &&
      attempt.operation === input.operation &&
      attempt.estimated_input_tokens === input.estimatedUsage.inputTokens &&
      attempt.estimated_output_tokens === input.estimatedUsage.outputTokens
    );
  }

  initialize({ monthlyLimitMicrousd = DEFAULT_MONTHLY_LIMIT_MICROUSD, timezone, at }) {
    const safeLimit = assertMonthlyLimit(monthlyLimitMicrousd);
    const safeTimezone = assertCanonicalIanaTimezone(timezone);
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const settings = this._settings();
      if (settings.active_policy_revision === null) {
        const revision = this._insertPolicy({
          monthlyLimitMicrousd: safeLimit,
          timezone: safeTimezone,
          createdAt: safeAt,
          effectiveAt: safeAt,
        });
        this.db
          .prepare(
            `UPDATE analysis_budget_settings SET active_policy_revision = ?
             WHERE singleton_id = 1`
          )
          .run(revision);
      }
      return this._status(safeAt);
    });
  }

  getStatus({ at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => this._status(safeAt));
  }

  setPolicy({ monthlyLimitMicrousd, timezone, at }) {
    const safeLimit = assertMonthlyLimit(monthlyLimitMicrousd);
    const safeTimezone = assertCanonicalIanaTimezone(timezone);
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const context = this._ensureContext(safeAt);
      let activePolicy = context.activePolicy;
      let activeRevision = activePolicy.revision;
      let pendingRevision = context.settings.pending_policy_revision;
      let pendingEffectiveAt = context.settings.pending_effective_at;
      const pendingPolicy = pendingRevision === null ? null : this._policy(pendingRevision);

      if (safeLimit !== activePolicy.monthly_limit_microusd) {
        activeRevision = this._insertPolicy({
          monthlyLimitMicrousd: safeLimit,
          timezone: activePolicy.timezone,
          createdAt: safeAt,
          effectiveAt: safeAt,
        });
        activePolicy = this._policy(activeRevision);
      }

      if (safeTimezone === activePolicy.timezone) {
        if (pendingPolicy && pendingEffectiveAt > safeAt) {
          this._insertPolicy({
            monthlyLimitMicrousd: safeLimit,
            timezone: activePolicy.timezone,
            createdAt: safeAt,
            effectiveAt: pendingEffectiveAt,
          });
        }
        pendingRevision = null;
        pendingEffectiveAt = null;
      } else if (
        !pendingPolicy ||
        pendingPolicy.timezone !== safeTimezone ||
        pendingPolicy.monthly_limit_microusd !== safeLimit ||
        pendingEffectiveAt !== context.period.ends_at
      ) {
        pendingEffectiveAt = context.period.ends_at;
        pendingRevision = this._insertPolicy({
          monthlyLimitMicrousd: safeLimit,
          timezone: safeTimezone,
          createdAt: safeAt,
          effectiveAt: pendingEffectiveAt,
        });
      }

      this.db
        .prepare(
          `UPDATE analysis_budget_settings
           SET active_policy_revision = ?, pending_policy_revision = ?, pending_effective_at = ?
           WHERE singleton_id = 1`
        )
        .run(activeRevision, pendingRevision, pendingEffectiveAt);
      return this._status(safeAt);
    });
  }

  reserve(input) {
    const run = () => {
      const existing = this._attempt(input.requestId);
      if (existing) {
        if (!this._matchesReservation(existing, input)) {
          throw codedError("BUDGET_REQUEST_ID_COLLISION");
        }
        return {
          ok: true,
          requestId: existing.request_id,
          state: existing.state,
          reservedMicrousd: existing.reserved_microusd,
          replayed: true,
        };
      }
      const logicalAttempt = this.db
        .prepare(
          `SELECT request_id FROM analysis_budget_attempts
           WHERE job_id = ? AND attempt_number = ? AND provider = ? AND operation = ?`
        )
        .get(input.jobId, input.attemptNumber, input.provider, input.operation);
      if (logicalAttempt) throw codedError("BUDGET_ATTEMPT_COLLISION");

      const context = this._ensureContext(input.at);
      const policy = context.effectivePolicy;
      const price = this._price(input);
      if (!price) throw codedError("BUDGET_PRICE_NOT_FOUND");
      const reservedMicrousd = calculateUsageCostMicrousd(input.estimatedUsage, {
        inputPerMillionMicrousd: price.input_per_million_microusd,
        outputPerMillionMicrousd: price.output_per_million_microusd,
      });
      const totals = this._periodTotals(context.period.id);
      const committed = totals.spent_microusd + totals.held_microusd;
      const limit = policy.monthly_limit_microusd;
      if (totals.unknown_count > 0) return { ok: false, reason: "usage_unknown" };
      if (committed > limit) return { ok: false, reason: "over_limit" };
      if (committed >= limit || committed + reservedMicrousd > limit) {
        return { ok: false, reason: "budget_exceeded" };
      }

      this.db
        .prepare(
          `INSERT INTO analysis_budget_attempts (
             request_id, job_id, attempt_number, period_id, policy_revision,
             provider, model, operation, price_version, currency,
             input_per_million_microusd, output_per_million_microusd,
             estimated_input_tokens, estimated_output_tokens, reserved_microusd,
             state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, 'reserved', ?)`
        )
        .run(
          input.requestId,
          input.jobId,
          input.attemptNumber,
          context.period.id,
          policy.revision,
          input.provider,
          input.model,
          input.operation,
          price.price_version,
          price.input_per_million_microusd,
          price.output_per_million_microusd,
          input.estimatedUsage.inputTokens,
          input.estimatedUsage.outputTokens,
          reservedMicrousd,
          input.at
        );
      return {
        ok: true,
        requestId: input.requestId,
        state: "reserved",
        reservedMicrousd,
        replayed: false,
      };
    };
    try {
      return this._immediate(run);
    } catch (error) {
      if (error?.code === "BUDGET_BUSY") return { ok: false, reason: "budget_busy" };
      throw error;
    }
  }

  markStarted({ requestId, at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const attempt = this._attempt(requestId);
      if (!attempt) throw codedError("BUDGET_ATTEMPT_NOT_FOUND");
      if (attempt.state === "started") {
        return { ok: true, requestId, state: "started", replayed: true };
      }
      if (attempt.state !== "reserved") throw codedError("BUDGET_INVALID_TRANSITION");
      this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'started', started_at = ?
           WHERE request_id = ? AND state = 'reserved'`
        )
        .run(safeAt, requestId);
      return { ok: true, requestId, state: "started", replayed: false };
    });
  }

  reconcile({ requestId, usage, at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const attempt = this._attempt(requestId);
      if (!attempt) throw codedError("BUDGET_ATTEMPT_NOT_FOUND");
      const actualMicrousd = calculateUsageCostMicrousd(usage, {
        inputPerMillionMicrousd: attempt.input_per_million_microusd,
        outputPerMillionMicrousd: attempt.output_per_million_microusd,
      });
      if (attempt.state === "reconciled") {
        if (
          attempt.actual_input_tokens !== usage.inputTokens ||
          attempt.actual_output_tokens !== usage.outputTokens ||
          attempt.actual_microusd !== actualMicrousd
        ) {
          throw codedError("BUDGET_RECONCILIATION_COLLISION");
        }
        return {
          ok: true,
          requestId,
          state: "reconciled",
          actualMicrousd,
          replayed: true,
        };
      }
      if (attempt.state !== "started") throw codedError("BUDGET_INVALID_TRANSITION");
      this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'reconciled', actual_input_tokens = ?, actual_output_tokens = ?,
               actual_microusd = ?, finalized_at = ?
           WHERE request_id = ? AND state = 'started'`
        )
        .run(usage.inputTokens, usage.outputTokens, actualMicrousd, safeAt, requestId);
      return {
        ok: true,
        requestId,
        state: "reconciled",
        actualMicrousd,
        replayed: false,
      };
    });
  }

  release({ requestId, reasonCode, at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const attempt = this._attempt(requestId);
      if (!attempt) throw codedError("BUDGET_ATTEMPT_NOT_FOUND");
      if (attempt.state === "released") {
        if (attempt.reason_code !== reasonCode) throw codedError("BUDGET_RELEASE_COLLISION");
        return { ok: true, requestId, state: "released", replayed: true };
      }
      if (attempt.state !== "reserved") throw codedError("BUDGET_INVALID_TRANSITION");
      this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'released', reason_code = ?, finalized_at = ?
           WHERE request_id = ? AND state = 'reserved'`
        )
        .run(reasonCode, safeAt, requestId);
      return { ok: true, requestId, state: "released", replayed: false };
    });
  }

  markUsageUnknown({ requestId, reasonCode, at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const attempt = this._attempt(requestId);
      if (!attempt) throw codedError("BUDGET_ATTEMPT_NOT_FOUND");
      if (attempt.state === "usage_unknown") {
        if (attempt.reason_code !== reasonCode) {
          throw codedError("BUDGET_USAGE_UNKNOWN_COLLISION");
        }
        return { ok: true, requestId, state: "usage_unknown", replayed: true };
      }
      if (attempt.state !== "started") throw codedError("BUDGET_INVALID_TRANSITION");
      this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'usage_unknown', reason_code = ?, finalized_at = ?
           WHERE request_id = ? AND state = 'started'`
        )
        .run(reasonCode, safeAt, requestId);
      return { ok: true, requestId, state: "usage_unknown", replayed: false };
    });
  }

  recover({ at }) {
    const safeAt = assertTimestamp(at);
    return this._immediate(() => {
      const released = this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'released', reason_code = 'process_recovery', finalized_at = ?
           WHERE state = 'reserved'`
        )
        .run(safeAt).changes;
      const usageUnknown = this.db
        .prepare(
          `UPDATE analysis_budget_attempts
           SET state = 'usage_unknown', reason_code = 'process_recovery', finalized_at = ?
           WHERE state = 'started'`
        )
        .run(safeAt).changes;
      return { releasedCount: released, usageUnknownCount: usageUnknown };
    });
  }
}

function openAnalysisBudgetRepository(databasePath, { busyTimeoutMs = 250 } = {}) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("databasePath must be a non-empty string");
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 10_000) {
    throw new TypeError("busyTimeoutMs must be a safe integer from 0 to 10000");
  }
  const db = new Database(databasePath);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (databasePath !== ":memory:") db.pragma("journal_mode = WAL");
    applyJarvisMigrations(db);
    return new AnalysisBudgetRepository(db, { ownsDatabase: true });
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = AnalysisBudgetRepository;
module.exports.DEFAULT_MONTHLY_LIMIT_MICROUSD = DEFAULT_MONTHLY_LIMIT_MICROUSD;
module.exports.MAX_MONTHLY_LIMIT_MICROUSD = MAX_MONTHLY_LIMIT_MICROUSD;
module.exports.openAnalysisBudgetRepository = openAnalysisBudgetRepository;
