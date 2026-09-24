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
  | "PROMOTION_INACTIVE"
  | "BUDGET_EXHAUSTED"
  | "CATEGORY_MISMATCH";

/**
 * Một dòng trong giỏ, đủ để xét phạm vi danh mục của mã.
 *
 * `categoryPath` gồm danh mục của sản phẩm và mọi danh mục tổ tiên, nên mã khai cho
 * danh mục cha tự phủ các danh mục con. Do máy chủ dựng từ bảng giá, không nhận từ
 * trình duyệt.
 */
export interface VoucherCartLine {
  categoryPath: readonly string[];
  lineTotal: number;
}

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
  promotionByPromoId: Record<string, PromotionState>;
  /**
   * Các dòng trong giỏ. Chỉ cần cho mã có khai danh mục. Thiếu thì mã có danh mục bị
   * coi như giỏ không có món nào thuộc danh mục — đóng mặc định, để một đường gọi quên
   * truyền dòng hàng không mở lại việc giảm cho cả đơn.
   */
  lines?: readonly VoucherCartLine[];
  /** Tên danh mục theo mã, để câu giải thích gọi đúng tên thay vì mã UUID. */
  categoryNameById?: Readonly<Record<string, string>>;
}

/**
 * Trạng thái chiến dịch cha của một mã, đủ để quyết định mã còn dùng được không.
 *
 * Voucher có cờ `is_active` và khung ngày riêng, nhưng chiến dịch cha cũng có. Khách
 * không được hưởng mã của một chiến dịch đã tạm dừng hoặc đã hết hạn, kể cả khi bản
 * thân voucher còn bật — nên engine phải xét cả hai.
 */
export interface PromotionState {
  limit: number;
  issued: number;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
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
  /** Tên các danh mục mã áp dụng. Rỗng nghĩa là áp cho mọi sản phẩm. */
  categoryNames: string[];
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
  shippingFee: number,
  scopedValue: number = orderValue
): number {
  const value = Number(voucher.discount_value || 0);

  // Mã miễn phí vận chuyển giảm đúng bằng phí vận chuyển (BR-A4-07). Danh mục chỉ quyết
  // định mã có dùng được hay không, nên trần ở đây là cả đơn.
  if (voucher.discount_type === "free_shipping") {
    return Math.max(0, Math.round(Math.min(shippingFee, orderValue)));
  }

  // Mã phần trăm và mã cố định chỉ giảm trên phần hàng thuộc phạm vi của mã (D4). Mã
  // không khai danh mục thì phần đó chính là cả đơn.
  let discount = 0;
  if (voucher.discount_type === "fixed_amount") {
    discount = value;
  } else if (voucher.discount_type === "percentage") {
    discount = (scopedValue * value) / 100;
    const cap = voucher.max_discount_amount;
    if (cap !== null && cap !== undefined && cap !== "") {
      discount = Math.min(discount, Number(cap));
    }
  }

  discount = Math.min(discount, scopedValue, orderValue);
  return Math.max(0, Math.round(discount));
}

/**
 * Danh mục mã áp dụng. Cột là JSONB nên có thể về dạng mảng, chuỗi JSON, hoặc null.
 */
export function voucherCategoryIds(voucher: JsonObject): string[] {
  let raw: unknown = voucher.applicable_categories;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id || "").trim()).filter(Boolean);
}

/**
 * Tổng tiền của các dòng thuộc phạm vi danh mục. Không có dòng hàng thì bằng 0.
 */
