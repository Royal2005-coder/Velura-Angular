/**
 * Nhãn tiếng Việt của các trạng thái nghiệp vụ, khai báo một lần cho cả admin.
 *
 * Trước đây mỗi module tự giữ một bảng nhãn riêng, và màn CSKH lại đem bảng nhãn đổi
 * trả ra đọc trạng thái đơn hàng. Hệ quả: cùng một đơn, trang Đơn hàng ghi "Chờ xác
 * nhận" còn trang CSKH ghi "Chờ xử lý"; các trạng thái chỉ có ở đơn hàng như
 * `confirmed`, `shipping`, `delivered` thì rơi thẳng ra tiếng Anh cho người vận hành đọc.
 *
 * Nguồn trạng thái là backend: `order-constants.ts`, `return-constants.ts`,
 * `review-constants.ts` và enum `payment_status` trong schema. Thêm trạng thái mới ở đó
 * thì thêm nhãn ở đây, đừng thêm vào bảng nhãn của riêng một trang.
 */

/** Trạng thái đơn hàng — `order_status`. */
export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị',
  shipping: 'Đang giao',
  delivered: 'Đã giao',
  failed_delivery: 'Giao thất bại',
  cancelled: 'Đã hủy',
  completed: 'Hoàn thành',
};

/** Trạng thái thanh toán — `payment_status`. */
export const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xử lý',
  paid: 'Đã thanh toán',
  failed: 'Thanh toán thất bại',
  refunded: 'Đã hoàn tiền',
  refund_pending: 'Chờ hoàn tiền',
  discrepancy: 'Cần đối soát',
};

/** Trạng thái phiếu đổi/trả — `RETURN_STATUSES`. */
export const RETURN_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ xử lý',
  approved: 'Đã duyệt',
  shipping_back: 'Đang gửi về',
  received: 'Đã nhận',
  completed: 'Hoàn tất',
  rejected: 'Từ chối',
};

/** Trạng thái phiếu hỗ trợ — `SUPPORT_TICKET_STATUSES`. */
export const TICKET_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Mới',
  processing: 'Đang xử lý',
  resolved: 'Đã giải quyết',
  closed: 'Đã đóng',
};

/** Trạng thái đánh giá — `review_status`. */
export const REVIEW_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Đã ẩn',
};

/**
 * Đọc nhãn từ một bảng cụ thể.
 *
 * Trạng thái lạ trả về nguyên mã thay vì một nhãn mặc định đẹp đẽ: nếu backend sinh ra
 * một trạng thái mà admin chưa biết, người vận hành cần nhìn thấy điều đó chứ không
 * phải bị nói dối là "Chờ xử lý".
 */
export function statusLabelFrom(
  labels: Readonly<Record<string, string>>,
  status: string | null | undefined,
): string {
  const key = String(status || '');
  if (!key) return '—';
  return labels[key] || key;
}
