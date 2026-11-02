import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { budgetReachedMessage, maxVouchersForBudget, voucherCapacity, voucherMaxDiscount } from "../../apps/api/src/pricing/voucher-budget.js";
import { generateVoucherCode, generateVouchersBulk, normalizeVoucherPrefix, MAX_COLLISION_RETRIES } from "../../apps/api/src/pricing/voucher-bulk.js";
import { createPricingService } from "../../apps/api/src/pricing/pricing-service.js";
import { HttpError } from "../../apps/api/src/http.js";
import { capabilitiesForRole } from "../../apps/api/src/rbac.js";
import { SHIPPING_CONFIG } from "../../apps/api/src/shipping-config.js";
import { FREESHIP_THRESHOLD } from "../../apps/api/src/user/order-pricing.js";

const PROMO_ID = "60000000-0000-4000-8000-000000000002";
const ctx = (roleCode: string) => ({ authUser: { id: "u" }, roleCode, accessToken: "jwt", ipAddress: "1.1.1.1" }) as never;

/** RNG có thứ tự nhưng không lặp lại sớm: mỗi lần gọi trả một giá trị khác, trải đều trong [0, 1). */
function seqRng(values: number[]) {
  let i = 0;
  return () => {
    const base = values[i % values.length];
    i += 1;
    return (base + i * 0.0137) % 1;
  };
}

test("maxVouchersForBudget làm tròn xuống ngân sách chia trần giảm", () => {
  assert.equal(maxVouchersForBudget(1_000_000, 30_000), 33);
  assert.equal(maxVouchersForBudget(100_000, 100_000), 1);
  assert.equal(maxVouchersForBudget(99_999, 100_000), 0);
});

test("maxVouchersForBudget: không ngân sách hoặc không trần thì không tính được", () => {
  assert.equal(maxVouchersForBudget(0, 30_000), null);
  assert.equal(maxVouchersForBudget(-5, 30_000), null);
  assert.equal(maxVouchersForBudget(1_000_000, null), null);
  assert.equal(maxVouchersForBudget(1_000_000, 0), null);
  assert.equal(maxVouchersForBudget(Number.NaN, 10), null);
});

test("voucherMaxDiscount: cố định lấy giá trị (bị chặn bởi trần), phần trăm cần trần", () => {
  assert.equal(voucherMaxDiscount({ type: "fixed_amount", value: 50_000, maxDiscount: null }), 50_000);
  assert.equal(voucherMaxDiscount({ type: "fixed_amount", value: 50_000, maxDiscount: 20_000 }), 20_000);
  assert.equal(voucherMaxDiscount({ type: "percentage", value: 10, maxDiscount: null }), null);
  assert.equal(voucherMaxDiscount({ type: "percentage", value: 10, maxDiscount: 40_000 }), 40_000);
  assert.equal(voucherMaxDiscount({ type: "free_shipping", value: 0, maxDiscount: null }), SHIPPING_CONFIG.expressFee);
});

test("voucherCapacity: còn lại, không giới hạn, và mã phần trăm không trần bị gắn cờ", () => {
  assert.deepEqual(voucherCapacity(1_000_000, 100_000, 3), { status: "limited", max: 10, issued: 3, remaining: 7 });
  assert.deepEqual(voucherCapacity(1_000_000, 100_000, 12), { status: "limited", max: 10, issued: 12, remaining: 0 });
  assert.deepEqual(voucherCapacity(0, null, 5), { status: "unlimited" });
  assert.deepEqual(voucherCapacity(1_000_000, null, 0), { status: "cap_required" });
  assert.equal(budgetReachedMessage(10, 10), "Đã phát 10/10 mã, chạm trần ngân sách");
});

test("FREESHIP_THRESHOLD đọc từ cấu hình duy nhất", () => {
  assert.equal(FREESHIP_THRESHOLD, SHIPPING_CONFIG.freeShipThreshold);
});

test("generateVoucherCode dùng RNG truyền vào và tiền tố đã chuẩn hoá", () => {
  assert.equal(generateVoucherCode("TET", () => 0), "TETAAAAAA");
  assert.equal(normalizeVoucherPrefix(" tet "), "TET");
  assert.equal(normalizeVoucherPrefix("a"), null);
  assert.equal(normalizeVoucherPrefix("có dấu"), null);
});

