import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPricingService, validatePriceChange } from "../../apps/api/src/pricing/pricing-service.js";

const PRODUCT_ID = "60000000-0000-4000-8000-000000000001";

test("pricing operator reads production data with the caller token", async () => {
  let received;
  const service = createPricingService({ repository: { listPromotions: async (filters, token) => { received = { filters, token }; return { rows: [] }; } } });
  await service.listPromotions(context("admin_operator_gia_km"), new URLSearchParams("isActive=true&limit=10"));
  assert.equal(received.filters.isActive, "true");
  assert.equal(received.token, "jwt-token");
});

test("price mutation validates reason, price and optimistic version", async () => {
  const service = createPricingService({ repository: { changePrice: async (_id, input) => input } });
  await assert.rejects(() => service.changePrice(context("admin_operator_gia_km"), PRODUCT_ID, { newBasePrice: 100, newSalePrice: -1, reason: "Du ly do cap nhat", expectedVersion: 1 }), (error) => error.status === 422);
  await assert.rejects(() => service.changePrice(context("admin_operator_gia_km"), PRODUCT_ID, { newBasePrice: 100, newSalePrice: 100, reason: "short", expectedVersion: 1 }), (error) => error.status === 422);
  await assert.rejects(() => service.changePrice(context("admin_operator_gia_km"), PRODUCT_ID, { newBasePrice: 100, newSalePrice: 120, reason: "Dieu chinh theo chien dich", expectedVersion: 1 }), (error) => error.status === 422);
  const result = await service.changePrice(context("admin_operator_gia_km"), PRODUCT_ID, { newBasePrice: 150, newSalePrice: 100, reason: "Dieu chinh theo chien dich", expectedVersion: 2 });
  assert.equal(result.newBasePrice, 150);
  assert.equal(result.newSalePrice, 100);
  assert.equal(result.expectedVersion, 2);
});

test("price mutation keeps newPrice alias only as the sale-price fallback", () => {
  const result = validatePriceChange({ newBasePrice: 250000, newPrice: 220000, reason: "Dieu chinh gia niem yet", expectedVersion: 4 });
  assert.equal(result.newBasePrice, 250000);
  assert.equal(result.newSalePrice, 220000);
  assert.equal(result.reason, "Dieu chinh gia niem yet");
});

test("A06 base and sale price migration records full price history", async () => {
  const migration = await readFile(new URL("../../database/migrations/008_uc_a06_base_sale_price_update.sql", import.meta.url), "utf8");
  assert.match(migration, /drop function if exists public\.admin_change_product_price\(uuid, numeric, text, integer, text\)/);
  assert.match(migration, /p_new_base_price numeric/);
  assert.match(migration, /p_new_sale_price numeric/);
  assert.match(migration, /v_before\.base_price,\s+p_new_base_price/);
  assert.match(migration, /base_price = p_new_base_price/);
  assert.match(migration, /sale_price = p_new_sale_price/);
  assert.match(migration, /SALE_PRICE_ABOVE_BASE_PRICE/);
  assert.match(migration, /alter table public\.price_history enable row level security/);
  assert.match(migration, /revoke all on public\.price_history from anon, authenticated/);
});

test("unrelated role cannot read pricing audit logs", async () => {
  const service = createPricingService({ repository: { listAuditLogs: async () => ({}) } });
  await assert.rejects(() => service.listAuditLogs(context("admin_operator_cskh_dt"), new URLSearchParams()), (error) => error.status === 403);
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }
