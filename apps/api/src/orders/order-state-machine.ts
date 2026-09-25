/**
 * Order State Machine của Velura — bảng KAN-59 viết thành dữ liệu.
 *
 * Đây là nơi duy nhất định nghĩa trạng thái đơn, nhãn hiển thị và hành động hợp lệ. API
 * dùng bảng này để trả `allowed_actions` cho từng đơn, nên hai frontend không tự giữ
 * bảng chuyển trạng thái nào. RPC `admin_order_action` (migration 038) kiểm lại cùng bảng
 * trong cơ sở dữ liệu; `velura_order_action_rules()` trong migration đó là bản JSON của
 * `ORDER_ACTIONS`, và `tests/api/order-state-machine.test.ts` so khớp hai bản.
 *
 * Payment Status, Refund Status và tag ưu tiên không phải Order State (KAN-59 mục 1).
 */

export const ORDER_STATUSES = [
  "pending",
  "waiting_payment",
  "confirmed",
  "processing",
  "shipping",
  "delivered",
  "delivery_failed",
  "cancelled"
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Nhãn hiển thị, dùng chung cho admin và khách (KAN-37, KAN-59 mục 1). */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  pending: "Chờ xác nhận",
  waiting_payment: "Chờ thanh toán",
  confirmed: "Đã xác nhận",
  processing: "Đang chuẩn bị hàng",
  shipping: "Đang giao hàng",
  delivered: "Giao thành công",
  delivery_failed: "Giao không thành công",
  cancelled: "Đã hủy"
};

/** Trạng thái không còn chuyển tiếp nào được phê duyệt. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "delivery_failed", "cancelled"];

/** Nhãn trạng thái thanh toán theo OPEN-06. */
export const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "Chờ thanh toán",
  paid: "Đã thanh toán",
  failed: "Thất bại",
  refund_pending: "Chờ hoàn tiền",
  refunded: "Đã hoàn tiền",
  discrepancy: "Lệch đối soát"
};

/** Nhãn tag cần chú ý. Tag được tính trong view `admin_order_tags` (migration 038). */
export const ORDER_TAG_LABELS: Readonly<Record<string, string>> = {
  PRIORITY_REVIEW: "Ưu tiên duyệt",
  REVIEW_OVERDUE: "Quá hạn duyệt",
  PAYMENT_OVERDUE: "Quá hạn thanh toán",
  PAYMENT_ATTENTION: "Cần kiểm thanh toán",
  REFUND_PENDING: "Đang hoàn tiền",
  REFUND_FAILED: "Hoàn tiền lỗi",
  RETURN_TO_STOCK_PENDING: "Chờ xác nhận hoàn kho"
};

/** Order Admin trong KAN-59 mục 3. CSKH chỉ đọc. */
export const ORDER_OPERATOR_ROLES: readonly string[] = ["super_admin", "admin_operator_donhang"];
export const ORDER_READER_ROLES: readonly string[] = [...ORDER_OPERATOR_ROLES, "admin_operator_cskh_dt"];

export type OrderActor = "order_admin" | "customer" | "system";

/** Trường nhập thêm của một action, ngoài ghi chú. */
export type OrderActionField = "call_result" | "shortage" | "shipment" | "cancel_reason" | "tracking";

export interface OrderActionSpec {
  code: string;
  label: string;
  actor: OrderActor;
  from: readonly OrderStatus[];
  /** null: action không đổi trạng thái. */
  to: OrderStatus | null;
  requiresNote: boolean;
  fields: readonly OrderActionField[];
}

/**
 * Bảng action của KAN-59 mục 3 và KAN-60 mục 3, cộng `retry_refund` theo OPEN-02.
 *
 * Thứ tự khai báo là thứ tự nút hiện trên màn chi tiết đơn.
 */
