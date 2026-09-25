/**
 * Order State Machine Constants & Helpers
 * Nguồn sự thật: KAN-59 (Order State Machine), KAN-60 (Action Specification), KAN-63 (FSD)
 */

// 1. Bộ 8 Order State chính thức
export const ORDER_STATES = {
  PENDING: "pending",
  WAITING_PAYMENT: "waiting_payment",
  CONFIRMED: "confirmed",
  PROCESSING: "processing",
  SHIPPING: "shipping",
  DELIVERED: "delivered",
  DELIVERY_FAILED: "delivery_failed",
  CANCELLED: "cancelled"
};

// 2. Nhãn hiển thị tiếng Việt của 8 Order State
export const ORDER_STATE_LABELS = {
  [ORDER_STATES.PENDING]: "Chờ xác nhận",
  [ORDER_STATES.WAITING_PAYMENT]: "Chờ thanh toán",
  [ORDER_STATES.CONFIRMED]: "Đã xác nhận",
  [ORDER_STATES.PROCESSING]: "Đang chuẩn bị hàng",
  [ORDER_STATES.SHIPPING]: "Đang giao hàng",
  [ORDER_STATES.DELIVERED]: "Giao thành công",
  [ORDER_STATES.DELIVERY_FAILED]: "Giao không thành công",
  [ORDER_STATES.CANCELLED]: "Đã hủy"
};

// 3. Nhãn hiển thị tình trạng thanh toán (Payment Status - Tách biệt khỏi Order State)
export const PAYMENT_STATUS_LABELS = {
  paid: "Đã thanh toán",
  failed: "Thanh toán thất bại",
  pending: "Chờ xử lý",
  refunded: "Đã hoàn tiền",
  refund_pending: "Chờ hoàn tiền",
  discrepancy: "Cần đối soát"
};

// 4. Định nghĩa danh sách lý do hủy đơn hàng
export const CANCEL_REASONS = [
  { value: "CUSTOMER_REQUEST", label: "Khách hàng yêu cầu hủy" },
  { value: "OUT_OF_STOCK", label: "Hết hàng trong kho" },
  { value: "PAYMENT_TIMEOUT", label: "Quá thời hạn thanh toán" },
  { value: "UNABLE_TO_CONTACT", label: "Không thể liên hệ khách hàng" },
  { value: "INCORRECT_INFO", label: "Thông tin giao hàng không hợp lệ" },
  { value: "OTHER", label: "Lý do khác" }
];

// 5. Định nghĩa kết quả gọi điện xác nhận
export const CALL_RESULTS = [
  { value: "CONTACTED", label: "Liên hệ được" },
  { value: "NO_ANSWER", label: "Không nghe máy" },
  { value: "CANCEL_REQUESTED", label: "Khách yêu cầu hủy" }
];

/**
 * Kiểm tra xem đơn hàng COD có thuộc diện ưu tiên rà soát hay quá hạn rà soát không
 */
export function getOrderPriorityTag(order) {
  if (order.status !== ORDER_STATES.PENDING) return null;
  const isCod = order.payment_method === "COD" || order.payment_type === "COD";
  const amount = Number(order.total_amount || 0);
  
  if (!isCod || amount < 1000000) return null;

  const createdAt = new Date(order.order_date || order.created_at).getTime();
  const now = Date.now();
  const hoursPassed = (now - createdAt) / (1000 * 60 * 60);

  if (hoursPassed >= 24) {
    return { code: "REVIEW_OVERDUE", label: "CẦN XỬ LÝ GẤP (>24H)", type: "danger" };
  }
  return { code: "PRIORITY_REVIEW", label: "ƯU TIÊN RÀ SOÁT (≥1M)", type: "warning" };
}

/**
 * Kiểm tra xem role của user hiện tại có quyền thực hiện action xử lý đơn hay không
 * Order Admin = super_admin hoặc admin_operator_donhang
 * admin_operator_cskh_dt = CSKH Viewer (chỉ xem, không thao tác)
 */
export function isOrderAdmin(roleCode) {
  return roleCode === "super_admin" || roleCode === "admin_operator_donhang";
}

/**
 * Hàm trung tâm trả về danh sách Action hợp lệ theo State Machine (KAN-59, KAN-60, KAN-63)
 * @param {Object} order - Đơn hàng hiện tại
 * @param {string} roleCode - Mã role của user hiện tại
 * @returns {Array} List action objects: { id, label, icon, variant, modalType, hint }
 */
