import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_MAINTENANCE_JOBS, runAccountMaintenanceOnce } from "../../apps/api/src/accounts/account-maintenance.js";

test("account maintenance runs expiry, auto-unlock and referral reconcile", async () => {
  const called: string[] = [];
  const failed = await runAccountMaintenanceOnce(async (name) => { called.push(name); return 0; });
  assert.deepEqual(failed, []);
  assert.deepEqual(called, [...ACCOUNT_MAINTENANCE_JOBS]);
  assert.ok(called.includes("velura_auto_unlock_expired_locks"));
});

test("a failing maintenance job does not block the others", async () => {
  const called: string[] = [];
  const origError = console.error;
  console.error = () => undefined;
  try {
    const failed = await runAccountMaintenanceOnce(async (name) => {
      called.push(name);
      if (name === "velura_auto_unlock_expired_locks") throw new Error("boom");
      return 0;
    });
    assert.deepEqual(failed, ["velura_auto_unlock_expired_locks"]);
    assert.equal(called.length, ACCOUNT_MAINTENANCE_JOBS.length);
  } finally {
    console.error = origError;
  }
});

test("migration 105 encodes the BA caps, AUTO_UNLOCK audit and one-flag-per-return rule", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile("database/migrations/105_admin_ba_alignment_accounts_loyalty.sql", "utf8");
  assert.match(sql, /'percentage', 20, 200000, 1000000, 1, 1/);
  assert.match(sql, /interval '60 days'/);
  assert.match(sql, /AUTO_UNLOCK/);
  assert.match(sql, /referral_reward_pending/);
  assert.match(sql, /pl\.return_id=v_operation\.return_id/);
  assert.doesNotMatch(sql, /max_discount_amount\s*=\s*500000/);
});