export const ORDER_ACTIONS: readonly OrderActionSpec[] = [
  { code: "call_confirm", label: "Gọi xác nhận", actor: "order_admin", from: ["pending"], to: null, requiresNote: true, fields: ["call_result"] },
  { code: "confirm_cod", label: "Xác nhận đơn", actor: "order_admin", from: ["pending"], to: "confirmed", requiresNote: true, fields: [] },
  { code: "start_processing", label: "Bắt đầu chuẩn bị hàng", actor: "order_admin", from: ["confirmed"], to: "processing", requiresNote: true, fields: [] },
  { code: "record_shortage", label: "Ghi nhận thiếu hàng", actor: "order_admin", from: ["processing"], to: null, requiresNote: true, fields: ["shortage"] },
  { code: "upsert_shipment", label: "Tạo/cập nhật vận đơn", actor: "order_admin", from: ["processing"], to: null, requiresNote: true, fields: ["shipment"] },
  { code: "confirm_handover", label: "Xác nhận bàn giao ĐVVC", actor: "order_admin", from: ["processing"], to: "shipping", requiresNote: true, fields: [] },
  { code: "carrier_note", label: "Ghi chú liên hệ ĐVVC", actor: "order_admin", from: ["shipping"], to: null, requiresNote: true, fields: [] },
  { code: "update_tracking", label: "Cập nhật tracking", actor: "order_admin", from: ["shipping"], to: null, requiresNote: true, fields: ["tracking"] },
  { code: "record_failure_reason", label: "Ghi lý do giao thất bại", actor: "order_admin", from: ["delivery_failed"], to: null, requiresNote: true, fields: [] },
  { code: "confirm_return_to_stock", label: "Xác nhận hàng hoàn kho", actor: "order_admin", from: ["delivery_failed"], to: null, requiresNote: true, fields: [] },
  { code: "retry_refund", label: "Thử hoàn tiền lại", actor: "order_admin", from: ["cancelled"], to: null, requiresNote: true, fields: [] },
  { code: "cancel", label: "Hủy đơn", actor: "order_admin", from: ["pending", "waiting_payment", "confirmed", "processing"], to: "cancelled", requiresNote: true, fields: ["cancel_reason"] },
  { code: "customer_cancel", label: "Hủy đơn", actor: "customer", from: ["pending", "waiting_payment", "confirmed"], to: "cancelled", requiresNote: false, fields: ["cancel_reason"] },
  { code: "to_waiting_payment", label: "Chuyển sang chờ thanh toán", actor: "system", from: ["pending"], to: "waiting_payment", requiresNote: false, fields: [] },
  { code: "payment_succeeded", label: "Thanh toán thành công", actor: "system", from: ["waiting_payment"], to: "confirmed", requiresNote: false, fields: [] },
  { code: "payment_expired", label: "Hết hạn thanh toán", actor: "system", from: ["waiting_payment"], to: "cancelled", requiresNote: false, fields: [] },
  { code: "auto_confirm_cod", label: "Tự xác nhận COD", actor: "system", from: ["pending"], to: "confirmed", requiresNote: false, fields: [] },
  { code: "carrier_delivered", label: "Giao hàng thành công", actor: "system", from: ["shipping"], to: "delivered", requiresNote: false, fields: [] },
  { code: "carrier_failed_returned", label: "Giao thất bại, hàng đã hoàn kho", actor: "system", from: ["shipping"], to: "delivery_failed", requiresNote: false, fields: [] },
  { code: "carrier_failed_retrying", label: "Giao thất bại, ĐVVC giao lại", actor: "system", from: ["shipping"], to: null, requiresNote: false, fields: [] }
];

/** Kết quả gọi xác nhận hợp lệ (KAN-60 mục 3.1). */
export const CALL_RESULTS: Readonly<Record<string, string>> = {
  reached: "Liên hệ được",
  no_answer: "Không nghe máy",
  customer_requests_cancel: "Khách yêu cầu hủy"
};

/** Kết quả mô phỏng ĐVVC, mỗi kết quả ứng với một action của System. */
export const CARRIER_OUTCOMES: Readonly<Record<string, string>> = {
  delivered: "carrier_delivered",
  failed_returned: "carrier_failed_returned",
  failed_retrying: "carrier_failed_retrying"
};

/** Dữ liệu của đơn mà guard cần đọc. */
export interface OrderFacts {
  status: string;
  paymentMethod: string;
  trackingCode: string | null;
  shipmentVoidedAt: string | null;
  handedOverAt: string | null;
  returnedToStockAt: string | null;
  paymentStatus: string | null;
  refundFailed: boolean;
}

