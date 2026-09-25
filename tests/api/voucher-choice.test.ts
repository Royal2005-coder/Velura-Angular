import test from "node:test";
import assert from "node:assert/strict";
import { chooseOrderVoucher, readVoucherRequest } from "../../apps/api/src/user/voucher-choice.js";
import { summarizeQuote } from "../../apps/api/src/user/checkout-quote.js";
import { evaluateVouchers, pickBestVoucher } from "../../apps/api/src/user/voucher-engine.js";

const NOW = new Date("2026-09-25T10:00:00.000Z");

function voucher(overrides: Record<string, unknown> = {}) {
  return {
    voucher_id: "v-a",
    promo_id: null,
    code: "GIAM50K",
    name: "Giảm 50.000đ",
    discount_type: "fixed_amount",
    discount_value: 50000,
    max_discount_amount: null,
    min_order_value: 0,
    usage_limit_total: null,
    usage_limit_per_user: 1,
    used_count: 0,
    applicable_user_group: "all_users",
    start_date: "2026-09-01T00:00:00.000Z",
    end_date: "2026-12-31T00:00:00.000Z",
    is_active: true,
    ...overrides
  };
}

function wallet(rows: Record<string, unknown>[]) {
  const items = evaluateVouchers(rows, {
    orderValue: 600000,
    shippingFee: 0,
    now: NOW,
    isMember: true,
    isFirstOrder: false,
    usageByVoucherId: {},
    promotionByPromoId: {}
  });
  return { items, best: pickBestVoucher(items) };
}

const BIG = voucher();
const SMALL = voucher({ voucher_id: "v-b", code: "GIAM20K", name: "Giảm 20.000đ", discount_value: 20000 });
// Mã khách đã thấy trong ví nhưng vừa hết lượt trước lúc bấm Đặt hàng.
const BIG_SOLD_OUT = voucher({ usage_limit_total: 1, used_count: 1 });

test("mã khách chọn còn hợp lệ thì dùng đúng mã đó, kể cả khi không phải mã lợi nhất", () => {
  const result = chooseOrderVoucher(wallet([BIG, SMALL]), { voucherId: "v-b", code: null, decline: false });
  assert.equal(result.applied?.code, "GIAM20K");
  assert.equal(result.change, null);
});

test("mã khách chọn vừa hết lượt thì thay bằng mã tốt nhất kế tiếp và nói rõ lý do", () => {
  // D1: không tạo đơn ở mức giá khách chưa thấy. Đặt đơn biến kết quả này thành 409.
  const result = chooseOrderVoucher(wallet([BIG_SOLD_OUT, SMALL]), { voucherId: "v-a", code: null, decline: false });
  assert.equal(result.applied?.code, "GIAM20K");
  assert.ok(result.change);
  assert.equal(result.change.requestedCode, "GIAM50K");
  assert.match(result.change.reasonText, /hết lượt/);
});

test("mã khách chọn hết lượt và không còn mã nào khác thì báo giá không mã", () => {
  const result = chooseOrderVoucher(wallet([BIG_SOLD_OUT]), { voucherId: "v-a", code: null, decline: false });
  assert.equal(result.applied, null);
  assert.ok(result.change);
});

test("khách bỏ mã thì không tự áp lại mã nào", () => {
  const result = chooseOrderVoucher(wallet([BIG, SMALL]), { voucherId: null, code: null, decline: true });
  assert.equal(result.applied, null);
  assert.equal(result.change, null);
});

test("khách không chọn mã thì tự áp mã lợi nhất", () => {
  const result = chooseOrderVoucher(wallet([SMALL, BIG]), { voucherId: null, code: null, decline: false });
  assert.equal(result.applied?.code, "GIAM50K");
});

test("mã gõ tay không phân biệt hoa thường, mã không tồn tại thì báo lại", () => {
  assert.equal(
    chooseOrderVoucher(wallet([BIG, SMALL]), { voucherId: null, code: "giam20k", decline: false }).applied?.code,
    "GIAM20K"
  );
  const missing = chooseOrderVoucher(wallet([BIG]), { voucherId: null, code: "KHONGCO", decline: false });
  assert.equal(missing.applied?.code, "GIAM50K");
  assert.equal(missing.change?.requestedCode, "KHONGCO");
});

test("báo giá cộng đúng và tổng bằng tổng sẽ ghi vào đơn", () => {
  const { applied } = chooseOrderVoucher(wallet([BIG]), { voucherId: null, code: null, decline: false });
  const quote = summarizeQuote(600000, 0, applied, null);
  assert.equal(quote.subtotal, 600000);
  assert.equal(quote.discountAmount, 50000);
  assert.equal(quote.totalAmount, 550000);
  assert.equal(quote.freeShippingShortfall, 0);
  assert.equal(quote.voucher?.code, "GIAM50K");
});

test("báo giá dưới ngưỡng miễn phí vận chuyển nêu số tiền còn thiếu", () => {
  const quote = summarizeQuote(320000, 30000, null, null);
  assert.equal(quote.freeShippingThreshold, 500000);
  assert.equal(quote.freeShippingShortfall, 180000);
  assert.equal(quote.totalAmount, 350000);
});

test("giảm giá không bao giờ đẩy tổng xuống âm", () => {
  const { applied } = chooseOrderVoucher(wallet([voucher({ discount_value: 900000 })]), {
    voucherId: null, code: null, decline: false
  });
  const quote = summarizeQuote(600000, 0, applied, null);
  assert.equal(quote.totalAmount, 0);
});

test("đọc lựa chọn mã từ body đặt đơn", () => {
  assert.deepEqual(readVoucherRequest({ voucher_id: "v-a", decline_voucher: false }), {
    voucherId: "v-a", code: null, decline: false
  });
  assert.deepEqual(readVoucherRequest({ code: "  GIAM20K ", decline_voucher: true }), {
    voucherId: null, code: "GIAM20K", decline: true
  });
});