test("sinh hàng loạt: trùng mã thì thử lại rồi vẫn tạo đủ", async () => {
  const taken = new Set(["TETAAAAAA"]);
  const made: string[] = [];
  const result = await generateVouchersBulk({
    prefix: "TET",
    quantity: 1,
    rng: seqRng([0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    createCode: async (code) => {
      if (taken.has(code)) return { ok: false, collision: true, reason: "VOUCHER_CODE_EXISTS" };
      made.push(code);
      return { ok: true };
    }
  });
  assert.equal(result.complete, true);
  assert.equal(result.created.length, 1);
  assert.notEqual(made[0], "TETAAAAAA");
});

test("sinh hàng loạt: trùng quá số lần thử lại thì dừng và giữ mã đã tạo", async () => {
  let calls = 0;
  const result = await generateVouchersBulk({
    prefix: "TET",
    quantity: 3,
    rng: seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    createCode: async () => {
      calls += 1;
      return calls === 1 ? { ok: true } : { ok: false, collision: true, reason: "VOUCHER_CODE_EXISTS" };
    }
  });
  assert.equal(result.complete, false);
  assert.equal(result.created.length, 1);
  assert.ok(result.failure);
  // 1 mã thành công, rồi mã thứ hai: lần đầu + MAX_COLLISION_RETRIES lần thử lại.
  assert.equal(calls, 1 + 1 + MAX_COLLISION_RETRIES);
});

test("sinh hàng loạt: lỗi không phải trùng mã thì dừng ngay", async () => {
  let calls = 0;
  const result = await generateVouchersBulk({
    prefix: "TET",
    quantity: 5,
    createCode: async () => {
      calls += 1;
      return calls < 3 ? { ok: true } : { ok: false, collision: false, reason: "VOUCHER_BUDGET_REACHED" };
    }
  });
  assert.equal(result.created.length, 2);
  assert.equal(calls, 3);
  assert.equal(result.failure?.reason, "VOUCHER_BUDGET_REACHED");
});

test("service: sinh hàng loạt vượt trần ngân sách bị từ chối trước khi tạo mã nào", async () => {
  let created = 0;
  const service = createPricingService({ repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, budget_limit: 1_000_000, max_vouchers_allowed: 0 }),
    countVouchersByPromotion: async () => ({ [PROMO_ID]: { total: 8, active: 8 } }),
    createVoucher: async () => { created += 1; return {}; }
  } as never });
  await assert.rejects(
    () => service.createVouchersBulk(ctx("admin_operator_gia_km"), {
      promoId: PROMO_ID, prefix: "TET", quantity: 5, type: "fixed_amount", discountValue: 100_000,
      startDate: "2026-11-01", endDate: "2026-12-01"
    }),
    (error: HttpError) => error.status === 422 && error.code === "VOUCHER_BUDGET_REACHED" && /8\/10/.test(error.message)
  );
  assert.equal(created, 0);
});

test("service: mã phần trăm không trần trong chiến dịch có ngân sách bị từ chối", async () => {
  const service = createPricingService({ repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, budget_limit: 500_000, max_vouchers_allowed: 0 }),
    countVouchersByPromotion: async () => ({}),
    createVoucher: async () => ({})
  } as never });
  await assert.rejects(
    () => service.createVouchersBulk(ctx("admin_operator_gia_km"), {
      promoId: PROMO_ID, prefix: "TET", quantity: 1, type: "percentage", discountValue: 10
    }),
    (error: HttpError) => error.code === "VOUCHER_CAP_REQUIRED"
  );
});

