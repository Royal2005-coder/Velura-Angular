import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = readFile(new URL("../../database/migrations/102_dashboard_ops_parity_and_viewer_read.sql", import.meta.url), "utf8");

test("dashboard operations KPIs count the same population as the screen they link to", async () => {
  const sql = await migration;
  // Orders "Cần xử lý" tab = pending OR attention tag.
  assert.match(sql, /o\.status::text = 'pending'\s+or exists \(select 1 from public\.admin_order_tags t where t\.order_id = o\.order_id and t\.tags <> '\{\}'::text\[\]\)/);
  // Returns link filters status=REQUESTED.
  assert.match(sql, /from public\.return_exchange where status::text = 'REQUESTED'\) as open_returns/);
  // Low stock counts variants with the same rule as admin_list_low_stock (no reserved subtraction, no distinct product).
  assert.match(sql, /from public\.variant where stock_quantity <= low_stock_threshold\) as low_stock_products/);
  assert.doesNotMatch(sql, /count\(distinct product_id\)/);
  // Urgent reviews = unprocessed AND (flagged OR <= 2 stars), as the Reviews urgent tab.
  assert.match(sql, /review where status::text = 'pending' and \(is_flagged_urgent or rating <= 2\)\) as urgent_reviews/);
});

test("viewer read access is added to SELECT policies only", async () => {
  const sql = await migration;
  assert.match(sql, /'admin_viewer'/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all)\b/i);
  assert.doesNotMatch(sql, /admin_viewer'[^)]*\)[^;]*\bwith check\b/i);
});
