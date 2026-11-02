import { SHIPPING_CONFIG } from "../shipping-config.js";

/**
 * Số mã tối đa suy ra từ ngân sách (BA AD_PROMO_03). Thuần, không I/O.
 *
 * Quy ước: `budget <= 0` nghĩa là chiến dịch không đặt ngân sách (không giới hạn), và một
 * mã không có trần giảm thì không quy đổi được — cả hai trả `null` ("không tính được").
 * Phía gọi phân biệt hai trường hợp bằng `voucherCapacity`.
 */
export function maxVouchersForBudget(
  budget: number | null | undefined,
  maxDiscountPerVoucher: number | null | undefined
): number | null {
  const total = Number(budget);
  const cap = Number(maxDiscountPerVoucher);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return Math.floor(total / cap);
}

/** Loại và điều khoản của một mã, đủ để tính mức giảm tối đa cho một lần dùng. */
export interface VoucherTerms {
  type: string;
  value: number;
  maxDiscount: number | null;
}

/**
 * Mức giảm tối đa của một mã trên một lần dùng.
 *
 * - Cố định: giá trị giảm, bị chặn bởi trần nếu có.
 * - Phần trăm: chỉ có trần mới biết; không trần thì `null`.
 * - Miễn phí ship: trần nếu có, không thì phí ship nhanh (mức phí cao nhất).
 */
export function voucherMaxDiscount(terms: VoucherTerms): number | null {
  const cap = terms.maxDiscount !== null && Number(terms.maxDiscount) > 0 ? Number(terms.maxDiscount) : null;
  if (terms.type === "fixed_amount") {
    const value = Number(terms.value);
    if (!Number.isFinite(value) || value <= 0) return null;
    return cap === null ? value : Math.min(value, cap);
  }
  if (terms.type === "percentage") return cap;
  if (terms.type === "free_shipping") return cap ?? SHIPPING_CONFIG.expressFee;
  return null;
}

/** Sức chứa còn lại của một chiến dịch cho mã mới. */
export type VoucherCapacity =
  | { status: "unlimited" }
  | { status: "cap_required" }
  | { status: "limited"; max: number; issued: number; remaining: number };

/**
 * Tính sức chứa mã của chiến dịch.
 *
 * `budget <= 0`: không giới hạn theo ngân sách. Có ngân sách mà mã không có trần giảm:
 * `cap_required` (mã phần trăm không trần bị từ chối vì không quy đổi được).
 */
export function voucherCapacity(
  budget: number | null | undefined,
  maxDiscountPerVoucher: number | null | undefined,
  issued: number
): VoucherCapacity {
  if (!(Number(budget) > 0)) return { status: "unlimited" };
  const max = maxVouchersForBudget(budget, maxDiscountPerVoucher);
  if (max === null) return { status: "cap_required" };
  const used = Math.max(0, Math.floor(issued));
  return { status: "limited", max, issued: used, remaining: Math.max(0, max - used) };
}

/** Thông báo khi chạm trần: "Đã phát X/Y mã, chạm trần ngân sách". */
export function budgetReachedMessage(issued: number, max: number): string {
  return `Đã phát ${issued}/${max} mã, chạm trần ngân sách`;
}
