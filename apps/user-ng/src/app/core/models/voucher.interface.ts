/** Lý do một mã chưa dùng được, khớp 1-1 với `VoucherIneligibleReason` phía API. */
export type VoucherIneligibleReason =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'SOLD_OUT'
  | 'MIN_ORDER_NOT_MET'
  | 'USER_LIMIT_REACHED'
  | 'GROUP_MISMATCH'
  | 'PROMOTION_INACTIVE'
  | 'BUDGET_EXHAUSTED'
  | 'CATEGORY_MISMATCH';

/** Một mã trong ví voucher, đã được API đánh giá theo giỏ hàng hiện tại. */
export interface WalletVoucher {
  voucher_id: string;
  promo_id: string | null;
  code: string;
  name: string;
  discount_type: string;
  discount_value: number;
  max_discount_amount: number | null;
  min_order_value: number;
  start_date: string | null;
  end_date: string | null;
  remaining_uses: number | null;
  eligible: boolean;
  /** Số tiền khách thực sự tiết kiệm nếu áp mã này. */
  discount_amount: number;
  reason: VoucherIneligibleReason | null;
  reason_text: string | null;
  shortfall: number | null;
  /** Tên danh mục mã áp dụng. Rỗng nghĩa là áp cho mọi sản phẩm. */
  category_names?: string[];
}

/** Một dòng giỏ hàng gửi lên để máy chủ tự tính giá trị đơn từ bảng giá. */
export interface CartItemRef {
  variant_id: string;
  quantity: number;
}

/** Mã khách chọn không còn dùng được và đã được thay. */
export interface VoucherChange {
  requested_voucher_id: string | null;
  requested_code: string | null;
  reason_text: string;
}

/** Báo giá của `POST /api/user/checkout/quote` — đúng các con số sẽ ghi vào đơn. */
export interface CheckoutQuote {
  subtotal: number;
  shipping_fee: number;
  free_shipping_threshold: number;
  free_shipping_shortfall: number;
  discount_amount: number;
  total_amount: number;
  voucher: { voucher_id: string; code: string; name: string; discount_amount: number } | null;
  voucher_change: VoucherChange | null;
}

/** Chi tiết của lỗi 409 `VOUCHER_CHANGED` khi đặt đơn. */
export interface VoucherChangedDetails {
  requested_voucher_id: string | null;
  requested_code: string | null;
  reason_text: string;
  replacement: { voucher_id: string; code: string; name: string; discount_amount: number } | null;
}

/** Phản hồi của `GET /api/user/vouchers`. */
export interface VoucherWalletResponse {
  success: boolean;
  order_value: number;
  shipping_fee: number;
  best_voucher_id: string | null;
  eligible_count: number;
  vouchers: WalletVoucher[];
}

/** Mã đang được áp cho đơn hàng. */
export interface AppliedVoucher {
  voucher_id: string;
  code: string;
  name: string;
  discount_amount: number;
  discount_type: string;
}

/** Phản hồi của `POST /api/user/vouchers/best` và `/apply`. */
export interface VoucherApplyResponse extends Partial<AppliedVoucher> {
  success: boolean;
  applied: boolean;
  message?: string;
  vouchers?: WalletVoucher[];
}