test("service: sinh hàng loạt giữ mã đã tạo và ghi nhật ký khi lỗi giữa chừng", async () => {
  let n = 0;
  let logged: Record<string, unknown> | undefined;
  const service = createPricingService({ rng: seqRng([0.11, 0.22, 0.33, 0.44, 0.55, 0.66]), repository: {
    getPromotion: async () => ({ promo_id: PROMO_ID, budget_limit: 0, max_vouchers_allowed: 0 }),
    countVouchersByPromotion: async () => ({}),
    createVoucher: async () => {
      n += 1;
      if (n === 3) throw new HttpError(422, "VOUCHER_BUDGET_REACHED", "hết");
      return {};
    },
    logVoucherBulkFailure: async (input: Record<string, unknown>) => { logged = input; }
  } as never });
  const result = await service.createVouchersBulk(ctx("admin_operator_gia_km"), {
    promoId: PROMO_ID, prefix: "tet", quantity: 5, type: "fixed_amount", discountValue: 10_000
  }) as { created: string[]; complete: boolean };
  assert.equal(result.complete, false);
  assert.equal(result.created.length, 2);
  assert.equal(logged?.created, 2);
  assert.equal(logged?.requested, 5);
  assert.equal(logged?.prefix, "TET");
});

test("service: RPC chạm trần thì thông báo có dạng Đã phát X/Y mã", async () => {
  const service = createPricingService({ repository: {
    createVoucher: async () => { throw new HttpError(422, "VOUCHER_BUDGET_REACHED", "gốc"); },
    getPromotion: async () => ({ promo_id: PROMO_ID, budget_limit: 300_000, max_vouchers_allowed: 0 }),
    countVouchersByPromotion: async () => ({ [PROMO_ID]: { total: 3, active: 3 } })
  } as never });
  await assert.rejects(
    () => service.createVoucher(ctx("admin_operator_gia_km"), { code: "ABC", type: "fixed_amount", value: 100_000, promoId: PROMO_ID }),
    (error: HttpError) => error.message === "Đã phát 3/3 mã, chạm trần ngân sách"
  );
});

test("viewer đọc được thống kê, danh sách chiến dịch và mã nhưng không ghi được", async () => {
  const service = createPricingService({ repository: {
    getStatistics: async () => ({}),
    summarizePromotions: async () => ({ rows: [] }),
    countActiveVouchers: async () => ({ count: 0 }),
    listPromotions: async () => ({ rows: [] }),
    countVouchersByPromotion: async () => ({}),
    listVouchers: async () => ({ rows: [] }),
    createVoucher: async () => { throw new Error("không được ghi"); },
    createPromotion: async () => { throw new Error("không được ghi"); }
  } as never });
  const viewer = ctx("admin_viewer");
  await service.getStatistics(viewer);
  await service.listPromotions(viewer, new URLSearchParams());
  await service.listVouchers(viewer, new URLSearchParams());
  for (const write of [
    () => service.createVoucher(viewer, { code: "X", type: "fixed_amount", value: 1 }),
    () => service.createVouchersBulk(viewer, { promoId: PROMO_ID, prefix: "TET", quantity: 1, type: "fixed_amount" }),
    () => service.createPromotion(viewer, { name: "Chiến dịch thử nghiệm" }),
    () => service.toggleVoucher(viewer, PROMO_ID)
  ]) {
    await assert.rejects(write, (error: HttpError) => error.status === 403);
  }
  // Nhật ký vẫn không mở cho viewer.
  await assert.rejects(() => service.listAuditLogs(viewer, new URLSearchParams()), (error: HttpError) => error.status === 403);
});

test("rbac: viewer có quyền đọc promotions nhưng không có create/update", () => {
  const caps = capabilitiesForRole("admin_viewer");
  assert.deepEqual(caps.promotions, ["read"]);
  assert.deepEqual(caps.vouchers, ["read"]);
});

test("migration 103 mở thống kê cho viewer qua hàm đọc riêng, ghi vẫn qua hàm admin", async () => {
  const sql = await readFile(new URL("../../database/migrations/103_promotion_voucher_budget_stats_readonly.sql", import.meta.url), "utf8");
  assert.match(sql, /velura_require_pricing_reader/);
  assert.match(sql, /'super_admin', 'admin_operator_gia_km', 'admin_viewer'/);
  assert.match(sql, /admin_promotion_statistics[\s\S]*velura_require_pricing_reader\(\)/);
  assert.match(sql, /VOUCHER_BUDGET_REACHED/);
  assert.match(sql, /floor\(v_promotion\.budget_limit \/ v_cap\)/);
  assert.match(sql, /for update/);
});
