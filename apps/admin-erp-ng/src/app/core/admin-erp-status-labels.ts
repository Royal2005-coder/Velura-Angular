/**
 * Vietnamese labels for business states. The API remains the source of state codes;
 * this file only prevents one state from being displayed with two different names.
 */
export type AdminTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xác nhận',
  waiting_payment: 'Chờ thanh toán',
  confirmed: 'Đã xác nhận',
  processing: 'Đang chuẩn bị hàng',
  shipping: 'Đang giao hàng',
  delivered: 'Giao thành công',
  delivery_failed: 'Giao không thành công',
  cancelled: 'Đã hủy',
};

export const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xử lý',
  paid: 'Đã thanh toán',
  failed: 'Thanh toán thất bại',
  refunded: 'Đã hoàn tiền',
  refund_pending: 'Chờ hoàn tiền',
  discrepancy: 'Cần đối soát',
};

export const RETURN_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xử lý',
  approved: 'Đã duyệt',
  shipping_back: 'Đang gửi về',
  received: 'Nhận hàng hoàn trả thành công',
  completed: 'Hoàn tất',
  rejected: 'Từ chối',
};

export const TICKET_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Mới',
  processing: 'Đang xử lý',
  resolved: 'Đã giải quyết',
  closed: 'Đã đóng',
};

export const REVIEW_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Đã ẩn',
};

export const AUDIT_MODULE_LABELS: Readonly<Record<string, string>> = {
  accounts: 'Tài khoản',
  auth: 'Xác thực',
  products: 'Sản phẩm',
  product: 'Sản phẩm',
  orders: 'Đơn hàng',
  returns: 'Đổi trả',
  return_exchange: 'Đổi trả',
  support: 'Hỗ trợ',
  support_tickets: 'Hỗ trợ',
  pricing: 'Giá bán',
  promotions: 'Khuyến mãi',
  vouchers: 'Voucher',
  reviews: 'Đánh giá',
  content: 'Nội dung',
  ai: 'AI',
  system: 'Hệ thống',
  inventory: 'Tồn kho',
  categories: 'Danh mục',
};

export const AUDIT_RESULT_LABELS: Readonly<Record<string, string>> = {
  success: 'Thành công',
  failure: 'Thất bại',
  failed: 'Thất bại',
  blocked: 'Bị chặn',
  denied: 'Từ chối',
};

/**
 * Reads a label, preserving unknown backend codes so operators can spot new states.
 */
export function statusLabelFrom(
  labels: Readonly<Record<string, string>>,
  status: string | null | undefined,
): string {
  const key = String(status || '');
  if (!key) return '—';
  return labels[key] || key;
}

/**
 * Maps an audit result to a badge tone.
 */
export function auditResultTone(result: string | null | undefined): AdminTone {
  const key = String(result || '').toLowerCase();
  if (key === 'success') return 'success';
  if (key === 'failure' || key === 'failed') return 'danger';
  if (key === 'blocked' || key === 'denied') return 'warning';
  return 'neutral';
}

/**
 * Maps an order/payment-like state to a badge tone.
 */
export function statusTone(status: string | null | undefined): AdminTone {
  const key = String(status || '').toLowerCase();
  if (['delivered', 'completed', 'paid', 'approved', 'resolved', 'success'].includes(key)) return 'success';
  if (['cancelled', 'rejected', 'failed', 'discrepancy', 'delivery_failed'].includes(key)) return 'danger';
  if (['pending', 'waiting_payment', 'processing', 'shipping', 'open', 'refund_pending'].includes(key)) return 'warning';
  if (['confirmed', 'shipping_back', 'received'].includes(key)) return 'info';
  return 'neutral';
}
