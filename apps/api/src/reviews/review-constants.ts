/**
 * Allowed review moderation statuses.
 */
export const REVIEW_STATUSES: readonly string[] = ["pending", "approved", "rejected"];

/**
 * Legal status transitions for review moderation.
 */
export const REVIEW_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["approved"]
};

/**
 * Roles that may read the admin review queue.
 */
export const REVIEW_READER_ROLES: readonly string[] = [
  "super_admin",
  "admin_operator_danhgia_review"
];

/**
 * Roles that may approve, hide, reply, or escalate reviews.
 */
export const REVIEW_OPERATOR_ROLES: readonly string[] = ["super_admin", "admin_operator_danhgia_review"];

/**
 * PostgREST select list for admin review rows, including product embed.
 */
export const REVIEW_SELECT = [
  "review_id", "product_id", "order_id", "user_id", "rating", "comment",
  "images", "review_tags", "status", "rejection_reason", "admin_reply",
  "moderated_by", "is_flagged_urgent", "submitted_at", "moderated_at", "version",
  "product:product(product_id,name,sku)"
].join(",");
