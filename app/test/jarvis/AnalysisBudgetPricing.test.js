const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateUsageCostMicrousd,
  ceilTokenCostMicrousd,
} = require("../../src/jarvis/main/AnalysisBudgetPricing");

test("ceil token pricing uses exact BigInt arithmetic at zero, fractional, and million boundaries", () => {
  assert.equal(ceilTokenCostMicrousd(0, 300_000), 0);
  assert.equal(ceilTokenCostMicrousd(1, 300_000), 1);
  assert.equal(ceilTokenCostMicrousd(1, 1_200_000), 2);
  assert.equal(ceilTokenCostMicrousd(1_000_000, 300_000), 300_000);
  assert.equal(
    calculateUsageCostMicrousd(
      { inputTokens: 1_000, outputTokens: 2_048 },
      { inputPerMillionMicrousd: 300_000, outputPerMillionMicrousd: 1_200_000 }
    ),
    2_758
  );
});

test("pricing stays exact near SQLite bounds and rejects unsafe or out-of-schema inputs", () => {
  assert.equal(ceilTokenCostMicrousd(999_999_999, 1_000_000_000), 999_999_999_000);
  assert.equal(
    calculateUsageCostMicrousd(
      { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 },
      {
        inputPerMillionMicrousd: 1_000_000_000,
        outputPerMillionMicrousd: 1_000_000_000,
      }
    ),
    2_000_000_000_000
  );

  for (const invalid of [-1, 0.5, 1_000_000_001, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.throws(() => ceilTokenCostMicrousd(invalid, 1), /tokens/i);
    assert.throws(() => ceilTokenCostMicrousd(1, invalid), /rate/i);
  }
});
