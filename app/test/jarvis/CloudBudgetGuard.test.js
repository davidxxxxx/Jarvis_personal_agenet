const assert = require("node:assert/strict");
const test = require("node:test");

const CloudBudgetGuard = require("../../src/jarvis/main/CloudBudgetGuard");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");

function createGuard(repo, at = Date.UTC(2026, 6, 11)) {
  let nextId = 0;
  return new CloudBudgetGuard({
    repository: repo,
    now: () => at,
    createId: () => `cloud_${++nextId}`,
  });
}

test("settles gpt-4o-transcribe input and output tokens using integer micro-USD", async () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  const guard = createGuard(repo);

  const reservation = await guard.reserve({ audioMs: 12_000 });
  const settled = await guard.settle(reservation.reservationId, {
    type: "tokens",
    input_tokens: 120,
    output_tokens: 18,
    total_tokens: 138,
  });

  assert.equal(settled.ok, true);
  assert.equal(settled.actualMicrousd, 480);
  assert.equal(guard.status().spentMicrousd, 480);
  repo.close();
});

test("serializes simultaneous reservations so only one can consume the last slot", async () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  repo.db.prepare(`
    INSERT INTO cloud_usage (
      id, month_utc, provider, model, audio_ms, input_tokens, output_tokens,
      price_version, reserved_microusd, actual_microusd, status, created_at, settled_at
    ) VALUES ('spent', '2026-07', 'openai', 'gpt-4o-transcribe', 1000, 0, 0,
      'openai-2026-07-11', 0, 4850000, 'settled', 1, 2)
  `).run();
  const guard = createGuard(repo);

  const results = await Promise.all([guard.reserve({ audioMs: 1_000 }), guard.reserve({ audioMs: 1_000 })]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "budget_protected").length, 1);
  repo.close();
});

test("releases a reservation after a failed request", async () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  const guard = createGuard(repo);
  const reservation = await guard.reserve({ audioMs: 2_000 });

  await guard.release(reservation.reservationId);

  assert.equal(guard.status().reservedMicrousd, 0);
  assert.equal(repo.db.prepare("SELECT status FROM cloud_usage WHERE id = ?").get(reservation.reservationId).status, "released");
  repo.close();
});

test("unknown usage marks the month unsafe and blocks every later reservation", async () => {
  const repo = new JarvisRepository(":memory:");
  repo.setCloudBudgetSettings({ enabled: true, monthlyLimitMicrousd: 5_000_000, at: 1 });
  const guard = createGuard(repo);
  const reservation = await guard.reserve({ audioMs: 2_000 });

  const settlement = await guard.settle(reservation.reservationId, { type: "tokens", input_tokens: 10 });
  const blocked = await guard.reserve({ audioMs: 2_000 });

  assert.deepEqual(settlement, { ok: false, reason: "usage_unknown" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "usage_unknown");
  assert.equal(guard.status().blockedReason, "usage_unknown");
  repo.close();
});
