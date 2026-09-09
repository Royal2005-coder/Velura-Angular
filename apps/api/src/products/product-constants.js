/**
 * UC-A02 Product & Inventory constants.
 *
 * Mirrors the account-constants pattern: safe column projection, canonical
 * status/role enums, CSV template definition and SKU validation.
 */

/** Safe column projection for product listings – no internal/sensitive fields. */
export const PRODUCT_SELECT = [
  "product_id",
  "sku",
  "is_combo",
  "name",
  "slug",
  "description",
  "category_id",
  "brand",
  "base_price",
  "sale_price",
  "images",
  "style_tags",
  "color_tone",
  "occasions",
  "suitable_body_shapes",
  "status",
  "is_featured",
  "collection",
  "seo_title",
  "seo_description",
  "created_at",
  "updated_at",
  "version",
  "category:category(category_id,name,slug)",
  "variants:variant(variant_id,color,color_hex,size,stock_quantity,reserved_quantity,low_stock_threshold,version,updated_at)"
].join(",");

/** Safe column projection for product detail – includes category join. */
export const PRODUCT_DETAIL_SELECT = [
  PRODUCT_SELECT
].join(",");

/**
 * BR-A02-06: Valid product statuses.
 * on_sale     = Đang bán
 * hidden      = Tạm ẩn
 * out_of_stock = Hết hàng
 * discontinued = Ngừng bán
 */
export const PRODUCT_STATUSES = ["on_sale", "hidden", "out_of_stock", "discontinued"];

/** Allowed status transitions to enforce business rules. */
export const STATUS_TRANSITIONS = {
  on_sale: ["hidden", "out_of_stock", "discontinued"],
  hidden: ["on_sale", "discontinued"],
  out_of_stock: ["on_sale", "hidden", "discontinued"],
  discontinued: ["hidden"]
};

/**
 * BR-A02-01 / BR-A02-02: Role access matrix.
 * viewer can only read; product_admin can read + write.
 */
export const PRODUCT_ADMIN_ROLES = [
  "super_admin",
  "admin_operator_sanpham"
];

export const PRODUCT_VIEWER_ROLES = [
  ...PRODUCT_ADMIN_ROLES,
  "admin_viewer",
  "admin_operator_gia_km",
  "admin_operator_cskh_dt",
  "admin_operator_donhang"
];

/**
 * BR-A02-05: SKU validation pattern.
 * Format: 2-6 uppercase letters, dash, 3-10 alphanumeric characters.
 * Examples: VL-AO001, VL-QN002-BL-M
 */
export const SKU_PATTERN = /^[A-Z]{2,6}-[A-Z0-9]{2,20}(-[A-Z0-9]{1,10})*$/;

/**
 * BR-A02-07: Required CSV columns for bulk import.
 */
export const CSV_REQUIRED_COLUMNS = [
  "sku",
  "name",
  "base_price",
  "category_id"
];

export const CSV_OPTIONAL_COLUMNS = [
  "description",
  "sale_price",
  "status",
  "tags",
  "images",
  "image_url",
  "is_featured"
];

/** Maximum rows allowed in a single CSV import. */
export const CSV_MAX_ROWS = 500;

/** Default minimum stock threshold for low-stock alerts (BR-A02-10). */
export const DEFAULT_MIN_STOCK = 5;

/** Valid sort options for product listing. */
export const PRODUCT_ORDER_OPTIONS = [
  "created_at.desc",
  "created_at.asc",
  "name.asc",
  "name.desc",
  "sale_price.asc",
  "sale_price.desc",
  "updated_at.desc"
];

/** Valid color_tone values. */
export const COLOR_TONES = ["Warm", "Cool", "Neutral"];
