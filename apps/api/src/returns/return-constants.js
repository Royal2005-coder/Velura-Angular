export const RETURN_STATUSES = ["pending", "approved", "shipping_back", "received", "completed", "rejected"];

export const RETURN_TRANSITIONS = {
  pending: ["approved", "rejected"],
  approved: ["shipping_back"],
  shipping_back: ["received"],
  received: ["completed", "rejected"],
  completed: [],
  rejected: []
};

export const RETURN_READER_ROLES = [
  "super_admin",
  "admin_operator_donhang",
  "admin_operator_cskh_dt"
];

export const RETURN_OPERATOR_ROLES = [
  "super_admin",
  "admin_operator_cskh_dt"
];

export const SUPPORT_TICKET_STATUSES = ["open", "processing", "resolved", "closed"];

export const SUPPORT_TICKET_TRANSITIONS = {
  open: ["processing", "closed"],
  processing: ["resolved", "closed"],
  resolved: ["closed"],
  closed: []
};

export const RETURN_SELECT = [
  "return_id", "order_id", "user_id", "return_type", "description",
  "status", "condition_check_result", "admin_note", "rejection_reason",
  "exchange_order_id", "refund_amount", "tracking_return_code",
  "created_at", "resolved_at", "version", "evidence_images"
].join(",");

export const TICKET_SELECT = [
  "ticket_id", "user_id", "guest_phone", "guest_email", "title",
  "description", "priority", "status", "admin_reply", "csat_score",
  "created_at", "resolved_at", "version"
].join(",");
