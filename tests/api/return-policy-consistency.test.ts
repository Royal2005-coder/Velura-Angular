import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RETURN_WINDOW_DAYS, returnWindowOpen } from "../../apps/api/src/user/return-window.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the return window is the single 7-day decision across API, database and screens", () => {
  assert.equal(RETURN_WINDOW_DAYS, 7);
  const delivered = new Date("2026-11-01T00:00:00Z");
  assert.equal(returnWindowOpen(delivered, new Date("2026-11-08T00:00:00Z")), true);
  assert.equal(returnWindowOpen(delivered, new Date("2026-11-08T00:00:01Z")), false);
  assert.match(read("database/migrations/085_return_intake_policy.sql"), /interval '7 days'/);
  assert.match(read("apps/admin-erp-ng/src/app/core/admin-erp-service-desk.ts"), /RETURN_WINDOW_DAYS = 7;/);
  assert.match(read("apps/user-ng/src/app/features/account/order-flow.page.ts"), /RETURN_WINDOW_DAYS = 7;/);
  for (const file of [
    "apps/user-ng/src/app/features/account/order-flow.page.html",
    "apps/user-ng/src/app/features/cart/cart.page.html",
    "apps/user-ng/src/app/features/content/policies.page.html",
    "apps/user-ng/src/app/features/products/product-detail.page.html",
    "apps/api/src/products/product-ai-studio.ts"
  ]) {
    assert.doesNotMatch(read(file), /đổi\s*(\/\s*)?trả[^.\n]{0,40}30 ngày|30 ngày[^.\n]{0,40}đổi\s*(\/\s*)?trả/i, file);
  }
});

test("migration 101 removes the quality gate, allows partial receipt and stopping in transit, and stores the refund SLA", () => {
  const sql = read("database/migrations/101_return_receive_partial_stop_refund_sla.sql");
  assert.match(sql, /INVALID_RECEIVED_QUANTITY/);
  assert.doesNotMatch(sql, /WAREHOUSE_LINE_MISMATCH|RECEIPT_FACTS_REQUIRED/);
  assert.doesNotMatch(sql, /i\.matches_product is distinct from true/);
  assert.match(sql, /if stage='RETURN_SHIPPING' then[\s\S]{0,400}RETURN_PART_ALREADY_COMMITTED/);
  assert.match(sql, /'customer_stopped'/);
  assert.match(sql, /'missing_goods'/);
  assert.match(sql, /velura_add_working_days\(now\(\),due_days\)/);
  assert.match(sql, /refund_due_at/);
  assert.doesNotMatch(sql, /interval '30 days'/);
});
