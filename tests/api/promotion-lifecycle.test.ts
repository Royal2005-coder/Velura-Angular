import test from "node:test";
import assert from "node:assert/strict";
import {
  canActivatePromotion,
  canPausePromotion,
  promotionLifecycle,
  promotionWarnings,
  overlappingPromotions,
  overlapWarning,
  toLifecycleInput,
  toOverlapCandidate
} from "../../apps/api/src/pricing/promotion-lifecycle.js";
import { decoratePromotions, validatePromotionSchedule } from "../../apps/api/src/pricing/pricing-service.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");

function campaign(overrides = {}) {
  return {
    isActive: true,
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-12-31T00:00:00.000Z",
    pausedAt: null,
    budgetLimit: 0,
    totalDiscountIssued: 0,
    ...overrides
  };
}

test("a campaign past its end date reads as ended whatever else is true of it", () => {
  const ended = campaign({ endDate: "2026-09-01T00:00:00.000Z" });
  assert.equal(promotionLifecycle(ended, NOW), "ended");
  // Kể cả khi vẫn còn cờ bật hoặc đang bị tắt tay.
  assert.equal(promotionLifecycle({ ...ended, pausedAt: "2026-09-05T00:00:00.000Z" }, NOW), "ended");
});

test("a manually paused campaign inside its window reads as paused, not ended", () => {
  const paused = campaign({ isActive: false, pausedAt: "2026-09-18T00:00:00.000Z" });

  assert.equal(promotionLifecycle(paused, NOW), "paused");
});

test("a campaign that has not started yet is scheduled, not running", () => {
  const scheduled = campaign({ isActive: false, startDate: "2026-12-01T00:00:00.000Z" });

  assert.equal(promotionLifecycle(scheduled, NOW), "scheduled");
});

test("an exhausted budget outranks the active flag", () => {
  const exhausted = campaign({ budgetLimit: 10000000, totalDiscountIssued: 10000000 });

  assert.equal(promotionLifecycle(exhausted, NOW), "budget_exhausted");
});

test("the action buttons follow the same lifecycle the badge shows", () => {
  // Đây chính là lỗi cũ: badge "Đã kết thúc" nhưng vẫn mời bấm "Kích hoạt".
  assert.equal(canActivatePromotion("ended"), false);
  assert.equal(canActivatePromotion("budget_exhausted"), false);
  assert.equal(canActivatePromotion("paused"), true);
  assert.equal(canPausePromotion("running"), true);
  assert.equal(canPausePromotion("paused"), false);
});

test("warnings surface a nearly exhausted budget before it runs out", () => {
  const warnings = promotionWarnings(campaign({ budgetLimit: 10000000, totalDiscountIssued: 8500000 }), NOW);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "BUDGET_NEARLY_EXHAUSTED");
  assert.match(warnings[0].message, /85%/);
});

test("warnings flag a campaign about to end, and stay quiet on one already over", () => {
  const endingSoon = promotionWarnings(campaign({ endDate: "2026-09-22T10:00:00.000Z" }), NOW);
  assert.equal(endingSoon.some((w) => w.code === "ENDING_SOON"), true);

  assert.deepEqual(promotionWarnings(campaign({ endDate: "2026-01-01T00:00:00.000Z" }), NOW), []);
});

test("a budget on a campaign with no vouchers is reported as untracked", () => {
  // Ngân sách chỉ tăng khi có người dùng mã; chiến dịch chưa phát mã nào thì con số đó
  // vĩnh viễn đứng yên, nên thanh tiến độ ở đó là nói dối.
  const warnings = promotionWarnings(
    campaign({ budgetLimit: 10000000, voucherCount: 0, activeVoucherCount: 0 }),
    NOW
  );

  assert.equal(warnings.some((w) => w.code === "BUDGET_NOT_TRACKED"), true);
});

test("a running campaign whose vouchers are all inactive is flagged as useless to customers", () => {
  const warnings = promotionWarnings(campaign({ voucherCount: 3, activeVoucherCount: 0 }), NOW);

  const warning = warnings.find((w) => w.code === "NO_ACTIVE_VOUCHER");
  assert.ok(warning);
  assert.equal(warning.level, "danger");
});

test("an unset budget is reported as unlimited, not as zero", () => {
  const payload = decoratePromotions(
    [{ promo_id: "p-1", is_active: true, start_date: "2026-09-01", end_date: "2026-12-31", budget_limit: 0 }],
    NOW
  );

  assert.equal(payload.rows[0].budget_unlimited, true);
  assert.equal(payload.rows[0].lifecycle_status, "running");
  assert.equal(payload.rows[0].lifecycle_label, "Đang chạy");
});

