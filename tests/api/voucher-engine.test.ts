import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPromotionStateMap,
  buildUsageMap,
  computeVoucherDiscount,
  evaluateVoucher,
  evaluateVouchers,
  normalizeShippingFee,
  pickBestVoucher
} from "../../apps/api/src/user/voucher-engine.js";

const NOW = new Date("2026-09-18T10:00:00.000Z");

function voucher(overrides = {}) {
  return {
    voucher_id: "v-1",
    promo_id: null,
    code: "VLR10",
    name: "Giam 10%",
    discount_type: "percentage",
    discount_value: 10,
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

function context(overrides = {}) {
  return {
    orderValue: 1000000,
    shippingFee: 30000,
    now: NOW,
    isMember: true,
    isFirstOrder: false,
    usageByVoucherId: {},
    promotionByPromoId: {},
    ...overrides
  };
}

/** Chiến dịch cha đang chạy bình thường; test ghi đè đúng thứ nó muốn kiểm. */
function promoState(overrides = {}) {
  return {
    limit: 0,
    issued: 0,
    isActive: true,
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-12-31T00:00:00.000Z",
    ...overrides
  };
}

test("percentage discount respects the max-discount cap", () => {
  const uncapped = computeVoucherDiscount(voucher({ discount_value: 30 }), 1000000, 30000);
  assert.equal(uncapped, 300000);

  const capped = computeVoucherDiscount(
    voucher({ discount_value: 30, max_discount_amount: 10000 }),
    1000000,
    30000
  );
  assert.equal(capped, 10000);
});

test("free shipping discount equals the shipping fee, not the order value", () => {
  const discount = computeVoucherDiscount(
    voucher({ discount_type: "free_shipping", discount_value: 0 }),
    1000000,
    35000
  );
  assert.equal(discount, 35000);
});

test("discount never exceeds the order value", () => {
  const discount = computeVoucherDiscount(
    voucher({ discount_type: "fixed_amount", discount_value: 500000 }),
    200000,
    30000
  );
  assert.equal(discount, 200000);
});

test("guest codes and member codes stay in separate sets", () => {
  const guestCode = voucher({ voucher_id: "g", code: "GUEST", applicable_user_group: "guest", discount_type: "fixed_amount", discount_value: 20000 });
  const memberCode = voucher({ voucher_id: "m", code: "MEMBER", applicable_user_group: "member", discount_type: "fixed_amount", discount_value: 50000 });
  const shared = voucher({ voucher_id: "a", code: "ALL", applicable_user_group: "all_users", discount_type: "fixed_amount", discount_value: 10000 });

  const asGuest = evaluateVouchers([guestCode, memberCode, shared], context({ isMember: false }));
  assert.equal(pickBestVoucher(asGuest)?.code, "GUEST");
  assert.equal(asGuest.find((item) => item.code === "MEMBER")?.reason, "GROUP_MISMATCH");

  const asMember = evaluateVouchers([guestCode, memberCode, shared], context({ isMember: true, isFirstOrder: false }));
  assert.equal(pickBestVoucher(asMember)?.code, "MEMBER");
  assert.equal(asMember.find((item) => item.code === "GUEST")?.reason, "GROUP_MISMATCH");
});

test("best voucher is chosen by real money saved, not by headline percentage", () => {
  // Giam 30% nhung tran 10.000d phai THUA giam thang 15.000d.
  const percentCapped = voucher({
    voucher_id: "v-percent",
    code: "CAP30",
    discount_type: "percentage",
    discount_value: 30,
    max_discount_amount: 10000
  });
  const fixed = voucher({
    voucher_id: "v-fixed",
    code: "FIX15K",
    discount_type: "fixed_amount",
    discount_value: 15000
  });

  const evaluated = evaluateVouchers([percentCapped, fixed], context({ orderValue: 500000 }));
  const best = pickBestVoucher(evaluated);

  assert.ok(best);
  assert.equal(best.code, "FIX15K");
  assert.equal(best.discountAmount, 15000);
});

test("ineligible voucher explains the shortfall so the customer knows the next step", () => {
  const result = evaluateVoucher(
    voucher({ min_order_value: 2500000 }),
    context({ orderValue: 1670000 })
  );

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "MIN_ORDER_NOT_MET");
  assert.equal(result.shortfall, 830000);
  assert.match(result.reasonText ?? "", /mua thêm 830\.000đ/);
});

test("expired, sold-out and inactive vouchers report their own cause, not the order value", () => {
  const expired = evaluateVoucher(
    voucher({ end_date: "2026-09-01T00:00:00.000Z", min_order_value: 9999999 }),
    context()
  );
  assert.equal(expired.reason, "EXPIRED");

  const soldOut = evaluateVoucher(
    voucher({ usage_limit_total: 10, used_count: 10, min_order_value: 9999999 }),
    context()
  );
  assert.equal(soldOut.reason, "SOLD_OUT");

  const inactive = evaluateVoucher(voucher({ is_active: false }), context());
  assert.equal(inactive.reason, "INACTIVE");
});

test("campaign budget exhaustion blocks its vouchers", () => {
  const result = evaluateVoucher(
    voucher({ promo_id: "p-1" }),
    context({
      promotionByPromoId: { "p-1": promoState({ limit: 10000000, issued: 10000000 }) }
    })
  );

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "BUDGET_EXHAUSTED");
});

