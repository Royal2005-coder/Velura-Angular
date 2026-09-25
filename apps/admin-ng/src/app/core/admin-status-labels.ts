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

/**
 * Trạng thái đơn hàng — `order_status`, bộ tám mã của KAN-59.
 *
 * Màn Đơn hàng dùng `status_label` do API trả về. Bảng này cho các màn khác chỉ nhận mã
 * trạng thái (CSKH, tổng quan). Nhãn trùng với `ORDER_STATUS_LABELS` ở
 * `apps/api/src/orders/order-state-machine.ts`.
 */
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
 * Lựa chọn trên form action đơn. API kiểm lại mã; nhãn trùng với `CALL_RESULTS` và
 * `CANCEL_REASONS` phía API.
 *
 * Các nút action không khai ở đây: API trả `allowed_actions` cho từng đơn.
 */
export const ORDER_CALL_RESULTS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'reached', label: 'Liên hệ được' },
  { code: 'no_answer', label: 'Không nghe máy' },
  { code: 'customer_requests_cancel', label: 'Khách yêu cầu hủy' },
];

export const ORDER_CANCEL_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'customer_request', label: 'Khách yêu cầu huỷ' },
  { code: 'out_of_stock', label: 'Hết hàng, không thể giao' },
  { code: 'unreachable', label: 'Không liên hệ được khách' },
  { code: 'suspected_fraud', label: 'Nghi ngờ đơn ảo' },
  { code: 'other', label: 'Lý do khác' },
];

/** Kết quả mô phỏng ĐVVC, chỉ dùng ở panel của super_admin. */
export const CARRIER_SIMULATION_OUTCOMES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'delivered', label: 'Giao thành công' },
  { code: 'failed_retrying', label: 'Giao thất bại, ĐVVC giao lại' },
  { code: 'failed_returned', label: 'Giao thất bại, hàng hoàn về kho' },
];

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
