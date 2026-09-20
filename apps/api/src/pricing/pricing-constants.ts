/** Canonical promotion type values. */
export const PROMOTION_TYPES = ["flash_sale", "combo_discount", "product_discount", "bulk_discount", "seasonal_sale"];

/** Canonical voucher discount type values. */
export const VOUCHER_TYPES = ["fixed_amount", "percentage", "free_shipping"];

/** Admin roles allowed to read pricing, promotions, and vouchers. */
export const PROMOTION_READER_ROLES = [
  "super_admin",
  "admin_operator_gia_km"
];

/** Admin roles allowed to mutate pricing, promotions, and vouchers. */
export const PROMOTION_OPERATOR_ROLES = ["super_admin", "admin_operator_gia_km"];

/** Safe column projection for price history rows. */
export const PRICE_HISTORY_SELECT = [
  "price_history_id", "product_id", "variant_id",
  "old_base_price", "new_base_price", "old_sale_price", "new_sale_price",
  "changed_by", "changed_at", "reason"
].join(",");

/** Safe column projection for promotion rows. */
export const PROMOTION_SELECT = [
  "promo_id", "promo_name", "promo_type", "applicable_categories",
  "start_date", "end_date", "is_active", "paused_at", "paused_by", "budget_limit",
  "max_vouchers_allowed", "total_discount_issued", "created_by", "version",
  "description", "banner_image_url", "highlight_label", "display_order", "is_featured"
].join(",");

/**
 * Kho chứa ảnh banner chiến dịch.
 *
 * Tách riêng khỏi kho `return-evidence` của ảnh bằng chứng đổi trả: hai loại tệp có
 * vòng đời và quyền đọc khác hẳn nhau — banner là nội dung công khai lâu dài, bằng
 * chứng đổi trả là dữ liệu của một khách cụ thể.
 *
 * Kho này phải được tạo trên Supabase trước khi tính năng tải ảnh dùng được; xem ghi
 * chú triển khai kèm migration 025-027.
 */
export const PROMOTION_BANNER_STORAGE = { bucket: "promotion-banners", prefix: "campaign" };

/** Safe column projection for voucher rows. */
export const VOUCHER_SELECT = [
  "voucher_id", "promo_id", "code", "name", "discount_type",
  "discount_value", "max_discount_amount", "min_order_value",
  "usage_limit_total", "usage_limit_per_user", "used_count",
  "applicable_categories", "applicable_user_group",
  "start_date", "end_date", "is_active", "created_by", "version"
].join(",");
