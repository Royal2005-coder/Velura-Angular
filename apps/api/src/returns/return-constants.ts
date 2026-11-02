/**
 * Allowed return / exchange statuses.
 */
export const RETURN_STATUSES = ["REQUESTED","APPROVED","IN_PROGRESS","REJECTED","CONTACTING","WAITING_RETURN","RETURN_IN_TRANSIT","RECEIVED","REFUND_PROCESSING","REFUNDED","EXCHANGE_PREPARING","EXCHANGE_SHIPPING","COMPLETED","CANCELLED","NEEDS_SUPPORT"] as const;
/** Active business requests reserve item return quota until completed or cancelled. */
export const OPEN_RETURN_STATUSES: readonly string[] = ["REQUESTED","APPROVED","IN_PROGRESS","CONTACTING","WAITING_RETURN","RETURN_IN_TRANSIT","RECEIVED","REFUND_PROCESSING","EXCHANGE_PREPARING","EXCHANGE_SHIPPING","NEEDS_SUPPORT"];
/** Header decision column values; PARTIALLY_APPROVED is computed per part, not a workflow state. */
export const RETURN_DECISION_STATUSES: readonly string[] = ["pending","approved","PARTIALLY_APPROVED","rejected"];
/** Customer and administrator consume the same canonical stored workflow codes. */
export const RETURN_STATUS_LABELS_VI: Readonly<Record<string,string>> = {
  APPROVED:"Đã duyệt", IN_PROGRESS:"Đang xử lý từng phần", REJECTED:"Bị từ chối",
  REQUESTED:"Chờ xử lý", CONTACTING:"Đang liên hệ", WAITING_RETURN:"Đã duyệt · chờ ĐVVC lấy hàng", RETURN_IN_TRANSIT:"Hàng đang gửi về", RECEIVED:"Nhận hàng hoàn trả thành công", REFUND_PROCESSING:"Đang hoàn tiền", REFUNDED:"Đã hoàn tiền", EXCHANGE_PREPARING:"Đang chuẩn bị hàng đổi", EXCHANGE_SHIPPING:"Đang giao hàng đổi", COMPLETED:"Hoàn tất", CANCELLED:"Đã hủy", NEEDS_SUPPORT:"Cần hỗ trợ"
};

/** Lý do đổi trả bắt buộc, dạng mã cố định để gom top lý do trên dashboard. */
export const RETURN_REASONS: readonly { code: string; label: string }[] = [
  { code: "error", label: "Sản phẩm bị lỗi sản xuất" },
  { code: "size", label: "Không vừa kích cỡ" },
  { code: "color", label: "Sai màu sắc" },
  { code: "mismatch", label: "Sản phẩm khác với mô tả" },
  { code: "damaged", label: "Hàng bị hư hỏng trong vận chuyển" },
  { code: "mind_change", label: "Thay đổi ý định mua hàng" },
  { code: "other", label: "Lý do khác" }
];

/** Header statuses that no longer owe the customer contact or a refund; used by the overdue queue filters. */
export const RETURN_TERMINAL_STATUSES: readonly string[] = ["REFUNDED", "COMPLETED", "CANCELLED", "REJECTED"];

/** Kết quả QA kho. Chỉ `qa_pass` được chuyển phiếu sang received. */
export const RETURN_QA_PASS = "qa_pass";

/**
 * Nhãn tiếng Việt của một mã lý do. Mã lạ trả chuỗi rỗng.
 */
export function returnReasonLabel(code: string): string {
  return RETURN_REASONS.find((item) => item.code === code)?.label || "";
}


/**
 * A reply the customer can send after CSKH confirms the plan. The code is stored in the
 * request's contact trail; it never rewrites the request status or a part's workflow, so a
 * choice only becomes a business action when CSKH records its own decision.
 */
export interface ReturnCustomerResponseOption {
  code: string;
  label: string;
  /** CSKH needs the customer's own words before acting on this choice. */
  requires_note?: boolean;
  /** Signals the queue that a human must act; unrelated to the request's business stage. */
  attention_status?: "none" | "needs_support" | "waiting_customer";
}

/** Canonical customer replies shared by the storefront and the CSKH workspace. */
export const RETURN_CUSTOMER_RESPONSE_OPTIONS: readonly ReturnCustomerResponseOption[] = [
  { code: "accept_plan", label: "Đồng ý với phương án của CSKH", attention_status: "none" },
  { code: "prefer_refund", label: "Tôi muốn hoàn tiền", attention_status: "needs_support" },
  { code: "prefer_exchange", label: "Tôi muốn đổi hàng", attention_status: "needs_support" },
  { code: "schedule_pickup", label: "Hẹn ĐVVC lấy hàng", attention_status: "none" },
  { code: "request_callback", label: "Nhờ CSKH gọi lại", attention_status: "needs_support" },
  { code: "need_help", label: "Cần CSKH hỗ trợ thêm", requires_note: true, attention_status: "needs_support" },
  { code: "delivery_issue", label: "Đơn giao hàng có vấn đề", requires_note: true, attention_status: "needs_support" },
  { code: "accept_result", label: "Đồng ý với kết quả kiểm hàng", attention_status: "none" },
  { code: "refund_received", label: "Tôi đã nhận tiền hoàn", attention_status: "none" },
  { code: "refund_missing", label: "Tôi chưa nhận được tiền hoàn", requires_note: true, attention_status: "needs_support" },
  { code: "exchange_received", label: "Tôi đã nhận hàng đổi", attention_status: "none" },
  { code: "exchange_issue", label: "Hàng đổi có vấn đề", requires_note: true, attention_status: "needs_support" }
];

