export const REVIEW_STATUSES = ["pending", "approved", "rejected"];

export const REVIEW_TRANSITIONS = {
  pending: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["approved"]
};

export const REVIEW_READER_ROLES = [
  "super_admin",
  "admin_operator_danhgia_review"
];

export const REVIEW_OPERATOR_ROLES = ["super_admin", "admin_operator_danhgia_review"];

export const REVIEW_SELECT = [
  "review_id", "product_id", "order_id", "user_id", "rating", "comment",
  "images", "review_tags", "status", "rejection_reason", "admin_reply",
  "moderated_by", "is_flagged_urgent", "submitted_at", "moderated_at", "version",
  "product:product(product_id,name,sku)"
].join(",");