export function getAvailableActions(order, roleCode) {
  // 1. Kiểm tra role permission
  if (!isOrderAdmin(roleCode)) {
    return [];
  }

  const actions = [];
  const status = order.status;
  const isCod = order.payment_method === "COD" || order.payment_type === "COD";
  const trackingCode = (order.tracking_code || "").trim();
  const isHandedOver = Boolean(order.is_handed_over || order.handed_over_at);

  switch (status) {
    case ORDER_STATES.PENDING:
      // Action: Gọi điện xác nhận (Không đổi state)
      actions.push({
        id: "call_confirm",
        label: "Gọi điện xác nhận",
        icon: "phone",
        variant: "secondary",
        modalType: "call_confirm",
        hint: "Ghi nhận kết quả liên hệ (không tự đổi trạng thái đơn)"
      });

      // Action: Xác nhận đơn COD (chỉ dành cho đơn COD)
      if (isCod) {
        actions.push({
          id: "confirm_cod",
          label: "Xác nhận đơn COD",
          icon: "check-circle",
          variant: "primary",
          modalType: "confirm_cod",
          hint: "Chuyển trạng thái đơn sang Đã xác nhận (confirmed)"
        });
      }

      // Action: Hủy đơn
      actions.push({
        id: "cancel_order",
        label: "Hủy đơn",
        icon: "x-circle",
        variant: "danger",
        modalType: "cancel_order",
        hint: "Hủy đơn hàng và chuyển sang Đã hủy (cancelled)"
      });
      break;

    case ORDER_STATES.WAITING_PAYMENT:
      // Action: Hủy đơn
      actions.push({
        id: "cancel_order",
        label: "Hủy đơn",
        icon: "x-circle",
        variant: "danger",
        modalType: "cancel_order",
        hint: "Hủy đơn hàng chưa thanh toán"
      });
      break;

    case ORDER_STATES.CONFIRMED:
      // Action: Bắt đầu chuẩn bị hàng
      actions.push({
        id: "start_processing",
        label: "Bắt đầu chuẩn bị hàng",
        icon: "box",
        variant: "primary",
        modalType: "start_processing",
        hint: "Chuyển đơn sang Đang chuẩn bị hàng (processing)"
      });

      // Action: Hủy đơn
      actions.push({
        id: "cancel_order",
        label: "Hủy đơn",
        icon: "x-circle",
        variant: "danger",
        modalType: "cancel_order",
        hint: "Hủy đơn trước khi bàn giao cho ĐVVC"
      });
      break;

    case ORDER_STATES.PROCESSING:
      // Action: Ghi nhận thiếu hàng, liên hệ khách (Không đổi state)
      actions.push({
        id: "record_shortage",
        label: "Ghi nhận thiếu hàng",
        icon: "alert-triangle",
        variant: "warning",
        modalType: "record_shortage",
        hint: "Lưu tình trạng thiếu hàng & nội dung liên hệ khách"
      });

      // Action: Tạo/cập nhật mã vận đơn (Không đổi state)
      actions.push({
        id: "update_shipping_code",
        label: trackingCode ? "Cập nhật mã vận đơn" : "Tạo mã vận đơn",
        icon: "file-text",
        variant: "secondary",
        modalType: "update_shipping_code",
        hint: "Tạo hoặc cập nhật thông tin mã vận đơn"
      });

      // Action: Xác nhận bàn giao ĐVVC (Chỉ cho phép khi có tracking_code)
      actions.push({
        id: "handover_shipping",
        label: "Xác nhận bàn giao ĐVVC",
        icon: "truck",
        variant: "primary",
        modalType: "handover_shipping",
        disabled: !trackingCode,
        disabledHint: "Yêu cầu phải tạo mã vận đơn trước khi bàn giao thực tế",
        hint: "Chuyển trạng thái đơn sang Đang giao hàng (shipping)"
      });

      // Action: Hủy đơn (Chỉ cho phép nếu CHƯA bàn giao thực tế)
      if (!isHandedOver) {
        actions.push({
          id: "cancel_order",
          label: "Hủy đơn",
          icon: "x-circle",
          variant: "danger",
          modalType: "cancel_order",
          hint: trackingCode ? "Hủy đơn (Hệ thống sẽ vô hiệu hóa mã vận đơn trước khi hủy)" : "Hủy đơn trước bàn giao"
        });
      }
      break;

    case ORDER_STATES.SHIPPING:
      // Action: Ghi chú liên hệ ĐVVC (Không đổi state)
      actions.push({
        id: "note_carrier",
        label: "Ghi chú liên hệ ĐVVC",
        icon: "message-square",
        variant: "secondary",
        modalType: "note_carrier",
        hint: "Ghi nhận thông tin làm việc với bên vận chuyển"
      });

      // Action: Cập nhật tracking (Không đổi state)
      actions.push({
        id: "update_tracking",
        label: "Cập nhật tracking",
        icon: "map-pin",
        variant: "secondary",
        modalType: "update_tracking",
        hint: "Cập nhật thông tin hành trình giao hàng"
      });
      break;

    case ORDER_STATES.DELIVERY_FAILED:
      // Theo OPEN-03: Chưa chốt role & thời điểm xác nhận hàng hoàn kho.
      // Ẩn action tương tác, chỉ hiển thị thông tin.
      break;

    case ORDER_STATES.DELIVERED:
    case ORDER_STATES.CANCELLED:
    default:
      // Không có action chuyển Order State
      break;
  }

  return actions;
}
