export const PROMOTION_TYPES = ["flash_sale", "combo_discount", "product_discount", "bulk_discount", "seasonal_sale"];

export const VOUCHER_TYPES = ["fixed_amount", "percentage", "free_shipping"];

export const PROMOTION_READER_ROLES = [
  "super_admin",
  "admin_operator_gia_km"
];

export const PROMOTION_OPERATOR_ROLES = ["super_admin", "admin_operator_gia_km"];

export const PRICE_HISTORY_SELECT = [
  "price_history_id", "product_id", "variant_id",
  "old_base_price", "new_base_price", "old_sale_price", "new_sale_price",
  "changed_by", "changed_at", "reason"
].join(",");

export const PROMOTION_SELECT = [
  "promo_id", "promo_name", "promo_type", "applicable_categories",
  "start_date", "end_date", "is_active", "budget_limit",
  "max_vouchers_allowed", "total_discount_issued", "created_by", "version"
].join(",");

export const VOUCHER_SELECT = [
  "voucher_id", "promo_id", "code", "name", "discount_type",
  "discount_value", "max_discount_amount", "min_order_value",
  "usage_limit_total", "usage_limit_per_user", "used_count",
  "applicable_categories", "applicable_user_group",
  "start_date", "end_date", "is_active", "created_by", "version"
].join(",");