function scopedLineTotal(categoryIds: readonly string[], lines: readonly VoucherCartLine[] | undefined): number {
  if (!lines) return 0;
  const wanted = new Set(categoryIds);
  return lines
    .filter((line) => line.categoryPath.some((id) => wanted.has(id)))
    .reduce((sum, line) => sum + Math.max(0, Number(line.lineTotal) || 0), 0);
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
  const categoryIds = voucherCategoryIds(voucher);
  const categoryNames = categoryIds.map((id) => context.categoryNameById?.[id] || "danh mục khác");
  // Phần giá trị đơn mà mã được phép tính trên đó. Mã không khai danh mục thì là cả đơn.
  const scopedValue = categoryIds.length ? scopedLineTotal(categoryIds, context.lines) : context.orderValue;

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
    remainingUses,
    categoryNames
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
    const promotion = context.promotionByPromoId[promoId];
    if (promotion) {
      // Chiến dịch cha bị tạm dừng hoặc ngoài khung ngày thì mã của nó phải ngừng theo.
      // Cascade ở migration 028 đã tắt voucher con, nhưng chốt lại ở đây để một lần
      // cascade lỡ nhịp không biến thành giảm giá ngoài ý muốn.
      if (!promotion.isActive) {
        return reject("PROMOTION_INACTIVE", "Chiến dịch của mã này đã tạm dừng.");
      }
      if (promotion.startDate && promotion.startDate > nowIso) {
        return reject("PROMOTION_INACTIVE", `Chiến dịch của mã bắt đầu từ ${formatDate(promotion.startDate)}.`);
      }
      if (promotion.endDate && promotion.endDate < nowIso) {
        return reject("PROMOTION_INACTIVE", "Chiến dịch của mã này đã kết thúc.");
      }
      if (promotion.limit > 0 && promotion.issued >= promotion.limit) {
        return reject("BUDGET_EXHAUSTED", "Chiến dịch của mã này đã dùng hết ngân sách.");
      }
    }
  }

  const group = String(voucher.applicable_user_group || "all_users");
  if (group === "guest" && context.isMember) {
    return reject("GROUP_MISMATCH", "Mã chỉ dành cho khách vãng lai.");
  }
  if (group !== "guest" && group !== "all_users" && !context.isMember) {
    return reject("GROUP_MISMATCH", "Mã chỉ dành cho thành viên. Đăng nhập để sử dụng.");
  }
  if (group === "new_user" && !context.isFirstOrder) {
    return reject("GROUP_MISMATCH", "Mã chỉ dành cho khách hàng mua lần đầu.");
  }

  // Sai danh mục xét sau nhóm khách và trước lượt của khách: giỏ không có món nào thuộc
  // danh mục thì lượt còn hay hết không đổi được kết quả.
  if (categoryIds.length && scopedValue <= 0) {
    return reject(
      "CATEGORY_MISMATCH",
      `Mã chỉ áp cho ${joinNames(categoryNames)}, giỏ hàng chưa có sản phẩm phù hợp.`
    );
  }

  if (context.isMember && usedByThisCustomer >= usageLimitPerUser) {
    return reject("USER_LIMIT_REACHED", "Bạn đã dùng hết lượt cho mã này.");
  }

  if (scopedValue < minOrderValue) {
    const shortfall = Math.max(0, Math.round(minOrderValue - scopedValue));
    const where = categoryIds.length ? ` sản phẩm thuộc ${joinNames(categoryNames)}` : "";
    return reject(
      "MIN_ORDER_NOT_MET",
      `Đơn hàng chưa thỏa mãn điều kiện — mua thêm ${formatMoney(shortfall)}${where} để dùng mã này.`,
      shortfall
    );
  }

  const discountAmount = computeVoucherDiscount(voucher, context.orderValue, context.shippingFee, scopedValue);
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
 * Gom trạng thái và ngân sách của từng chiến dịch để chặn mã khi chiến dịch cha
 * đã tạm dừng, hết hạn hoặc cạn ngân sách.
 */
export function buildPromotionStateMap(
  promotions: readonly JsonObject[]
): Record<string, PromotionState> {
  const states: Record<string, PromotionState> = {};
  for (const promotion of promotions) {
    const promoId = promotion.promo_id ? String(promotion.promo_id) : "";
    if (!promoId) continue;
    states[promoId] = {
      limit: Number(promotion.budget_limit || 0),
      issued: Number(promotion.total_discount_issued || 0),
      isActive: promotion.is_active !== false,
      startDate: promotion.start_date ? String(promotion.start_date) : null,
      endDate: promotion.end_date ? String(promotion.end_date) : null
    };
  }
  return states;
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

function joinNames(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] || "một số danh mục";
  return `${unique.slice(0, -1).join(", ")} và ${unique[unique.length - 1]}`;
}

function formatMoney(value: number): string {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("vi-VN");
}
