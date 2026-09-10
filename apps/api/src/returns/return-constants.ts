/**
 * Allowed return / exchange statuses.
 */
export const RETURN_STATUSES: readonly string[] = ["pending", "approved", "shipping_back", "received", "completed", "rejected"];

/**
 * Legal status transitions for return / exchange records.
 */
export const RETURN_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["approved", "rejected"],
  approved: ["shipping_back"],
  shipping_back: ["received"],
  received: ["completed", "rejected"],
  completed: [],
  rejected: []
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
  "return_id", "order_id", "user_id", "return_type", "description",
  "status", "condition_check_result", "admin_note", "rejection_reason",
  "exchange_order_id", "refund_amount", "tracking_return_code",
  "created_at", "resolved_at", "version", "evidence_images"
].join(",");

/**
 * PostgREST select list for `support_ticket` rows.
 */
export const TICKET_SELECT = [
  "ticket_id", "user_id", "guest_phone", "guest_email", "title",
  "description", "priority", "status", "admin_reply", "csat_score",
  "created_at", "resolved_at", "version"
].join(",");
