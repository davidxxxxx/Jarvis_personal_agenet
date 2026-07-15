const TOKEN_SCALE = 1_000_000n;
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_RATE_MICROUSD = 1_000_000_000;

function assertBoundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at most ${maximum}`);
  }
  return value;
}

function ceilTokenCostMicrousd(tokens, perMillionMicrousd) {
  const safeTokens = assertBoundedInteger(tokens, "tokens", MAX_TOKEN_COUNT);
  const safeRate = assertBoundedInteger(perMillionMicrousd, "rateMicrousd", MAX_RATE_MICROUSD);
  const numerator = BigInt(safeTokens) * BigInt(safeRate);
  const cost = (numerator + TOKEN_SCALE - 1n) / TOKEN_SCALE;
  const result = Number(cost);
  if (!Number.isSafeInteger(result)) throw new RangeError("token cost exceeds safe integer range");
  return result;
}

function calculateUsageCostMicrousd(usage, price) {
  if (!usage || typeof usage !== "object") throw new TypeError("usage is required");
  if (!price || typeof price !== "object") throw new TypeError("price is required");
  const inputCost = ceilTokenCostMicrousd(usage.inputTokens, price.inputPerMillionMicrousd);
  const outputCost = ceilTokenCostMicrousd(usage.outputTokens, price.outputPerMillionMicrousd);
  const total = inputCost + outputCost;
  if (!Number.isSafeInteger(total)) throw new RangeError("usage cost exceeds safe integer range");
  return total;
}

module.exports = {
  MAX_RATE_MICROUSD,
  MAX_TOKEN_COUNT,
  calculateUsageCostMicrousd,
  ceilTokenCostMicrousd,
};
