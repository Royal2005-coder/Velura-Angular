/**
 * Allowed return / exchange statuses.
 */
export const RETURN_STATUSES = ["REQUESTED","APPROVED","IN_PROGRESS","REJECTED","CONTACTING","WAITING_RETURN","RETURN_IN_TRANSIT","RECEIVED","REFUND_PROCESSING","REFUNDED","EXCHANGE_PREPARING","EXCHANGE_SHIPPING","COMPLETED","CANCELLED","NEEDS_SUPPORT"] as const;
/** Active business requests reserve item return quota until completed or cancelled. */
export const OPEN_RETURN_STATUSES: readonly string[] = ["REQUESTED","APPROVED","IN_PROGRESS","CONTACTING","WAITING_RETURN","RETURN_IN_TRANSIT","RECEIVED","REFUND_PROCESSING","EXCHANGE_PREPARING","EXCHANGE_SHIPPING","NEEDS_SUPPORT"];
/** Customer and administrator consume the same canonical stored workflow codes. */
export const RETURN_STATUS_LABELS_VI: Readonly<Record<string,string>> = {
  APPROVED:"Đã duyệt", IN_PROGRESS:"Đang xử lý từng phần", REJECTED:"Bị từ chối",
  REQUESTED:"Chờ xử lý", CONTACTING:"Đang liên hệ", WAITING_RETURN:"Chờ gửi hàng", RETURN_IN_TRANSIT:"Hàng đang gửi về", RECEIVED:"Nhận hàng hoàn trả thành công", REFUND_PROCESSING:"Đang hoàn tiền", REFUNDED:"Đã hoàn tiền", EXCHANGE_PREPARING:"Đang chuẩn bị hàng đổi", EXCHANGE_SHIPPING:"Đang giao hàng đổi", COMPLETED:"Hoàn tất", CANCELLED:"Đã hủy", NEEDS_SUPPORT:"Cần hỗ trợ"
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

/** Kết quả QA kho. Chỉ `qa_pass` được chuyển phiếu sang received. */
export const RETURN_QA_PASS = "qa_pass";

/**
 * Nhãn tiếng Việt của một mã lý do. Mã lạ trả chuỗi rỗng.
 */
export function returnReasonLabel(code: string): string {
  return RETURN_REASONS.find((item) => item.code === code)?.label || "";
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
  "admin_operator_cskh_dt"
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
  "refund_bank_name", "refund_bank_account", "refund_bank_holder", "cancelled_by"
].join(",");

/**
 * PostgREST select list for `support_ticket` rows.
 */
export const TICKET_SELECT = [
  "ticket_id", "user_id", "guest_phone", "guest_email", "title",
  "description", "priority", "status", "admin_reply", "csat_score",
  "created_at", "resolved_at", "version", "chat_session_id"
].join(",");
