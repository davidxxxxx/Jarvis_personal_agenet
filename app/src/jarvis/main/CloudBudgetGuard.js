const RESERVATION_MICROUSD = 100_000;
const DEFAULT_LIMIT_MICROUSD = 5_000_000;
const MIN_LIMIT_MICROUSD = 5_000_000;
const MAX_LIMIT_MICROUSD = 10_000_000;
const MODEL = "gpt-4o-transcribe";
const PRICE = Object.freeze({
  version: "openai-2026-07-11",
  inputPerMillion: 2_500_000,
  outputPerMillion: 10_000_000,
});

function tokenCostMicrousd(tokens, pricePerMillion) {
  if (!Number.isSafeInteger(tokens) || tokens < 0) return null;
  return Math.ceil((tokens * pricePerMillion) / 1_000_000);
}

class CloudBudgetGuard {
  constructor({ repository, now = Date.now, createId }) {
    for (const method of [
      "getCloudBudgetStatus",
      "reserveCloudUsage",
      "settleCloudUsage",
      "releaseCloudUsage",
      "markCloudUsageUnknown",
    ]) {
      if (!repository || typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} must be a function`);
      }
    }
    if (typeof now !== "function" || typeof createId !== "function") {
      throw new TypeError("budget clock and id factory are required");
    }
    this.repository = repository;
    this.now = now;
    this.createId = createId;
    this.tail = Promise.resolve();
  }

  _enqueue(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  reserve({ audioMs }) {
    return this._enqueue(() => {
      if (!Number.isSafeInteger(audioMs) || audioMs < 0) {
        throw new TypeError("audioMs must be a non-negative safe integer");
      }
      const createdAt = this.now();
      const monthUtc = new Date(createdAt).toISOString().slice(0, 7);
      return this.repository.reserveCloudUsage({
        id: this.createId(),
        monthUtc,
        model: MODEL,
        audioMs,
        reservedMicrousd: RESERVATION_MICROUSD,
        priceVersion: PRICE.version,
        createdAt,
      });
    });
  }

  settle(reservationId, usage) {
    return this._enqueue(() => {
      const inputCost = tokenCostMicrousd(usage?.input_tokens, PRICE.inputPerMillion);
      const outputCost = tokenCostMicrousd(usage?.output_tokens, PRICE.outputPerMillion);
      if (usage?.type !== "tokens" || inputCost === null || outputCost === null) {
        this.repository.markCloudUsageUnknown({ id: reservationId, settledAt: this.now() });
        return { ok: false, reason: "usage_unknown" };
      }
      const actualMicrousd = inputCost + outputCost;
      if (actualMicrousd > RESERVATION_MICROUSD) {
        this.repository.markCloudUsageUnknown({ id: reservationId, settledAt: this.now() });
        return { ok: false, reason: "usage_unknown" };
      }
      this.repository.settleCloudUsage({
        id: reservationId,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        actualMicrousd,
        settledAt: this.now(),
      });
      return { ok: true, actualMicrousd };
    });
  }

  release(reservationId) {
    return this._enqueue(() => {
      this.repository.releaseCloudUsage({ id: reservationId, settledAt: this.now() });
      return { ok: true };
    });
  }

  status(at = this.now()) {
    return this.repository.getCloudBudgetStatus(at);
  }
}

module.exports = CloudBudgetGuard;
module.exports.DEFAULT_LIMIT_MICROUSD = DEFAULT_LIMIT_MICROUSD;
module.exports.MAX_LIMIT_MICROUSD = MAX_LIMIT_MICROUSD;
module.exports.MIN_LIMIT_MICROUSD = MIN_LIMIT_MICROUSD;
module.exports.PRICE = PRICE;
module.exports.RESERVATION_MICROUSD = RESERVATION_MICROUSD;