/** Hành động hiện cho người đang xem, kèm thông tin để frontend dựng form. */
export interface AllowedAction {
  code: string;
  label: string;
  to_status: OrderStatus | null;
  requires_note: boolean;
  fields: readonly OrderActionField[];
  destructive: boolean;
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function orderStatusLabel(value: unknown): string {
  return isOrderStatus(value) ? ORDER_STATUS_LABELS[value] : String(value || "—");
}

export function findOrderAction(code: string): OrderActionSpec | undefined {
  return ORDER_ACTIONS.find((action) => action.code === code);
}

/**
 * Điều kiện nghiệp vụ ngoài trạng thái. Trả mã lỗi nếu chặn, null nếu cho qua.
 *
 * Mã lỗi trùng với mã RPC trả về, để frontend nhận cùng một thông điệp dù bị chặn ở
 * tầng nào.
 */
export function actionGuard(code: string, facts: OrderFacts): string | null {
  const action = findOrderAction(code);
  if (!action) return "UNKNOWN_ORDER_ACTION";
  if (!isOrderStatus(facts.status) || !action.from.includes(facts.status)) return "INVALID_ORDER_ACTION";
  switch (code) {
    case "confirm_cod":
    case "auto_confirm_cod":
      // FR-04: đơn online không được xác nhận bằng action COD.
      return facts.paymentMethod === "COD" ? null : "COD_ONLY";
    case "to_waiting_payment":
    case "payment_succeeded":
    case "payment_expired":
      return facts.paymentMethod === "ONLINE_PAYMENT" ? null : "ONLINE_ONLY";
    case "confirm_handover":
      // BR-05: có mã vận đơn và vận đơn chưa bị vô hiệu.
      if (!facts.trackingCode) return "TRACKING_CODE_REQUIRED";
      return facts.shipmentVoidedAt ? "SHIPMENT_VOIDED" : null;
    case "cancel":
    case "customer_cancel":
      // BR-02: không huỷ sau bàn giao.
      return facts.handedOverAt ? "ORDER_ALREADY_HANDED_OVER" : null;
    case "confirm_return_to_stock":
      return facts.returnedToStockAt ? "ALREADY_RETURNED_TO_STOCK" : null;
    case "retry_refund":
      return facts.paymentStatus === "refund_pending" && facts.refundFailed ? null : "REFUND_NOT_RETRYABLE";
    default:
      return null;
  }
}

/**
 * Các action admin đang xem được phép bấm với đơn này.
 *
 * Người không có quyền ghi (CSKH, viewer) nhận danh sách rỗng: KAN-60 yêu cầu ẩn hẳn
 * action không có quyền, không làm mờ.
 */
export function allowedAdminActions(facts: OrderFacts, roleCode: string | undefined): AllowedAction[] {
  if (!roleCode || !ORDER_OPERATOR_ROLES.includes(roleCode)) return [];
  return ORDER_ACTIONS
    .filter((action) => action.actor === "order_admin" && actionGuard(action.code, facts) === null)
    .map((action) => ({
      code: action.code,
      label: action.label,
      to_status: action.to,
      requires_note: action.requiresNote,
      fields: action.fields,
      destructive: action.to === "cancelled"
    }));
}

/** Khách còn được tự huỷ đơn này không (BR-03). */
export function customerCanCancel(facts: OrderFacts): boolean {
  return actionGuard("customer_cancel", facts) === null;
}

/** Đọc `OrderFacts` từ một dòng đơn kèm payment (projection của `ORDER_DETAIL_SELECT`). */
export function orderFacts(order: Record<string, unknown>): OrderFacts {
  const payments = Array.isArray(order.payments) ? (order.payments as Record<string, unknown>[]) : [];
  const latest = [...payments].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
  return {
    status: String(order.status || ""),
    paymentMethod: String(order.payment_method || ""),
    trackingCode: order.tracking_code ? String(order.tracking_code) : null,
    shipmentVoidedAt: order.shipment_voided_at ? String(order.shipment_voided_at) : null,
    handedOverAt: order.handed_over_at ? String(order.handed_over_at) : null,
    returnedToStockAt: order.returned_to_stock_at ? String(order.returned_to_stock_at) : null,
    paymentStatus: latest?.payment_status ? String(latest.payment_status) : null,
    refundFailed: String(latest?.gateway_response_code || "") === "REFUND_FAILED"
  };
}

/** Một bước trên timeline khách xem (KAN-39 FR-08). */
export interface CustomerOrderStep {
  status: string;
  label: string;
  at: string | null;
  state: "done" | "current" | "upcoming";
}

/** Đường đi bình thường của một đơn, theo phương thức thanh toán. */
const HAPPY_PATH: Readonly<Record<string, readonly OrderStatus[]>> = {
  COD: ["pending", "confirmed", "processing", "shipping", "delivered"],
  ONLINE_PAYMENT: ["waiting_payment", "confirmed", "processing", "shipping", "delivered"]
};

/**
 * Timeline cho khách: các mốc đã qua lấy từ lịch sử thật, cộng các bước còn lại của
 * đường đi bình thường khi đơn chưa kết thúc.
 *
 * Đơn tạo trước khi có lịch sử chi tiết chỉ có mốc hiện tại; không dựng mốc giả.
 */
export function customerOrderSteps(
  status: string,
  paymentMethod: string,
  timeline: ReadonlyArray<{ status: unknown; at: unknown }>
): CustomerOrderStep[] {
  const passed: CustomerOrderStep[] = [];
  for (const row of timeline) {
    const code = String(row.status || "");
    if (!code || passed[passed.length - 1]?.status === code) continue;
    passed.push({ status: code, label: orderStatusLabel(code), at: row.at ? String(row.at) : null, state: "done" });
  }
  if (passed[passed.length - 1]?.status !== status) {
    passed.push({ status, label: orderStatusLabel(status), at: null, state: "done" });
  }
  const last = passed[passed.length - 1];
  if (isOrderStatus(status) && TERMINAL_STATUSES.includes(status)) {
    // Giao thành công là đích; huỷ và giao thất bại là mốc cần khách chú ý.
    if (status !== "delivered") last.state = "current";
    return passed;
  }
  last.state = "current";
  const path = HAPPY_PATH[paymentMethod] ?? HAPPY_PATH.COD;
  const position = path.indexOf(status as OrderStatus);
  const upcoming = position >= 0 ? path.slice(position + 1) : [];
  return [
    ...passed,
    ...upcoming.map((code): CustomerOrderStep => ({ status: code, label: ORDER_STATUS_LABELS[code], at: null, state: "upcoming" }))
  ];
}
