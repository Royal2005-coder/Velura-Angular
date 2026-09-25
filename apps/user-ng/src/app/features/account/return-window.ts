/** Days after delivery during which the buyer can open a return. Matches the API. */
export const RETURN_WINDOW_DAYS = 30;

/** Reason codes on the return form, stored as the Vietnamese sentence CSKH reads. */
export const RETURN_REASON_LABELS: Readonly<Record<string, string>> = {
  error: 'Sản phẩm bị lỗi sản xuất',
  size: 'Không vừa kích cỡ',
  color: 'Sai màu sắc',
  mismatch: 'Sản phẩm khác với mô tả',
  damaged: 'Hàng bị hư hỏng trong vận chuyển',
  mind_change: 'Thay đổi ý định mua hàng',
  other: 'Lý do khác',
};

/**
 * Text stored on the return so admin does not see the raw option code.
 */
export function returnReasonText(code: string): string {
  return RETURN_REASON_LABELS[code] || code;
}

export interface ReturnableOrder {
  status?: string;
  delivered_at?: string;
  updated_at?: string;
  created_at?: string;
}

/**
 * Đơn Giao thành công còn trong 30 ngày. Bộ trạng thái KAN-59 không còn `completed`.
 */
export function isReturnableOrder(order: ReturnableOrder, now = new Date()): boolean {
  if (order.status !== 'delivered') {
    return false;
  }
  const raw = order.delivered_at || order.updated_at || order.created_at;
  if (!raw) {
    return true;
  }
  const delivered = new Date(raw);
  if (Number.isNaN(delivered.getTime())) {
    return true;
  }
  const elapsed = now.getTime() - delivered.getTime();
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