test("toLifecycleInput reads a raw PostgREST row, defaulting a missing active flag to on", () => {
  const input = toLifecycleInput({ start_date: "2026-09-01", end_date: "2026-12-31" });

  assert.equal(input.isActive, true);
  assert.equal(input.pausedAt, null);
  assert.equal(input.budgetLimit, 0);
});

test("junk campaigns are refused by the server, not just by the form", () => {
  assert.throws(
    () => validatePromotionSchedule({ name: "grsgrg", startDate: "2026-09-01", endDate: "2026-09-02" }),
    (error) => error.status === 422 && error.details.name.length === 1
  );
  assert.throws(
    () => validatePromotionSchedule({ name: "Flash Sale Cuoi Tuan", startDate: "2026-09-10", endDate: "2026-09-01" }),
    (error) => error.status === 422 && error.details.endDate.length === 1
  );
  assert.throws(
    () => validatePromotionSchedule({ name: "Flash Sale Cuoi Tuan", startDate: "2026-09-01", endDate: "2026-09-10", budgetLimit: -5 }),
    (error) => error.status === 422 && error.details.budgetLimit.length === 1
  );
  // Hợp lệ thì đi qua im lặng, kể cả khi không đặt trần ngân sách.
  validatePromotionSchedule({ name: "Flash Sale Cuoi Tuan", startDate: "2026-09-01", endDate: "2026-09-30" });
});

test("two live campaigns covering the same category are flagged as overlapping", () => {
  const tet = { promoId: "p1", name: "Tet 2026", startDate: "2026-01-01", endDate: "2026-02-15", categories: ["ao-dai", "phu-kien"] };
  const others = [
    tet,
    // Trùng cả thời gian lẫn danh mục "ao-dai" — đây là ca cần cảnh báo.
    { promoId: "p2", name: "Flash Sale Ao Dai", startDate: "2026-02-01", endDate: "2026-02-20", categories: ["ao-dai"] },
    // Trùng danh mục nhưng khác hẳn khung thời gian.
    { promoId: "p3", name: "He 2026", startDate: "2026-06-01", endDate: "2026-06-30", categories: ["ao-dai"] },
    // Trùng thời gian nhưng khác danh mục.
    { promoId: "p4", name: "Giay Dep Thang 2", startDate: "2026-02-01", endDate: "2026-02-20", categories: ["giay"] }
  ];

  const clashes = overlappingPromotions(tet, others);
  assert.deepEqual(clashes.map((row) => row.promoId), ["p2"]);

  const warning = overlapWarning(tet, others);
  assert.equal(warning.code, "OVERLAPPING_CAMPAIGN");
  assert.equal(warning.level, "warning");
  assert.match(warning.message, /Flash Sale Ao Dai/);
});

test("a campaign with no category list covers everything, so it overlaps every live campaign", () => {
  // Không khai danh mục nghĩa là áp cho toàn bộ cửa hàng, không phải là không áp cho gì.
  const toanBo = { promoId: "p1", name: "Giam Gia Toan Bo", startDate: "2026-03-01", endDate: "2026-03-31", categories: [] };
  const others = [
    toanBo,
    { promoId: "p2", name: "Flash Sale Giay", startDate: "2026-03-10", endDate: "2026-03-12", categories: ["giay"] }
  ];
  assert.equal(overlappingPromotions(toanBo, others).length, 1);
  // Và ngược lại.
  assert.equal(overlappingPromotions(others[1], others).length, 1);
});

test("a campaign on its own raises no overlap warning", () => {
  const solo = { promoId: "p1", name: "Tet 2026", startDate: "2026-01-01", endDate: "2026-02-15", categories: ["ao-dai"] };
  assert.equal(overlapWarning(solo, [solo]), null);
});

test("applicable_categories that is not a list is read as 'covers everything'", () => {
  // Cột này là jsonb nên có thể là null, một đối tượng, hay bất kỳ thứ gì cũ còn sót.
  const candidate = toOverlapCandidate({ promo_id: "p1", promo_name: "Tet", start_date: "2026-01-01", end_date: "2026-02-15", applicable_categories: null });
  assert.deepEqual(candidate.categories, []);
  assert.equal(candidate.name, "Tet");
});
