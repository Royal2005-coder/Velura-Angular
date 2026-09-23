/**
 * Vietnamese order labels shared with the admin badge map in
 * `apps/admin-ng/src/app/core/admin-status-labels.ts`.
 * The customer may cancel until the parcel is handed to shipping — the same
 * gate as `PATCH /api/user/orders`.
 */
export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xác nhận',
  waiting_payment: 'Chờ thanh toán',
  confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị hàng',
  processing: 'Đang chuẩn bị hàng',
  shipping: 'Đang giao hàng',
  delivered: 'Giao thành công',
  failed_delivery: 'Giao không thành công',
  delivery_failed: 'Giao không thành công',
  cancelled: 'Đã hủy',
  completed: 'Hoàn thành',
};

const CUSTOMER_CANNOT_CANCEL = [
  'shipping',
  'delivered',
  'failed_delivery',
  'delivery_failed',
  'completed',
  'cancelled',
];

/**
 * Label both portals show for one stored order status.
 */
export function orderStatusLabel(status: string | undefined): string {
  if (!status) {
    return '—';
  }
  return ORDER_STATUS_LABELS[status] || status;
}

/**
 * True while the buyer is still allowed to cancel. Shipping and later states are terminal for the customer.
 */
export function customerCanCancel(status: string | undefined): boolean {
  return typeof status === 'string' && status.length > 0 && !CUSTOMER_CANNOT_CANCEL.includes(status);
}
