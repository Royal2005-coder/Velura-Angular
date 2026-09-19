/** Lý do một mã chưa dùng được, khớp 1-1 với `VoucherIneligibleReason` phía API. */
export type VoucherIneligibleReason =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'SOLD_OUT'
  | 'MIN_ORDER_NOT_MET'
  | 'USER_LIMIT_REACHED'
  | 'GROUP_MISMATCH'
  | 'BUDGET_EXHAUSTED';

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