test("campaign with budget still remaining does not block its vouchers", () => {
  const result = evaluateVoucher(
    voucher({ promo_id: "p-1" }),
    context({
      promotionByPromoId: { "p-1": promoState({ limit: 10000000, issued: 9000000 }) }
    })
  );

  assert.equal(result.eligible, true);
});

test("a paused campaign stops its vouchers even while the voucher row is still active", () => {
  const result = evaluateVoucher(
    voucher({ promo_id: "p-1", is_active: true }),
    context({ promotionByPromoId: { "p-1": promoState({ isActive: false }) } })
  );

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "PROMOTION_INACTIVE");
});

test("an ended or not-yet-started campaign stops its vouchers", () => {
  const ended = evaluateVoucher(
    voucher({ promo_id: "p-1" }),
    context({ promotionByPromoId: { "p-1": promoState({ endDate: "2026-09-01T00:00:00.000Z" }) } })
  );
  assert.equal(ended.reason, "PROMOTION_INACTIVE");

  const notStarted = evaluateVoucher(
    voucher({ promo_id: "p-1" }),
    context({ promotionByPromoId: { "p-1": promoState({ startDate: "2026-12-01T00:00:00.000Z" }) } })
  );
  assert.equal(notStarted.reason, "PROMOTION_INACTIVE");
});

test("a voucher with no parent campaign is judged on its own merits", () => {
  const result = evaluateVoucher(voucher({ promo_id: null }), context());

  assert.equal(result.eligible, true);
});

test("new-customer voucher is refused once the customer already has orders", () => {
  const firstOrder = evaluateVoucher(
    voucher({ applicable_user_group: "new_user" }),
    context({ isFirstOrder: true })
  );
  assert.equal(firstOrder.eligible, true);

  const repeatOrder = evaluateVoucher(
    voucher({ applicable_user_group: "new_user" }),
    context({ isFirstOrder: false })
  );
  assert.equal(repeatOrder.eligible, false);
  assert.equal(repeatOrder.reason, "GROUP_MISMATCH");
});

test("member-only voucher is refused for a guest checkout", () => {
  const result = evaluateVoucher(
    voucher({ applicable_user_group: "loyal_user" }),
    context({ isMember: false })
  );

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "GROUP_MISMATCH");
  assert.match(result.reasonText ?? "", /Đăng nhập/);
});

test("per-customer usage limit applies to members only", () => {
  const usedUp = evaluateVoucher(
    voucher({ usage_limit_per_user: 1 }),
    context({ usageByVoucherId: { "v-1": 1 } })
  );
  assert.equal(usedUp.reason, "USER_LIMIT_REACHED");

  // Khach vang lai khong co lich su don gan tai khoan nen khong bi chan o buoc nay.
  const guest = evaluateVoucher(
    voucher({ usage_limit_per_user: 1 }),
    context({ isMember: false, usageByVoucherId: { "v-1": 1 } })
  );
  assert.equal(guest.eligible, true);
});

