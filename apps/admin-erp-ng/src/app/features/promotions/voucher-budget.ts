/**
 * Quy đổi ngân sách chiến dịch ra số mã tối đa (BA AD_PROMO_03).
 *
 * Bản sao thuần của `apps/api/src/pricing/voucher-budget.ts`, chỉ để hiển thị trực tiếp khi
 * admin đang gõ. Máy chủ vẫn là nơi quyết định (RPC khoá dòng chiến dịch, migration 103).
 * Đổi quy tắc ở một nơi thì phải đổi nơi kia.
 */

/** Phí ship nhanh: mức giảm tối đa của mã miễn phí ship không đặt trần. */
const FREE_SHIPPING_MAX_DISCOUNT = 50_000;

export interface VoucherTerms {
  type: string;
  value: number;
  maxDiscount: number | null;
}

export type VoucherCapacity =
  | { status: 'unlimited' }
  | { status: 'cap_required' }
  | { status: 'limited'; max: number; issued: number; remaining: number };

/** Mức giảm tối đa trên một lần dùng; `null` nếu không xác định (phần trăm không trần). */
export function voucherMaxDiscount(terms: VoucherTerms): number | null {
  const cap = terms.maxDiscount !== null && terms.maxDiscount > 0 ? terms.maxDiscount : null;
  if (terms.type === 'fixed_amount') {
    if (!Number.isFinite(terms.value) || terms.value <= 0) return null;
    return cap === null ? terms.value : Math.min(terms.value, cap);
  }
  if (terms.type === 'percentage') return cap;
  if (terms.type === 'free_shipping') return cap ?? FREE_SHIPPING_MAX_DISCOUNT;
  return null;
}

/** Sức chứa mã còn lại của chiến dịch. Ngân sách 0 = không giới hạn. */
export function voucherCapacity(budget: number, maxDiscountPerVoucher: number | null, issued: number): VoucherCapacity {
  if (!(budget > 0)) return { status: 'unlimited' };
  if (maxDiscountPerVoucher === null || !(maxDiscountPerVoucher > 0)) return { status: 'cap_required' };
  const max = Math.floor(budget / maxDiscountPerVoucher);
  const used = Math.max(0, Math.floor(issued));
  return { status: 'limited', max, issued: used, remaining: Math.max(0, max - used) };
}

/** Thông báo chạm trần, cùng chữ với máy chủ. */
export function budgetReachedMessage(issued: number, max: number): string {
  return `Đã phát ${issued}/${max} mã, chạm trần ngân sách`;
}
