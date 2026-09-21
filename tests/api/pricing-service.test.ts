import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPricingService, validatePriceChange } from "../../apps/api/src/pricing/pricing-service.js";

const PRODUCT_ID = "60000000-0000-4000-8000-000000000001";
const PROMO_ID = "60000000-0000-4000-8000-000000000002";

test("pricing operator reads production data with the caller token", async () => {
  let received;
  const service = createPricingService({ repository: {
    listPromotions: async (filters, token) => { received = { filters, token }; return { rows: [] }; },
    countVouchersByPromotion: async () => ({}),
    summarizePromotions: async () => ({ rows: [], count: 0 }),
    countActiveVouchers: async () => ({ rows: [], count: 0 })
  } });
  await service.listPromotions(context("admin_operator_gia_km"), new URLSearchParams("isActive=true&limit=10"));
  assert.equal(received.filters.isActive, "true");
  assert.equal(received.token, "jwt-token");
});

test("promotion KPIs count every campaign, not just the page being viewed", async () => {
  // Trang hiện tại chỉ có 1 chiến dịch, nhưng hệ thống có 4. Các chỉ số đầu trang phải
  // nói về cả 4.
  // Vòng đời được tính tại thời điểm chạy thật, nên các mốc phải neo vào hôm nay chứ
  // không phải một ngày cố định trong lịch.
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();
  const allCampaigns = [
    { promo_id: "p1", start_date: at(-10), end_date: at(10), is_active: true, paused_at: null, budget_limit: 1000000, total_discount_issued: 400000 },
    { promo_id: "p2", start_date: at(10), end_date: at(40), is_active: true, paused_at: null, budget_limit: 500000, total_discount_issued: 0 },
    { promo_id: "p3", start_date: at(-90), end_date: at(-60), is_active: true, paused_at: null, budget_limit: 0, total_discount_issued: 90000 },
    { promo_id: "p4", start_date: at(-10), end_date: at(10), is_active: false, paused_at: at(-5), budget_limit: 0, total_discount_issued: 10000 }
  ];

  const service = createPricingService({ repository: {
    listPromotions: async () => ({ rows: [allCampaigns[0]], count: 4 }),
    countVouchersByPromotion: async () => ({}),
    summarizePromotions: async () => ({ rows: allCampaigns, count: 4 }),
    countActiveVouchers: async () => ({ rows: [], count: 7 })
  } });

  const result = await service.listPromotions(context("admin_operator_gia_km"), new URLSearchParams("limit=1"));
  assert.equal(result.rows.length, 1, "danh sách vẫn phân trang");
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.running, 1);
  assert.equal(result.summary.scheduled, 1);
  assert.equal(result.summary.ended, 1);
  assert.equal(result.summary.paused, 1);
  assert.equal(result.summary.activeVouchers, 7);
  // Chỉ hai chiến dịch có đặt trần; hai chiến dịch còn lại `budget_limit = 0` nghĩa là
  // không giới hạn, cộng chúng vào tổng sẽ cho ra một con số bịa.
  assert.equal(result.summary.totalBudget, 1500000);
  assert.equal(result.summary.budgetedCampaigns, 2);
  assert.equal(result.summary.issuedDiscount, 500000);
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

test("product operator can read price history but not promotions", async () => {
  let historyToken;
  const service = createPricingService({
    repository: {
      listPriceHistory: async (_filters, token) => {
        historyToken = token;
        return { rows: [] };
      },
      listPromotions: async () => ({ rows: [] })
    }
  });
  await service.listPriceHistory(context("admin_operator_sanpham"), new URLSearchParams("productId=" + PRODUCT_ID));
  assert.equal(historyToken, "jwt-token");
  await assert.rejects(
    () => service.listPromotions(context("admin_operator_sanpham"), new URLSearchParams()),
    (error) => error.status === 403
  );
});

test("unrelated role cannot read pricing audit logs", async () => {
  const service = createPricingService({ repository: { listAuditLogs: async () => ({}) } });
  await assert.rejects(() => service.listAuditLogs(context("admin_operator_cskh_dt"), new URLSearchParams()), (error) => error.status === 403);
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }

test("a campaign cannot issue more vouchers than its declared ceiling", async () => {
  // `max_vouchers_allowed` được ghi lúc tạo chiến dịch nhưng trước đây chưa ai đọc: trần
  // "tối đa 2 mã" không ngăn được mã thứ 3.
  let created = 0;
  const service = createPricingService({ repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, max_vouchers_allowed: 2 }),
    countVouchersByPromotion: async () => ({ [PROMO_ID]: { total: 2, active: 2 } }),
    createVoucher: async (input) => { created += 1; return input; }
  } });

  await assert.rejects(
    () => service.createVoucher(context("admin_operator_gia_km"), { code: "TET3", type: "percentage", promoId: PROMO_ID }),
    (error) => error.status === 422 && error.code === "VOUCHER_LIMIT_REACHED"
  );
  assert.equal(created, 0);
});

test("no ceiling and a campaign under its ceiling both let the voucher through", async () => {
  const unlimited = createPricingService({ repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, max_vouchers_allowed: 0 }),
    countVouchersByPromotion: async () => ({ [PROMO_ID]: { total: 99, active: 99 } }),
    createVoucher: async (input) => input
  } });
  // `max_vouchers_allowed = 0` nghĩa là không đặt trần, không phải cấm phát mã.
  await unlimited.createVoucher(context("admin_operator_gia_km"), { code: "TET4", type: "percentage", promoId: PROMO_ID });

  const underLimit = createPricingService({ repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, max_vouchers_allowed: 5 }),
    countVouchersByPromotion: async () => ({ [PROMO_ID]: { total: 4, active: 4 } }),
    createVoucher: async (input) => input
  } });
  await underLimit.createVoucher(context("admin_operator_gia_km"), { code: "TET5", type: "percentage", promoId: PROMO_ID });

  // Mã không thuộc chiến dịch nào thì không có trần để xét.
  const standalone = createPricingService({ repository: { createVoucher: async (input) => input } });
  await standalone.createVoucher(context("admin_operator_gia_km"), { code: "TET6", type: "percentage" });
});
