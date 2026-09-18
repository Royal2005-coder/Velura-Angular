import type { JsonObject } from "../types.js";

/**
 * Lý do một mã giảm giá chưa dùng được, dùng chung cho cả ví voucher và bước áp mã.
 */
export type VoucherIneligibleReason =
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "SOLD_OUT"
  | "MIN_ORDER_NOT_MET"
  | "USER_LIMIT_REACHED"
  | "GROUP_MISMATCH"
  | "BUDGET_EXHAUSTED";

/**
 * Ngữ cảnh đánh giá mã cho một giỏ hàng cụ thể.
 *
 * `usageByVoucherId` là số lần chính khách hàng này đã dùng từng mã — với khách vãng lai
 * thì rỗng vì chưa có lịch sử đơn gắn tài khoản.
 */
export interface VoucherEvaluationContext {
  orderValue: number;
  shippingFee: number;
  now: Date;
  isMember: boolean;
  isFirstOrder: boolean;
  usageByVoucherId: Record<string, number>;
  promotionBudgetByPromoId: Record<string, { limit: number; issued: number }>;
}

/**
 * Một mã đã được đánh giá xong: dùng được hay không, tiết kiệm bao nhiêu, còn thiếu gì.
 */
export interface EvaluatedVoucher {
  voucherId: string;
  promoId: string | null;
  code: string;
  name: string;
  discountType: string;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderValue: number;
  startDate: string | null;
  endDate: string | null;
  remainingUses: number | null;
  eligible: boolean;
  /** Số tiền khách thực sự tiết kiệm được nếu áp mã này. 0 khi không dùng được. */
  discountAmount: number;
  reason: VoucherIneligibleReason | null;
  /** Câu giải thích hiển thị thẳng cho khách, đã viết sẵn tiếng Việt. */
  reasonText: string | null;
  /** Còn thiếu bao nhiêu tiền nữa mới đạt giá trị đơn tối thiểu. */
  shortfall: number | null;
}

const DEFAULT_SHIPPING_FEE = 30000;

/**
 * Tính số tiền giảm THỰC TẾ của một mã trên giá trị đơn hiện tại.
 *
 * Đây là điểm mấu chốt của quy tắc "chọn mã tốt nhất": so sánh phải dựa trên số tiền
 * thực nhận sau khi áp trần, không dựa trên phần trăm danh nghĩa. Giảm 30% tối đa
 * 10.000đ có thể thua giảm thẳng 15.000đ.
 */
export function computeVoucherDiscount(
  voucher: JsonObject,
  orderValue: number,
  shippingFee: number
): number {
  const value = Number(voucher.discount_value || 0);
  let discount = 0;

  if (voucher.discount_type === "fixed_amount") {
    discount = value;
  } else if (voucher.discount_type === "percentage") {
    discount = (orderValue * value) / 100;
    const cap = voucher.max_discount_amount;
    if (cap !== null && cap !== undefined && cap !== "") {
      discount = Math.min(discount, Number(cap));
    }
  } else if (voucher.discount_type === "free_shipping") {
    discount = shippingFee;
  }

  discount = Math.min(discount, orderValue);
  return Math.max(0, Math.round(discount));
}

/**
 * Đánh giá một mã trên ngữ cảnh giỏ hàng hiện tại.
 *
 * Thứ tự kiểm tra có chủ ý: các lý do "mã hỏng" (ngừng hoạt động, hết hạn, hết lượt)
 * xét trước lý do "đơn chưa đủ điều kiện", để câu giải thích cho khách luôn nêu
 * nguyên nhân gốc thay vì bảo khách mua thêm một mã vốn đã hết hạn.
 */