test("display order puts eligible vouchers first, then the nearest-to-qualify", () => {
  const list = [
    voucher({ voucher_id: "far", code: "FAR", min_order_value: 5000000 }),
    voucher({ voucher_id: "near", code: "NEAR", min_order_value: 1200000 }),
    voucher({ voucher_id: "small", code: "SMALL", discount_type: "fixed_amount", discount_value: 20000 }),
    voucher({ voucher_id: "big", code: "BIG", discount_type: "fixed_amount", discount_value: 90000 })
  ];

  const ordered = evaluateVouchers(list, context({ orderValue: 1000000 }));

  assert.deepEqual(
    ordered.map((item) => item.code),
    ["BIG", "SMALL", "NEAR", "FAR"]
  );
});

test("no eligible voucher yields no automatic selection", () => {
  const evaluated = evaluateVouchers(
    [voucher({ min_order_value: 9999999 })],
    context({ orderValue: 100000 })
  );
  assert.equal(pickBestVoucher(evaluated), null);
});

test("usage map ignores cancelled orders", () => {
  const usage = buildUsageMap([
    { voucher_id: "v-1", status: "completed" },
    { voucher_id: "v-1", status: "cancelled" },
    { voucher_id: "v-2", status: "pending" },
    { voucher_id: null, status: "completed" }
  ]);

  assert.deepEqual(usage, { "v-1": 1, "v-2": 1 });
});

test("promotion state map carries budget and campaign lifecycle together", () => {
  const states = buildPromotionStateMap([
    {
      promo_id: "p-1",
      budget_limit: 10000000,
      total_discount_issued: 2500000,
      is_active: false,
      start_date: "2026-09-01T00:00:00.000Z",
      end_date: "2026-12-31T00:00:00.000Z"
    }
  ]);

  assert.deepEqual(states, {
    "p-1": {
      limit: 10000000,
      issued: 2500000,
      isActive: false,
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-12-31T00:00:00.000Z"
    }
  });
});

test("shipping fee falls back to the standard fee when the client sends nonsense", () => {
  assert.equal(normalizeShippingFee(45000), 45000);
  assert.equal(normalizeShippingFee(0), 0);
  assert.equal(normalizeShippingFee("abc"), 30000);
  assert.equal(normalizeShippingFee(undefined), 30000);
  assert.equal(normalizeShippingFee(-5), 30000);
});

// ---------------------------------------------------------------------------
// Mã theo danh mục (U1-09, quyết định D4)
// ---------------------------------------------------------------------------
// Giá trị đơn tối thiểu và số tiền giảm tính trên phần hàng thuộc danh mục của mã.
// Danh mục cha phủ danh mục con: `categoryPath` của một dòng gồm danh mục của sản phẩm
// và mọi danh mục tổ tiên của nó.

const AO = "cat-ao";
const AO_SOMI = "cat-ao-somi";
const QUAN = "cat-quan";
const LINE_AO = { categoryPath: [AO], lineTotal: 300000 };
const LINE_QUAN = { categoryPath: [QUAN], lineTotal: 500000 };
const CAT_NAMES = { [AO]: "Áo", [AO_SOMI]: "Áo sơ mi", [QUAN]: "Quần" };

function cartContext(lines: { categoryPath: string[]; lineTotal: number }[], overrides = {}) {
  return context({
    orderValue: lines.reduce((sum, line) => sum + line.lineTotal, 0),
    lines,
    categoryNameById: CAT_NAMES,
    ...overrides
  });
}

test("đơn tối thiểu của mã danh mục chỉ tính phần hàng thuộc danh mục", () => {
  // Đơn 800k nhưng phần Áo mới 300k, nên mã Áo tối thiểu 400k chưa dùng được.
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO], discount_value: 20, min_order_value: 400000 }),
    cartContext([LINE_AO, LINE_QUAN])
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "MIN_ORDER_NOT_MET");
  assert.equal(result.shortfall, 100000);
});

test("mã danh mục giảm phần trăm trên phần hàng thuộc danh mục, không trên cả đơn", () => {
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO], discount_value: 20 }),
    cartContext([LINE_AO, LINE_QUAN])
  );
  assert.equal(result.eligible, true);
  assert.equal(result.discountAmount, 60000, "20% của 300k Áo, không phải 20% của 800k");
});

