import test from "node:test";
import assert from "node:assert/strict";
import { toVoucherCard, voucherGroup } from "../../apps/api/src/user/offers.js";

const NOW = new Date("2026-10-10T00:00:00Z");
const inDays = (days) => new Date(NOW.getTime() + days * 86400000).toISOString();

function evaluated(overrides = {}) {
  return {
    voucherId: "v1", promoId: null, code: "AO20", name: "Giảm 20% áo", discountType: "percentage",
    discountValue: 20, maxDiscountAmount: 100000, minOrderValue: 300000, startDate: inDays(-5), endDate: inDays(20),
    remainingUses: null, eligible: false, discountAmount: 0, reason: null, reasonText: null, shortfall: null,
    categoryNames: [], audience: "all_users", ...overrides
  };
}

test("a category voucher is not shown as blocked on the Offers page before any cart exists", () => {
  // Trang Ưu đãi chấm mã với giỏ rỗng. Mã theo danh mục khi đó luôn "giỏ chưa có sản phẩm
  // phù hợp" — đó không phải lý do chặn, chỉ là chưa có giỏ.
  const card = toVoucherCard(evaluated({
    categoryNames: ["Áo"], reason: "CATEGORY_MISMATCH", reasonText: "Mã chỉ áp cho Áo, giỏ hàng chưa có sản phẩm phù hợp."
  }), NOW, true);
  assert.equal(card.usable, true);
  assert.equal(card.blocked_reason, null);
  assert.deepEqual(card.category_names, ["Áo"]);
  assert.match(String(card.condition_text), /Áp cho Áo/);
});

test("a voucher blocked for a real reason keeps its reason", () => {
  const card = toVoucherCard(evaluated({ reason: "USAGE_EXHAUSTED", reasonText: "Mã đã hết lượt sử dụng trên hệ thống." }), NOW, true);
  assert.equal(card.usable, false);
  assert.equal(card.blocked_reason, "Mã đã hết lượt sử dụng trên hệ thống.");
});

test("offers group: ending soon first, then codes aimed at this member, then the rest", () => {
  assert.equal(voucherGroup(evaluated({ endDate: inDays(2) }), true, true, NOW), "ending");
  assert.equal(voucherGroup(evaluated({ audience: "member" }), true, true, NOW), "personal");
  // Mã mở cho mọi khách không phải "dành riêng cho bạn", dù khách đã đăng nhập.
  assert.equal(voucherGroup(evaluated({ audience: "all_users" }), true, true, NOW), "running");
  // Khách vãng lai không có nhóm cá nhân.
  assert.equal(voucherGroup(evaluated({ audience: "guest" }), true, false, NOW), "running");
});