export function evaluateVoucher(
  voucher: JsonObject,
  context: VoucherEvaluationContext
): EvaluatedVoucher {
  const voucherId = String(voucher.voucher_id || "");
  const promoId = voucher.promo_id ? String(voucher.promo_id) : null;
  const minOrderValue = Number(voucher.min_order_value || 0);
  const usageLimitTotal = toNullableNumber(voucher.usage_limit_total);
  const usedCount = Number(voucher.used_count || 0);
  const usageLimitPerUser = Number(voucher.usage_limit_per_user || 1);
  const usedByThisCustomer = context.usageByVoucherId[voucherId] || 0;
  const remainingUses = usageLimitTotal === null ? null : Math.max(0, usageLimitTotal - usedCount);

  const base = {
    voucherId,
    promoId,
    code: String(voucher.code || ""),
    name: String(voucher.name || voucher.code || "Ưu đãi Velura"),
    discountType: String(voucher.discount_type || "fixed_amount"),
    discountValue: Number(voucher.discount_value || 0),
    maxDiscountAmount: toNullableNumber(voucher.max_discount_amount),
    minOrderValue,
    startDate: voucher.start_date ? String(voucher.start_date) : null,
    endDate: voucher.end_date ? String(voucher.end_date) : null,
    remainingUses
  };

  const reject = (
    reason: VoucherIneligibleReason,
    reasonText: string,
    shortfall: number | null = null
  ): EvaluatedVoucher => ({
    ...base,
    eligible: false,
    discountAmount: 0,
    reason,
    reasonText,
    shortfall
  });

  if (voucher.is_active === false) {
    return reject("INACTIVE", "Mã này hiện không hoạt động.");
  }

  const nowIso = context.now.toISOString();
  if (base.startDate && base.startDate > nowIso) {
    return reject("NOT_STARTED", `Mã có hiệu lực từ ${formatDate(base.startDate)}.`);
  }
  if (base.endDate && base.endDate < nowIso) {
    return reject("EXPIRED", `Mã đã hết hạn ngày ${formatDate(base.endDate)}.`);
  }
  if (remainingUses !== null && remainingUses <= 0) {
    return reject("SOLD_OUT", "Mã đã hết lượt sử dụng trên hệ thống.");
  }

  if (promoId) {
    const budget = context.promotionBudgetByPromoId[promoId];
    if (budget && budget.limit > 0 && budget.issued >= budget.limit) {
      return reject("BUDGET_EXHAUSTED", "Chiến dịch của mã này đã dùng hết ngân sách.");
    }
  }

  const group = String(voucher.applicable_user_group || "all_users");
  if (group === "new_user" && !context.isFirstOrder) {
    return reject("GROUP_MISMATCH", "Mã chỉ dành cho khách hàng mua lần đầu.");
  }
  if (group === "loyal_user" && !context.isMember) {
    return reject("GROUP_MISMATCH", "Mã chỉ dành cho thành viên. Đăng nhập để sử dụng.");
  }

  if (context.isMember && usedByThisCustomer >= usageLimitPerUser) {
    return reject("USER_LIMIT_REACHED", "Bạn đã dùng hết lượt cho mã này.");
  }

  if (context.orderValue < minOrderValue) {
    const shortfall = Math.max(0, Math.round(minOrderValue - context.orderValue));
    return reject(
      "MIN_ORDER_NOT_MET",
      `Đơn hàng chưa thỏa mãn điều kiện — mua thêm ${formatMoney(shortfall)} để dùng mã này.`,
      shortfall
    );
  }

  const discountAmount = computeVoucherDiscount(voucher, context.orderValue, context.shippingFee);
  if (discountAmount <= 0) {
    return reject("MIN_ORDER_NOT_MET", "Mã không mang lại giá trị giảm cho đơn này.");
  }

  return {
    ...base,
    eligible: true,
    discountAmount,
    reason: null,
    reasonText: null,
    shortfall: null
  };
}

/**
 * Đánh giá toàn bộ danh sách mã và sắp xếp theo thứ tự khách cần nhìn thấy.
 *
 * Mã dùng được xếp trước, giảm nhiều nhất lên đầu. Mã chưa đủ điều kiện xếp sau,
 * mã nào sắp đủ (thiếu ít tiền nhất) lên trước để khách thấy được mục tiêu gần nhất.
 */
export function evaluateVouchers(
  vouchers: readonly JsonObject[],
  context: VoucherEvaluationContext
): EvaluatedVoucher[] {
  const evaluated = vouchers.map((voucher) => evaluateVoucher(voucher, context));
  return [...evaluated].sort(compareForDisplay);
}

/**
 * Chọn mã tốt nhất cho khách: mã hợp lệ cho số tiền giảm thực tế lớn nhất.
 *
 * Khi hai mã giảm bằng nhau thì ưu tiên mã sắp hết hạn trước, để mã còn dài hạn
 * được để dành cho lần mua sau.
 */
export function pickBestVoucher(evaluated: readonly EvaluatedVoucher[]): EvaluatedVoucher | null {
  const eligible = evaluated.filter((item) => item.eligible);
  if (eligible.length === 0) return null;

  return eligible.reduce((best, candidate) => {
    if (candidate.discountAmount > best.discountAmount) return candidate;
    if (candidate.discountAmount < best.discountAmount) return best;
    return expiresEarlier(candidate, best) ? candidate : best;
  });
}

/**
 * Gom lượt dùng mã của một khách hàng từ danh sách đơn của họ.
 */
export function buildUsageMap(orders: readonly JsonObject[]): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const order of orders) {
    const voucherId = order.voucher_id ? String(order.voucher_id) : "";
    if (!voucherId) continue;
    if (String(order.status) === "cancelled") continue;
    usage[voucherId] = (usage[voucherId] || 0) + 1;
  }
  return usage;
}

/**
 * Gom ngân sách đã phát của từng chiến dịch để chặn mã khi chiến dịch cạn ngân sách.
 */
export function buildPromotionBudgetMap(
  promotions: readonly JsonObject[]
): Record<string, { limit: number; issued: number }> {
  const budgets: Record<string, { limit: number; issued: number }> = {};
  for (const promotion of promotions) {
    const promoId = promotion.promo_id ? String(promotion.promo_id) : "";
    if (!promoId) continue;
    budgets[promoId] = {
      limit: Number(promotion.budget_limit || 0),
      issued: Number(promotion.total_discount_issued || 0)
    };
  }
  return budgets;
}

/**
 * Chuẩn hóa phí vận chuyển đầu vào về một số dương hợp lệ.
 */
export function normalizeShippingFee(value: unknown): number {
  const fee = Number(value);
  return Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : DEFAULT_SHIPPING_FEE;
}

function compareForDisplay(a: EvaluatedVoucher, b: EvaluatedVoucher): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.eligible) {
    if (b.discountAmount !== a.discountAmount) return b.discountAmount - a.discountAmount;
    return expiresEarlier(a, b) ? -1 : 1;
  }
  const aShortfall = a.shortfall ?? Number.MAX_SAFE_INTEGER;
  const bShortfall = b.shortfall ?? Number.MAX_SAFE_INTEGER;
  return aShortfall - bShortfall;
}

function expiresEarlier(a: EvaluatedVoucher, b: EvaluatedVoucher): boolean {
  if (!a.endDate) return false;
  if (!b.endDate) return true;
  return a.endDate < b.endDate;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number): string {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("vi-VN");
}