test("mã cho danh mục cha phủ sản phẩm thuộc danh mục con", () => {
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO], discount_value: 10 }),
    cartContext([{ categoryPath: [AO_SOMI, AO], lineTotal: 400000 }, LINE_QUAN])
  );
  assert.equal(result.eligible, true);
  assert.equal(result.discountAmount, 40000);
});

test("giỏ không có sản phẩm nào thuộc danh mục thì từ chối kèm tên danh mục", () => {
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO] }),
    cartContext([LINE_QUAN])
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "CATEGORY_MISMATCH");
  assert.match(result.reasonText || "", /Áo/);
  assert.deepEqual(result.categoryNames, ["Áo"]);
});

test("mã danh mục đóng mặc định khi đường gọi không truyền dòng hàng", () => {
  // Nếu thiếu dòng hàng mà lại tính trên cả đơn thì mọi đường gọi quên truyền dòng hàng
  // sẽ mở lại đúng lỗ rò giảm cho cả đơn.
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO] }),
    context({ orderValue: 800000 })
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "CATEGORY_MISMATCH");
});

test("mã cố định theo danh mục không giảm quá phần hàng thuộc danh mục", () => {
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO], discount_type: "fixed_amount", discount_value: 100000 }),
    cartContext([{ categoryPath: [AO], lineTotal: 60000 }, LINE_QUAN])
  );
  assert.equal(result.discountAmount, 60000);
});

test("mã miễn phí vận chuyển theo danh mục vẫn giảm đúng bằng phí vận chuyển", () => {
  // BR-A4-07: freeship giảm đúng phí ship. Danh mục chỉ quyết định mã có dùng được không.
  const result = evaluateVoucher(
    voucher({ applicable_categories: [AO], discount_type: "free_shipping", discount_value: 0 }),
    cartContext([LINE_AO, LINE_QUAN], { shippingFee: 30000 })
  );
  assert.equal(result.eligible, true);
  assert.equal(result.discountAmount, 30000);
});

test("danh mục lưu dạng chuỗi JSON cũng đọc được, còn mảng rỗng nghĩa là không giới hạn", () => {
  const asJsonString = evaluateVoucher(
    voucher({ applicable_categories: JSON.stringify([AO]), discount_value: 20 }),
    cartContext([LINE_AO, LINE_QUAN])
  );
  assert.equal(asJsonString.discountAmount, 60000);

  const empty = evaluateVoucher(
    voucher({ applicable_categories: [], discount_value: 20 }),
    cartContext([LINE_AO, LINE_QUAN])
  );
  assert.equal(empty.discountAmount, 160000, "mảng rỗng tính trên cả đơn 800k");
  assert.deepEqual(empty.categoryNames, []);
});

test("sai danh mục xét sau sai nhóm khách và trước hết lượt của khách", () => {
  // Nhóm khách là lý do "mã không dành cho bạn", xét trước. Hết lượt của khách xét sau,
  // vì với giỏ không có món nào thuộc danh mục thì lượt còn hay hết đều không quan trọng.
  const groupFirst = evaluateVoucher(
    voucher({ applicable_categories: [AO], applicable_user_group: "guest" }),
    cartContext([LINE_QUAN], { isMember: true })
  );
  assert.equal(groupFirst.reason, "GROUP_MISMATCH");

  const categoryBeforeLimit = evaluateVoucher(
    voucher({ applicable_categories: [AO], usage_limit_per_user: 1 }),
    cartContext([LINE_QUAN], { usageByVoucherId: { "v-1": 1 } })
  );
  assert.equal(categoryBeforeLimit.reason, "CATEGORY_MISMATCH");
});

test("mã không khai danh mục giữ nguyên kết quả khi có dòng hàng", () => {
  const withLines = evaluateVoucher(voucher({ discount_value: 10 }), cartContext([LINE_AO, LINE_QUAN]));
  const withoutLines = evaluateVoucher(voucher({ discount_value: 10 }), context({ orderValue: 800000 }));
  assert.equal(withLines.discountAmount, withoutLines.discountAmount);
  assert.equal(withLines.discountAmount, 80000);
});