/**
 * Options that make sense at the request's current stage. Part statuses are included because a
 * split request can be in two stages at once (one part refunding, another being delivered).
 */
export function returnCustomerResponseOptionsFor(status: string, partStatuses: readonly string[] = []): ReturnCustomerResponseOption[] {
  const states = new Set([status, ...partStatuses].map((value) => String(value || "").toUpperCase()).filter(Boolean));
  if (states.has("CANCELLED") || states.has("REJECTED")) return [];
  const codes = new Set<string>();
  const include = (...values: string[]) => values.forEach((value) => codes.add(value));
  const contacting = ["REQUESTED", "CONTACTING", "WAITING_RETURN", "APPROVED", "IN_PROGRESS", "PARTIALLY_APPROVED", "NEEDS_SUPPORT"].some((value) => states.has(value));
  if (contacting) include("accept_plan", "request_callback", "need_help");
  if (["REQUESTED", "CONTACTING", "NEEDS_SUPPORT"].some((value) => states.has(value))) include("prefer_refund", "prefer_exchange");
  if (["WAITING_RETURN", "APPROVED", "IN_PROGRESS", "PARTIALLY_APPROVED"].some((value) => states.has(value))) include("schedule_pickup");
  if (states.has("RECEIVED")) include("accept_result");
  if (["REFUND_PROCESSING", "REFUND_PENDING", "REFUNDED", "COMPLETED"].some((value) => states.has(value))) include("refund_received", "refund_missing");
  if (states.has("EXCHANGE_PREPARING")) include("accept_plan");
  if (states.has("EXCHANGE_SHIPPING")) include("exchange_received", "exchange_issue", "delivery_issue");
  if (!codes.size) include("request_callback", "need_help");
  return RETURN_CUSTOMER_RESPONSE_OPTIONS.filter((option) => codes.has(option.code));
}

/** Looks up one stored customer reply without trusting a client-supplied label. */
export function returnCustomerResponseOption(code: string): ReturnCustomerResponseOption | undefined {
  return RETURN_CUSTOMER_RESPONSE_OPTIONS.find((option) => option.code === code);
}

/**
 * Legal status transitions for return / exchange records.
 */
export const RETURN_TRANSITIONS: Record<string,readonly string[]> = {
REQUESTED:["CONTACTING","CANCELLED"], CONTACTING:["WAITING_RETURN","CANCELLED","NEEDS_SUPPORT"],
WAITING_RETURN:["RETURN_IN_TRANSIT","CANCELLED"], RETURN_IN_TRANSIT:["RECEIVED","NEEDS_SUPPORT"],
RECEIVED:["REFUND_PROCESSING","EXCHANGE_PREPARING","NEEDS_SUPPORT"], REFUND_PROCESSING:["REFUNDED","NEEDS_SUPPORT"],
REFUNDED:["COMPLETED"], EXCHANGE_PREPARING:["EXCHANGE_SHIPPING","NEEDS_SUPPORT"], EXCHANGE_SHIPPING:["COMPLETED","NEEDS_SUPPORT"],
COMPLETED:[], CANCELLED:[], NEEDS_SUPPORT:["CONTACTING","CANCELLED"]
};

/**
 * Roles that may read admin returns and support tickets.
 */
export const RETURN_READER_ROLES: readonly string[] = [
  "super_admin",
  "admin_operator_donhang",
  "admin_operator_cskh_dt",
  "admin_viewer"
];

/**
 * Roles that may mutate returns and support tickets.
 */
export const RETURN_OPERATOR_ROLES: readonly string[] = [
  "super_admin",
  "admin_operator_cskh_dt"
];

/**
 * Allowed support-ticket statuses.
 */
export const SUPPORT_TICKET_STATUSES: readonly string[] = ["open", "processing", "resolved", "closed"];

/**
 * Legal status transitions for support tickets.
 */
export const SUPPORT_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  open: ["processing", "closed"],
  processing: ["resolved", "closed"],
  resolved: ["closed"],
  closed: []
};

/**
 * PostgREST select list for `return_exchange` rows.
 */
export const RETURN_SELECT = [
  "return_id", "return_code", "order_id", "user_id", "return_type", "description",
  "status", "condition_check_result", "package_match", "seal_intact", "qa_note",
  "admin_note", "rejection_reason",
  "decision_status", "attention_status", "contact_history", "last_contact_at",
  "exchange_order_id", "refund_amount", "tracking_return_code",
  "created_at", "resolved_at", "version", "evidence_images", "contact_due_at", "exchange_tracking_code", "warehouse_proof", "qa_item_receipts",
  "refund_bank_name", "refund_bank_account", "refund_bank_holder", "cancelled_by", "refund_due_at"
].join(",");

/**
 * PostgREST select list for `support_ticket` rows.
 */
export const TICKET_SELECT = [
  "ticket_id", "user_id", "guest_phone", "guest_email", "title",
  "description", "priority", "status", "admin_reply", "csat_score",
  "created_at", "resolved_at", "version", "chat_session_id"
].join(",");
