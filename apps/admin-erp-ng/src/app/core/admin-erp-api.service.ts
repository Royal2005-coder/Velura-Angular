import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, finalize, shareReplay } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdminListPayload } from './admin-erp-http';
import { AdminAuthMe } from './admin-erp-session.service';

export interface AdminAuditRow {
  audit_id?: string;
  timestamp?: string;
  actor_name?: string;
  actor_email?: string | null;
  actor_label?: string;
  actor_id?: string;
  actor_role?: string;
  actor_role_label?: string;
  module?: string;
  action?: string;
  action_label?: string;
  action_type?: string;
  target_id?: string;
  target_label?: string;
  old_value?: unknown;
  new_value?: unknown;
  change_summary?: string;
  /** Operator reason carried by status and stock audits; the API reads it out of the payload. */
  reason?: string | null;
  product_id?: string;
  product_sku?: string;
  product_name?: string;
  ip_address?: string;
  result?: string;
}

export interface AdminAccountRow {
  user_id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  role?: string;
  admin_role?: string;
  is_active?: boolean;
  is_verified?: boolean;
  locked_until?: string | null;
  lock_type?: string | null;
  lock_reason?: string | null;
  unlock_reason?: string | null;
  version?: number;
  created_at?: string;
  last_login_at?: string;
  date_of_birth?: string;
  gender?: string;
}

export interface AdminRoleRequestRow {
  request_id: string;
  target_user_id?: string;
  requested_role?: string;
  expires_at?: string;
  status?: string;
  version?: number;
}

export interface AdminReviewProduct {
  name?: string;
  sku?: string;
}

export interface AdminReviewRow {
  review_id: string;
  status?: string;
  rating?: number;
  comment?: string;
  content?: string;
  product?: AdminReviewProduct;
  product_id?: string;
  product_name?: string;
  user_id?: string;
  order_id?: string;
  submitted_at?: string;
  is_flagged_urgent?: boolean;
  admin_reply?: string | null;
  version?: number;
  images?: string[];
}

/**
 * Catalog product row as returned by the admin product projection. The same shape
 * serves the price workspace, so pricing fields stay optional-tolerant.
 */
export interface AdminProductRow {
  product_id: string;
  sku?: string;
  name: string;
  slug?: string;
  description?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  category_id?: string;
  category_name?: string | null;
  category?: { category_id?: string; name?: string } | null;
  brand?: string | null;
  base_price?: number;
  sale_price?: number | null;
  status?: string;
  images?: string[];
  /** Image URL to variant color; an URL without an entry is a common gallery image. */
  image_colors?: Record<string, string>;
  collection?: string | null;
  style_tags?: string[];
  color_tone?: string | null;
  occasions?: string[];
  suitable_body_shapes?: string[];
  updated_at?: string | null;
  created_at?: string | null;
  is_combo?: boolean;
  is_featured?: boolean;
  version?: number;
  variants?: AdminProductVariant[];
}

/** One sellable color/size combination; its stock is the only inventory the API writes today. */
export interface AdminProductVariant {
  variant_id: string;
  product_id?: string;
  /** Stable inventory identity, stored apart from the parent product SKU. */
  sku?: string;
  color?: string;
  color_hex?: string | null;
  size?: string;
  /** Garment measurements shown on the storefront size chart. */
  size_measurements?: Record<string, unknown> | null;
  stock_quantity?: number;
  reserved_quantity?: number;
  low_stock_threshold?: number;
  version?: number;
  updated_at?: string | null;
}

/** Category option for product forms and the category filter. */
export interface AdminCategoryRow {
  category_id: string;
  name: string;
  slug?: string;
  parent_id?: string | null;
  display_order?: number;
}

/** Variant at or below its own low-stock threshold, enriched with the owning product. */
export interface AdminLowStockRow {
  variant_id: string;
  product_id: string;
  product_name?: string | null;
  product_sku?: string | null;
  product_status?: string | null;
  color?: string;
  size?: string;
  stock_quantity: number;
  low_stock_threshold: number;
  /** Units missing to clear the threshold (0 when exactly at it). */
  shortage?: number;
  out_of_stock?: boolean;
}

/** On-screen alert from a stock adjustment; `emailQueued` false means the mail is waiting for retry. */
export interface AdminLowStockAlert {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  stock: number;
  threshold: number;
  emailQueued: boolean;
  retryRecorded: boolean;
  message: string;
}

/**
 * Result of a stock adjustment. The API answers with the updated variant columns
 * (`delta` path) or `{ success: true }` (threshold-only path), plus the alert it raised.
 */
export interface AdminStockUpdateResult {
  success?: boolean;
  variant_id?: string;
  stock_quantity?: number;
  low_stock_threshold?: number;
  version?: number;
  lowStockAlert?: AdminLowStockAlert | null;
}

/** Bulk stock answer: one line per variant plus every alert the same write raised. */
export interface AdminBulkStockResult {
  success: boolean;
  results: Array<{ variantId: string; success: boolean }>;
  lowStockAlerts?: AdminLowStockAlert[];
}

/** Answer of the inline SKU uniqueness check. */
export interface AdminSkuCheck {
  sku: string;
  available: boolean;
  code: 'SKU_INVALID' | 'SKU_DUPLICATE' | null;
  message: string | null;
}

/** Combo component and the projected price of its product. */
export interface AdminComboItemRow {
  combo_item_id: string;
  combo_product_id: string;
  component_product_id: string;
  component_variant_id?: string | null;
  quantity: number;
  product?: {
    product_id: string;
    name: string;
    sku?: string;
    base_price?: number;
    sale_price?: number | null;
    images?: string[];
  } | null;
}

export interface AdminImageCriterion {
  key: 'lighting' | 'background' | 'sharpness' | 'resolution';
  label: string;
  score: number;
  status: 'good' | 'warning' | 'poor';
  detail: string;
}

/** Studio quality measurement of exactly one image URL or upload. */
export interface AdminImageQualityAnalysis {
  overallScore: number;
  passed: boolean;
  needsEnhancement: boolean;
  grade: 'A' | 'B' | 'C' | 'D';
  statusLabel: string;
  summary: string;
  metrics: {
    width: number;
    height: number;
    brightness: number;
    contrast: number;
    sharpnessScore: number;
    backgroundScore: number;
  };
  criteria: AdminImageCriterion[];
  recommendations: string[];
  uploadedUrl?: string;
}

export interface AdminImageEnhanceResult {
  enhancedUrl: string;
  previewDataUrl: string;
  modelUsed: string;
  improvements: string[];
  beforeAnalysis: AdminImageQualityAnalysis;
  afterAnalysis: AdminImageQualityAnalysis;
}

/** Server-attested image URL, not yet published; the product save consumes its version-bound approval. */
export interface AdminImageApproval {
  approvalId: string;
  url: string;
  sourceRevision: string;
  processingVersion: string;
  /** Measured studio score (0-100) of exactly this approved URL. */
  qualityScore?: number;
  expiresAt: string;
}

/** Gemini fashion-content suggestion set applied field by field by the operator. */
export interface AdminProductFashionSeoResult {
  description: string;
  seoTitle: string;
  seoDescription: string;
  titleSuggestions?: string[];
  metaSuggestions?: string[];
  slug: string;
  collection: string;
  material: string;
  colorTone: 'Warm' | 'Cool' | 'Neutral';
  styleTags: string[];
  occasions: string[];
  suitableBodyShapes: string[];
  highlights: string[];
  careInstructions: string[];
  seoKeywords: string[];
  seoScore: number;
  modelUsed: string;
}

/** Per-row CSV import finding; `row` is the 1-based spreadsheet line. */
export interface AdminCsvIssue {
  row?: number;
  field?: string;
  message?: string;
  csv_value?: number | null;
  current_value?: number | null;
}

/** Preview line of a CSV import, resolved against the catalog by the API. */
export interface AdminCsvPreviewRow {
  row: number;
  sku: string;
  product_sku?: string | null;
  name?: string;
  base_price?: number;
  sale_price?: number | null;
  csv_base_price?: number;
  csv_sale_price?: number | null;
  /** Price columns the import deliberately ignores because a stored price already exists. */
  skipped_prices?: string[];
  category_id?: string;
  description?: string | null;
  status?: string | null;
  image_url?: string | null;
  is_featured?: boolean | null;
  color?: string | null;
  size?: string | null;
  color_hex?: string | null;
  stock_quantity?: number | null;
  low_stock_threshold?: number | null;
  product_id?: string | null;
  variant_id?: string | null;
  expected_version?: number | null;
  variant_version?: number | null;
  operation?: 'created' | 'updated';
}

/** Result of the CSV pre-flight: only an error-free preview can authorize a commit. */
export interface AdminCsvPreview {
  rows?: AdminCsvPreviewRow[];
  errors?: AdminCsvIssue[];
  warnings?: AdminCsvIssue[];
  totalRows?: number;
  validRows?: number;
}

/** Result of a CSV commit; `failed` must be verified before the file is discarded. */
export interface AdminCsvCommitResult {
  created?: number;
  updated?: number;
  failed?: number;
  total?: number;
  results?: Array<{ sku: string; status: 'created' | 'updated'; product_id?: string; variant_id?: string | null }>;
  warnings?: AdminCsvIssue[];
  skippedPrices?: number;
}

/** Variant line of a create-product matrix; `sku` must stay unique across the whole catalog. */
export interface AdminProductVariantInput {
  sku?: string;
  color: string;
  colorHex?: string | null;
  size: string;
  stockQuantity: number;
  lowStockThreshold: number;
}

/**
 * Create-product payload. The API rejects `out_of_stock`/`discontinued` on create and
 * requires `expectedVersion: 0`, one primary image for `on_sale`, and unique color|size.
 */
export interface AdminProductCreateInput {
  sku: string;
  name: string;
  slug: string;
  categoryId: string;
  brand?: string | null;
  basePrice: number;
  salePrice: number;
  status: 'on_sale' | 'hidden';
  collection?: string | null;
  description?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  colorTone?: string | null;
  styleTags?: string[];
  occasions?: string[];
  suitableBodyShapes?: string[];
  isFeatured?: boolean;
  isCombo?: boolean;
  images: string[];
  imageColors?: Record<string, string>;
  variants?: AdminProductVariantInput[];
  initialStock?: number;
  lowStockThreshold?: number;
  material?: string | null;
  expectedVersion: 0;
}

/**
 * Update-product payload. `status`, `basePrice` and `salePrice` are forbidden here;
 * they travel through change-status and change-price so each write keeps its own audit reason.
 */
export interface AdminProductUpdateInput {
  name?: string;
  categoryId?: string;
  brand?: string | null;
  collection?: string | null;
  description?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  colorTone?: string | null;
  styleTags?: string[];
  occasions?: string[];
  suitableBodyShapes?: string[];
  isFeatured?: boolean;
  images?: string[];
  imageColors?: Record<string, string>;
  expectedVersion: number;
}

/** Stock write for one variant: a signed delta, an optional new threshold, and the operator reason. */
export interface AdminStockAdjustInput {
  variantId: string;
  delta: number;
  reason: string;
  expectedVersion: number;
  lowStockThreshold?: number;
}

/** Single line of a bulk stock adjustment across the variants of one product. */
export interface AdminBulkStockLine {
  variantId: string;
  delta: number;
  lowStockThreshold?: number;
  expectedVersion?: number;
}

export interface AdminBulkStockInput {
  updates: AdminBulkStockLine[];
  reason: string;
}

/** Status write through change-status; the reason is audited and must be 10-500 characters. */
export interface AdminStatusChangeInput {
  status: string;
  reason: string;
  expectedVersion: number;
}

/** Price write through change-price, bound to the product version read by the operator. */
export interface AdminPriceChangeInput {
  newBasePrice: number;
  newSalePrice: number | null;
  reason: string;
  expectedVersion: number;
}

export interface AdminPriceHistoryRow {
  changed_at?: string;
  product_id?: string;
  old_base_price?: number;
  new_base_price?: number;
  old_sale_price?: number;
  new_sale_price?: number;
  reason?: string;
  changed_by?: string;
  product?: { name?: string; sku?: string } | null;
}

export interface AdminOrderPayment {
  payment_id?: string;
  payment_status?: string;
  payment_method?: string;
  payment_provider?: string;
  gateway_response_code?: string | null;
  amount?: number;
  refund_amount?: number | null;
  refund_reason?: string | null;
  refund_at?: string | null;
  paid_at?: string | null;
  has_discrepancy?: boolean;
  created_at?: string;
  version?: number;
}

export type AdminOrderActionField = 'call_result' | 'shortage' | 'shipment' | 'cancel_reason' | 'tracking';

export interface AdminOrderAction {
  code: string;
  label: string;
  to_status: string | null;
  requires_note: boolean;
  fields: AdminOrderActionField[];
  destructive: boolean;
}

export interface AdminOrderEvent {
  event_id?: string;
  action?: string;
  actor_type?: string;
  actor_id?: string | null;
  actor_role?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  result?: string | null;
  note?: string | null;
  payload?: Record<string, unknown> | null;
  created_at?: string;
}

/** Ảnh/video bằng chứng gắn với một công đoạn của đơn hàng. */
export interface AdminOrderEvidence {
  evidence_id?: string;
  stage?: string;
  kind?: 'image' | 'video';
  mime_type?: string;
  note?: string;
  uploaded_by?: string;
  created_at?: string;
  /** Signed URL 15 phút; rỗng khi storage không ký được. */
  url?: string;
  unavailable?: boolean;
}

export interface AdminOrderRow {
  order_id: string;
  order_code?: string;
  order_date?: string;
  created_at?: string;
  status?: string;
  status_label?: string;
  payment_method?: string;
  payment_status?: string | null;
  payment_status_label?: string | null;
  shipping_name?: string;
  shipping_phone?: string;
  shipping_address?: string;
  shipping_fee?: number;
  subtotal?: number;
  discount_amount?: number;
  tracking_code?: string | null;
  carrier?: string | null;
  tracking_url?: string | null;
  handed_over_at?: string | null;
  shipment_voided_at?: string | null;
  returned_to_stock_at?: string | null;
  cancelled_reason?: string | null;
  internal_note?: string | null;
  total_amount?: number;
  version?: number;
  tags?: Array<{ code: string; label: string }>;
  allowed_actions?: AdminOrderAction[];
  can_simulate_carrier?: boolean;
  payments?: AdminOrderPayment[];
  items?: Array<{ item_id?: string; order_item_id?: string; variant_id?: string; product_id?: string; product_name?: string; quantity?: number; unit_price?: number }>;
  history?: Array<{ old_status?: string | null; new_status?: string; changed_at?: string; note?: string; trigger_type?: string }>;
  events?: AdminOrderEvent[];
  evidence?: AdminOrderEvidence[];
  user_id?: string;
  user?: {
    user_id?: string;
    email?: string | null;
    phone?: string | null;
    full_name?: string | null;
    is_active?: boolean | null;
    role?: string | null;
  } | null;
  is_guest?: boolean;
  has_successful_call_confirm?: boolean;
  requires_call_confirmation?: boolean;
}

export interface AdminOrderSummary {
  by_status: Array<{ status: string; label: string; count: number }>;
  attention: number;
}

export interface AdminOrderActionResult {
  order: AdminOrderRow;
  refund: { status: 'refunded' | 'requested' | 'failed' | 'skipped'; message?: string } | null;
}

/** Một bài viết CMS. `status` là nháp/đã công bố/đã lưu trữ; bản nháp chỉ admin thấy. */
export interface AdminBlogRow {
  blog_id: string;
  slug: string;
  title: string;
  category_slug?: string;
  excerpt?: string;
  content?: string;
  image_url?: string | null;
  author?: string;
  read_minutes?: number;
  is_featured?: boolean;
  status?: string;
  published_at?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
  updated_by?: string | null;
}

/** Danh mục nội dung mà RPC CMS bắt buộc bài viết phải trỏ tới (`content_type = 'blog'`). */
export interface AdminContentCategory {
  content_category_id: string;
  content_type: string;
  slug: string;
  name: string;
  display_order?: number;
}

/** Body tạo/cập nhật bài viết. Khi sửa phải gửi `expectedVersion` của bản đang mở. */
export interface AdminBlogInput {
  slug: string;
  title: string;
  categorySlug: string;
  status: string;
  content: string;
  excerpt?: string;
  imageUrl?: string | null;
  author?: string;
  readMinutes?: number;
  isFeatured?: boolean;
  expectedVersion?: number;
}

/**
 * Một thành viên cùng ví điểm của họ. Điểm đọc từ `loyalty_account`, không phải `users.loyalty_points`
 * (cột cũ đang bằng 0 ở production dù ví có điểm). Số dư âm = còn nợ điểm sau khi hoàn hàng.
 */
export interface AdminMemberRow {
  user_id: string;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean;
  created_at?: string;
  wallet_exists?: boolean;
  balance_milli_points?: number;
  debt_milli_points?: number;
  accrual_locked?: boolean;
  warning_flags?: number;
  referral_code?: string | null;
  account_updated_at?: string | null;
  ledger_entries?: number;
  last_ledger_at?: string | null;
  referrals?: number;
  vouchers_available?: number;
}

/** Tổng quan ví điểm của toàn bộ thành viên (`admin_member_overview`). */
export interface AdminMemberOverview {
  members?: number;
  with_wallet?: number;
  total_points_milli?: number;
  negative_accounts?: number;
  locked_accounts?: number;
  flagged_accounts?: number;
  referrals_pending?: number;
  referrals_successful?: number;
  vouchers_available?: number;
  ledger_entries?: number;
  zero_entries?: number;
  earliest_expiry?: string | null;
  last_ledger_at?: string | null;
}

/** Một bút toán điểm, kèm đơn/phiếu đổi trả để mở thẳng hồ sơ nguồn. */
export interface AdminMemberLedgerRow {
  ledger_id: string;
  kind: string;
  amount_milli_points: number;
  balance_after_milli_points: number;
  expires_at?: string | null;
  note?: string | null;
  created_at: string;
  order_id?: string | null;
  order_code?: string | null;
  order_status?: string | null;
  return_id?: string | null;
  return_status?: string | null;
}

export interface AdminMemberReferralRow {
  referral_id: string;
  role: 'referrer' | 'referred';
  counterpart_name?: string | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  reversed_at?: string | null;
  qualifying_order_id?: string | null;
  qualifying_order_code?: string | null;
}

export interface AdminMemberVoucherRow {
  member_voucher_id: string;
  voucher_id: string;
  code?: string | null;
  name?: string | null;
  benefit: string;
  status: string;
  issued_at: string;
  expires_at?: string | null;
  used_order_id?: string | null;
  revoked_at?: string | null;
}

/** Hồ sơ một thành viên: ví, tổng hợp, dấu vết bút toán, giới thiệu và voucher. */
export interface AdminMemberDetail {
  user: {
    user_id: string;
    full_name?: string | null;
    email?: string | null;
    phone?: string | null;
    is_active?: boolean;
    created_at?: string;
  };
  account: {
    balance_milli_points: number;
    debt_milli_points: number;
    points_balance: number;
    warning_flags: number;
    accrual_locked: boolean;
    referral_code?: string | null;
    updated_at?: string;
  } | null;
  totals: {
    earned_milli: number;
    reversed_milli: number;
    ledger_entries: number;
    zero_entries: number;
    delivered_orders: number;
    refunded_returns: number;
  };
  trail: AdminMemberLedgerRow[];
  referrals: AdminMemberReferralRow[];
  vouchers: AdminMemberVoucherRow[];
}

/** Kết quả khoá/mở tích luỹ. `changed=false` nghĩa là ví đã ở đúng trạng thái đó từ trước. */
export interface AdminMemberLockResult {
  user_id: string;
  accrual_locked: boolean;
  changed: boolean;
}

export interface AdminPromotionRow {
  promo_id?: string;
  promotion_id?: string;
  promo_name?: string;
  name?: string;
  promo_type?: string;
  type?: string;
  status?: string;
  is_active?: boolean;
  start_date?: string;
  end_date?: string;
  budget?: number;
  budget_limit?: number;
  max_vouchers_allowed?: number;
  total_discount_issued?: number;
  version?: number;
  paused_at?: string | null;
  lifecycle_status?: 'scheduled' | 'running' | 'paused' | 'ended' | 'budget_exhausted';
  lifecycle_label?: string;
  can_activate?: boolean;
  can_pause?: boolean;
  budget_unlimited?: boolean;
  budget_tracked?: boolean;
  voucher_count?: number;
  active_voucher_count?: number;
  warnings?: Array<{ code: string; level: 'info' | 'warning' | 'danger'; message: string }>;
  description?: string | null;
  banner_image_url?: string | null;
  highlight_label?: string | null;
  display_order?: number | null;
  is_featured?: boolean | null;
}

export interface AdminPromotionSummary {
  total: number;
  running: number;
  scheduled: number;
  paused: number;
  ended: number;
  budgetExhausted: number;
  totalBudget: number;
  issuedDiscount: number;
  budgetedCampaigns: number;
  activeVouchers: number;
}

export interface AdminPromotionListPayload extends AdminListPayload<AdminPromotionRow> {
  summary?: AdminPromotionSummary;
}

export interface AdminVoucherRow {
  voucher_id: string;
  code?: string;
  name?: string;
  discount_type?: string;
  type?: string;
  discount_value?: number;
  value?: number;
  min_order?: number;
  min_order_value?: number;
  used_count?: number;
  usage_limit_total?: number | null;
  usage_limit_per_user?: number;
  max_discount_amount?: number | null;
  applicable_categories?: string[] | string | null;
  start_date?: string;
  end_date?: string;
  expires_at?: string;
  is_active?: boolean;
  promo_id?: string | null;
  applicable_user_group?: string;
  version?: number;
}

export interface AdminCampaignStatistic {
  promoId: string | null;
  name: string;
  lifecycle: AdminPromotionRow['lifecycle_status'] | null;
  lifecycleLabel: string | null;
  vouchers: number;
  orders: number;
  revenue: number;
  discount: number;
  revenuePerDiscount: number | null;
  budgetLimit: number;
  budgetUsed: number;
}

export interface AdminPricingStatistics {
  range: { from: string | null; to: string | null };
  orders: {
    total: number;
    withVoucher: number;
    voucherRate: number;
    revenueWithVoucher: number;
    revenueWithoutVoucher: number;
    revenueShareWithVoucher: number;
    discountTotal: number;
    aovWithVoucher: number;
    aovWithoutVoucher: number;
  };
  promotions: AdminPromotionSummary & { budgetRemaining: number; budgetUsagePercent: number };
  vouchers: {
    total: number;
    active: number;
    scheduled: number;
    expired: number;
    disabled: number;
    unlimited: number;
    totalUsed: number;
    totalLimit: number;
    usagePercent: number;
  };
  campaigns: AdminCampaignStatistic[];
  topVouchers: Array<{ voucherId: string; code: string; orders: number; discount: number; revenue: number }>;
}

/** Payment channel of a return; it decides which refund flow the operator may run. */
export type AdminPaymentKind = 'cod' | 'stripe' | 'other_online';

/** Server-side refund-channel filter: `online` covers Stripe and other gateways. */
export type AdminPaymentFilter = 'cod' | 'online';

/** Refund route recorded on the return. */
export type AdminRefundFlow = 'cod_manual' | 'stripe_auto' | 'manual_transfer' | 'none';

/** State of the customer's payout details for a refundable return. */
export type AdminRefundReceiverStatus = 'not_required' | 'missing' | 'invalid' | 'supplement_requested' | 'valid';

/** Who cancelled a return. */
export type AdminReturnCancelledBy = 'customer' | 'admin' | 'system';

/** Persisted return states, shared with the API and its migration. */
export type AdminReturnStatus =
  | 'REQUESTED'
  | 'CONTACTING'
  | 'IN_PROGRESS'
  | 'PARTIALLY_APPROVED'
  | 'REJECTED'
  | 'WAITING_RETURN'
  | 'RETURN_IN_TRANSIT'
  | 'RECEIVED'
  | 'REFUND_PROCESSING'
  | 'REFUNDED'
  | 'EXCHANGE_PREPARING'
  | 'EXCHANGE_SHIPPING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NEEDS_SUPPORT';

/** Payout details the customer supplied for a COD return. */
export interface AdminRefundReceiver {
  status: AdminRefundReceiverStatus;
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
  submitted_at: string | null;
  supplement_request: string | null;
  supplement_requested_at: string | null;
}

/** Reconciliation of a manual refund, read-only on the return detail. */
export interface AdminManualRefund {
  reference: string;
  amount: number;
  transferred_at: string;
  proof: string;
  note: string | null;
  recorded_at: string;
  payment_kind: 'cod' | 'other_online';
  receiver_bank_name: string | null;
  receiver_account_number: string | null;
  receiver_account_holder: string | null;
}

/** Payment facts that constrain what a refund may be issued for. */
export interface AdminReturnPayment {
  payment_id?: string;
  payment_method?: string;
  payment_provider?: string;
  payment_status?: string;
  amount?: number;
  gateway_transaction_ref?: string;
  refund_at?: string;
  refund_amount?: number;
  gateway_response_code?: string;
  order_id?: string;
  refunded_amount?: number;
  created_at?: string;
}

/** One versioned quantity part of an original order line, with independent decision and progress. */
/** Available replacement variant of the same product for exchange selection. */
export interface AdminReturnReplacementChoice {
  variant_id: string;
  sku?: string;
  color?: string;
  size?: string;
  stock_quantity?: number;
  reserved_quantity?: number;
  available_stock?: number;
  is_current?: boolean;
}

export interface AdminReturnLine {
  return_item_id?: string;
  version?: number;
  item_status?: string;
  decision_status?: 'pending' | 'approved' | 'rejected';
  resolution_type?: 'refund' | 'exchange';
  replacement_variant_id?: string | null;
  product_id?: string;
  product_name?: string;
  current_variant_id?: string;
  variant_id?: string;
  replacement_choices?: AdminReturnReplacementChoice[];
  exchange_order_id?: string | null;
  exchange_order?: AdminReturnExchangeOrder | null;
  refund_amount?: number;
  refundable_amount?: number;
  attention_status?: string | null;
  reason?: string | null;
  decision_reason?: string | null;
  received_quantity?: number;
  matches_product?: boolean | null;
  tags_intact?: boolean | null;
  condition_acceptable?: boolean | null;
  package_match?: boolean | null;
  seal_intact?: boolean | null;
  receipt_proof_ref?: string | null;
  approved_at?: string | null;
  receipt_at?: string | null;
  completed_at?: string | null;
  order_item_id?: string;
  quantity?: number;
  disposition?: AdminReturnDisposition | string | null;
  disposition_note?: string | null;
  restocked_at?: string | null;
  stock_restored_quantity?: number;
}

export type AdminReturnDisposition = 'restock' | 'repair' | 'scrap' | 'return_supplier';

/** Inbound (customer -> warehouse) or outbound (warehouse -> customer) return shipment. */
export interface AdminReturnShipment {
  shipment_id?: string;
  direction?: 'inbound' | 'outbound';
  order_id?: string | null;
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
  label_url?: string | null;
  handover_code?: string | null;
  status?: 'pending' | 'label_ready' | 'picked_up' | 'in_transit' | 'delivered' | 'failed' | 'cancelled' | string;
  picked_up_at?: string | null;
  delivered_at?: string | null;
  pickup_photo_urls?: string[];
  package_video_url?: string | null;
}

/** One return timeline event, including shipment/custody facts. */
export interface AdminReturnEvent {
  event_id?: string;
  event_type?: 'status' | 'shipment' | 'pickup' | 'customer_evidence' | string;
  old_status?: string | null;
  new_status?: string | null;
  payload?: Record<string, unknown>;
  note?: string | null;
  created_at?: string;
}

/** One stored evidence object; `url` is a short-lived signed URL. */
export interface AdminReturnEvidence {
  evidence_id?: string;
  kind?: string;
  url?: string | null;
  storage_ref?: string | null;
  mime_type?: string | null;
  uploaded_by_role?: string;
  note?: string | null;
  created_at?: string;
}

/** Linked replacement order created from an exchange return. */
export interface AdminReturnExchangeOrder {
  order_id?: string;
  order_code?: string;
  status?: string;
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
  order_kind?: string;
  shipping_name?: string | null;
  shipping_phone?: string | null;
  shipping_address?: string | null;
  items?: Array<{
    item_id?: string;
    product_name?: string;
    quantity?: number;
    unit_price?: number;
    color?: string;
    size?: string;
    sku?: string;
  }>;
}

/** Customer return request; QA and gateway facts constrain the operations offered. */
export interface AdminReturnRow {
  return_id: string;
  order_id?: string;
  order_code?: string;
  user_id?: string;
  status?: AdminReturnStatus | string;
  decision_status?: string;
  progress_status?: string;
  attention_status?: string | null;
  request_type?: string;
  return_type?: string;
  description?: string;
  reason?: string;
  created_at?: string;
  resolved_at?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  order_total?: number;
  payment_method?: string;
  version?: number;
  refundable_amount?: number;
  refund_amount?: number;
  admin_note?: string;
  rejection_reason?: string;
  payment_kind?: AdminPaymentKind;
  refund_flow?: AdminRefundFlow;
  refund_receiver_status?: AdminRefundReceiverStatus;
  cancelled_by?: AdminReturnCancelledBy | null;
  refund_receiver?: AdminRefundReceiver | null;
  manual_refund?: AdminManualRefund | null;
  evidence_images?: string[];
  evidence_videos?: string[];
  tracking_return_code?: string;
  /** The outbound replacement leg must never reuse the customer's return tracking. */
  exchange_tracking_code?: string;
  exchange_order_id?: string;
  exchange_order_code?: string;
  exchange_order_status?: string;
  condition_check_result?: string;
  /** Package-level QA facts required by the DB guard before RECEIVED. */
  package_match?: boolean | null;
  seal_intact?: boolean | null;
  qa_note?: string | null;
  /** Warehouse photo of the QA check; proof of the receipt step. */
  warehouse_proof?: string | null;
  /** Receipt lines are stored verbatim in camelCase, so readers must not snake_case them. */
  qa_item_receipts?: AdminReturnReceiptLine[];
  contact_due_at?: string | null;
  refund_bank_name?: string | null;
  refund_bank_account?: string | null;
  refund_bank_holder?: string | null;
  lines?: AdminReturnLine[];
  payment?: AdminReturnPayment | null;
  /** Immutable return slip code (separate from the carrier AWB). */
  return_code?: string;
  shipments?: AdminReturnShipment[];
  shipment?: AdminReturnShipment | null;
  exchange_shipment?: AdminReturnShipment | null;
  events?: AdminReturnEvent[];
  evidence?: AdminReturnEvidence[];
  exchange_order?: AdminReturnExchangeOrder | null;
}


/** Result of one outreach attempt on a return in `CONTACTING`. */
export interface AdminReturnContactInput {
  result: string;
  note: string;
  expectedVersion: number;
}

/** Warehouse receipt of returned goods, line by line, with photographic proof. */
export interface AdminReturnReceiptLine {
  orderItemId: string;
  receivedQuantity: number;
  matchesProduct: boolean;
  /** Per-line warehouse disposition; only `restock` adds sellable stock. */
  disposition: AdminReturnDisposition;
  dispositionNote?: string;
}


/** Reconciliation record of a refund paid outside the gateway. */
export interface AdminManualRefundInput {
  expectedVersion: number;
  returnItemId: string;
  transferReference: string;
  amount: number;
  /** Transfer instant in ISO 8601; the API rejects a future timestamp. */
  transferredAt: string;
  imageProof: string;
  adminNote?: string;
}

/** CSKH asks the customer to complete their payout details; the return keeps its state. */
export interface AdminRefundInfoRequestInput {
  message: string;
  expectedVersion: number;
}

/** Per-part workflow commands; request type is never rewritten by a resolution change. */
export type AdminReturnItemAction = 'approve' | 'reject' | 'wait_return' | 'pickup' | 'receive'
  | 'needs_support' | 'resolve' | 'stop' | 'convert_refund' | 'change_variant'
  | 'prepare_exchange' | 'ship_exchange' | 'complete_exchange';

/** Flat payload consumed by the item action RPC under optimistic concurrency. */
export interface AdminReturnItemActionInput {
  action: AdminReturnItemAction;
  expectedVersion: number;
  quantity?: number;
  reason?: string;
  customerConsent?: boolean;
  replacementVariantId?: string;
  receivedQuantity?: number;
  matchesProduct?: boolean;
  tagsIntact?: boolean;
  conditionAcceptable?: boolean;
  packageMatch?: boolean;
  sealIntact?: boolean;
  disposition?: AdminReturnDisposition;
  dispositionNote?: string;
  receiptProofRef?: string;
  trackingNumber?: string;
  carrier?: string;
  photoUrls?: string[];
  videoUrl?: string;
  pickedUpBy?: string;
  pickedUpAt?: string;
}

/** Support ticket; chat-linked tickets stay read-only and are worked in their chat session. */
export interface AdminTicketRow {
  ticket_id: string;
  chat_session_id?: string | null;
  user_id?: string;
  status?: string;
  subject?: string;
  title?: string;
  description?: string;
  priority?: string;
  guest_phone?: string;
  guest_email?: string;
  admin_reply?: string;
  csat_score?: number;
  created_at?: string;
  resolved_at?: string;
  version?: number;
}

export interface AdminTicketReplyInput {
  response: string;
  expectedVersion: number;
}

export interface AdminTicketNoteInput {
  adminNote: string;
  expectedVersion: number;
}

export interface AdminTicketCloseInput {
  /** The RPC records only the closure; a note is kept out of the contract on purpose. */
  reason?: string;
  expectedVersion: number;
}

/** Model labels an agent may correct; never used for automatic training. */
export interface AdminChatClassification {
  intent: 'facts' | 'catalog' | 'policy_problem' | 'order' | 'human';
  level: 'L0' | 'L1' | 'L2' | 'L3';
  issue: 'general' | 'catalog' | 'sizing' | 'delivery' | 'return' | 'payment' | 'cancellation';
  sentiment: 'positive' | 'neutral' | 'negative';
  risk: 'green' | 'yellow' | 'orange' | 'red';
  moderation: 'none' | 'abuse' | 'threat' | 'illegal' | 'sensitive';
}

/** Provider measurements shown beside, never merged into, the staff-correctable labels. */
export interface AdminChatObservedClassification extends AdminChatClassification {
  emotion?: { state: 'calm' | 'frustrated' | 'angry' | 'distressed'; confidence: number; reasons: string[] };
  riskAssessment?: { confidence: number; reasons: string[] };
  context?: { escalationTrend?: 'stable' | 'rising' | 'falling' };
}

/** Filtered case context; a pending or outage classification is not a safe label to show. */
export interface AdminChatContext {
  guest_email?: string;
  supervisor_required?: boolean;
  handoff_summary?: {
    summary?: string;
    problem?: string;
    wanted?: string;
    failed_approaches?: string[];
    verified_status?: string;
    risk?: string;
    sentiment?: string;
    confirmed_facts?: string[];
    unconfirmed_claims?: string[];
    unresolved_need?: string;
    recommendations?: string[];
  };
  intelligence?: {
    confidence?: number;
    reasons?: string[];
    trend?: string;
    updated_at?: string;
    source_seq?: number;
    filter_status?: 'ready' | 'pending' | 'outage';
    corrected?: boolean;
    customer_sentiment?: string;
    staff_sentiment?: string;
    classification?: AdminChatObservedClassification;
  };
  warnings?: Array<{ id: string; text: string; action?: string; resolved?: boolean }>;
  report_status?: {
    report_id?: string;
    state?: string;
    last_error?: string;
    updated_at?: string;
    attempts?: number;
    next_attempt_at?: string;
  };
  eligible_offers?: Array<{ offer_id: string; title: string; description?: string }>;
  summary_confirmation?: { confirmed: boolean; by?: string; at?: string };
  outcome?: { resolution?: string; finalSentiment?: string; rating?: number };
}

/** Staff-owned case; previews and metadata are filtered by the server. */
export interface AdminChatSessionRow {
  session_id: string;
  is_active?: boolean;
  updated_at?: string;
  title?: string;
  support_ticket_id?: string | null;
  context_revision?: number;
  profile_user_id?: string;
  assigned_admin_id?: string | null;
  previous_session_id?: string | null;
  last_message_preview?: string;
  last_message_at?: string;
  created_at?: string;
  guest_id?: string;
  handoff_status?: string;
  risk_level?: 'green' | 'yellow' | 'orange' | 'red';
  assigned_to?: string | null;
  assigned_agent_name?: string;
  metadata?: AdminChatContext;
}

/** Public transcript only; originals need an audited supervisor request. */
export interface AdminChatMessageRow {
  message_id?: string;
  sender?: string;
  text?: string;
  moderation_status?: 'pending' | 'visible' | 'restricted';
  created_at?: string;
  session_id?: string;
  sequence?: number;
  product_ids?: string[];
  metadata?: {
    product_ids?: string[];
    risk?: string;
    moderated?: boolean;
    system?: boolean;
    speaker?: string;
    agent_name?: string;
    agent_joined?: boolean;
    filter_verified?: boolean;
    classification?: AdminChatObservedClassification;
  };
}

export interface AdminChatProductCard {
  product_id: string;
  name?: string;
  image_url?: string;
  base_price?: number;
  sale_price?: number;
  price?: number;
  detail_url?: string;
  variant?: string;
}

/** Transcript of a case: the last 150 public turns, the case row and its product cards. */
export interface AdminChatMessagesPayload {
  messages?: AdminChatMessageRow[];
  products?: AdminChatProductCard[];
  session?: AdminChatSessionRow;
  blogs?: unknown[];
  handoff?: { ticketId?: string; status?: string } | null;
}

/** Confirmed human decision on a case; it never grants a financial benefit by itself. */
export interface AdminChatReviewInput {
  action:
    | 'correction'
    | 'outcome'
    | 'supervisor'
    | 'moderate'
    | 'refilter'
    | 'summary'
    | 'resolve'
    | 'reopen'
    | 'offer'
    | 'report_retry';
  text: string;
  messageId?: string;
  classification?: AdminChatClassification;
  risk?: 'yellow' | 'orange' | 'red';
  confirmed: true;
  summary?: { problem: string; wanted: string; failed_approaches: string[] };
  outcome?: { resolution: string; finalSentiment: 'positive' | 'neutral' | 'negative' };
  offerId?: string;
  reportId?: string;
  filteredText?: string;
}

/** The server audits every supervisor access to quarantined original content. */
export interface AdminChatOriginal {
  message_id: string;
  original_text: string;
  risk: string;
  reason: string;
  original_metadata?: { attachment?: { data?: string; filename?: string; mimeType?: string } };
}

export type AdminInsightRange = 'day' | 'week' | 'month';

export interface AdminDashboardSummary {
  operations: {
    pendingOrders: number;
    paymentErrors: number;
    openReturns: number;
    openSupportTickets: number;
    lowStockProducts: number;
    urgentReviews: number;
  };
  business: {
    revenue: number | null;
    orderCount: number | null;
    averageOrderValue: number | null;
    completionRate: number | null;
    promotionRevenue: number | null;
    promotionRevenueShare: number | null;
    pendingReviews: number | null;
    comparisons?: {
      revenuePct?: number | null;
      orderCountPct?: number | null;
      aovPct?: number | null;
      completionRatePoints?: number | null;
    };
    customers?: number;
    customerCount?: number;
    categoryContributions?: Array<{ category_id?: string; name: string; revenue: number; pct: number }>;
    bestSellers?: Array<{
      product_id?: string;
      name: string;
      sku?: string;
      sold?: number;
      revenue: number;
      lowStock?: boolean;
    }>;
    revenueTrend?: Array<{ date: string; dateStr: string; revenue: number; orderCount: number }>;
  };
  recentLogs?: AdminAuditRow[];
  periodDays?: number;
  range?: string;
  meta?: {
    generatedAt?: string | null;
    source?: string;
    freshness?: 'fresh' | 'stale' | 'unavailable';
    sourceWarning?: string | null;
    validated?: boolean;
  };
}

/**
 * Typed HTTP model for the ERP admin. Endpoints are added per workspace; pages never
 * construct URLs or call `HttpClient` directly.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;
  private meInFlight$: Observable<AdminAuthMe> | null = null;

  /**
   * Verifies the current admin context and returns pages, modules and capabilities.
   */
  /**
   * Reads the current admin context. Concurrent calls (shell guard + child guard) share
   * one request instead of double-hydrating the session.
   */
  me(): Observable<AdminAuthMe> {
    if (!this.meInFlight$) {
      this.meInFlight$ = this.http.get<AdminAuthMe>(`${this.baseUrl}/api/auth/me`).pipe(
        finalize(() => {
          this.meInFlight$ = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.meInFlight$;
  }

  /**
   * Signs in through the API password grant.
   */
  signIn(email: string, password: string): Observable<{ token?: string }> {
    return this.http.post<{ token?: string }>(`${this.baseUrl}/api/auth/signin`, { email, password });
  }

  /**
   * Records sign-out on the API.
   */
  signOut(): Observable<{ success?: boolean }> {
    return this.http.post<{ success?: boolean }>(`${this.baseUrl}/api/auth/signout`, {});
  }

  /**
   * Sends a password-reset email without revealing whether the account exists.
   */
  requestPasswordReset(email: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/auth/recover`, { email });
  }

  /**
   * Changes the signed-in admin password after checking the current one.
   */
  changePassword(currentPassword: string, newPassword: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.baseUrl}/api/auth/change-password`, {
      currentPassword,
      newPassword,
    });
  }

  /**
   * Exchanges a Google PKCE auth code for an access token.
   */
  exchangePkce(authCode: string, codeVerifier: string, redirectUri: string): Observable<{ token?: string }> {
    return this.http.post<{ token?: string }>(`${this.baseUrl}/api/auth/pkce`, {
      auth_code: authCode,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
  }

  /**
   * Loads the real operations/business dashboard for a fixed period.
   */
  dashboard(params: Record<string, string> = {}): Observable<AdminDashboardSummary> {
    return this.http.get<AdminDashboardSummary>(`${this.baseUrl}/api/v1/admin/dashboard`, {
      params: this.params(params),
    });
  }

  /**
   * Lists audit rows for the system log workspace.
   */
  listAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists member/admin accounts after an admin session exists.
   */
  listAccounts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAccountRow>> {
    return this.http.get<AdminListPayload<AdminAccountRow>>(`${this.baseUrl}/api/v1/admin/accounts`, {
      params: this.params(params),
    });
  }

  /**
   * Creates a member or admin account through the admin API.
   */
  createAccount(body: Record<string, unknown>): Observable<AdminAccountRow & { temporary_password?: string }> {
    return this.http.post<AdminAccountRow & { temporary_password?: string }>(
      `${this.baseUrl}/api/v1/admin/accounts`,
      body,
    );
  }

  /**
   * Lists role-upgrade requests.
   */
  listRoleRequests(params: Record<string, string> = {}): Observable<AdminListPayload<AdminRoleRequestRow>> {
    return this.http.get<AdminListPayload<AdminRoleRequestRow>>(`${this.baseUrl}/api/v1/admin/account-role-requests`, {
      params: this.params(params),
    });
  }

  /**
   * Lists account-module audit rows.
   */
  listAccountAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/account-audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Locks an account with a reason and optimistic version.
   */
  lockAccount(userId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(userId)}/lock`, body);
  }

  /**
   * Unlocks an account with a reason and optimistic version.
   */
  unlockAccount(userId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(userId)}/unlock`, body);
  }

  /**
   * Changes a member/admin role with optimistic locking.
   */
  changeAccountRole(userId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(userId)}/role`, body);
  }

  /**
   * Approves or rejects a role-upgrade request.
   */
  reviewRoleRequest(requestId: string, decision: 'approve' | 'reject', body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(
      `${this.baseUrl}/api/v1/admin/account-role-requests/${encodeURIComponent(requestId)}/${decision}`,
      body,
    );
  }

  /**
   * Lists reviews for the admin moderation queue.
   */
  listReviews(params: Record<string, string> = {}): Observable<AdminListPayload<AdminReviewRow>> {
    return this.http.get<AdminListPayload<AdminReviewRow>>(`${this.baseUrl}/api/v1/admin/reviews`, {
      params: this.params(params),
    });
  }

  /**
   * Loads one review for the detail drawer.
   */
  getReview(reviewId: string): Observable<AdminReviewRow> {
    return this.http.get<AdminReviewRow>(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}`);
  }

  /**
   * Approves a pending review.
   */
  approveReview(reviewId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/approve`, body);
  }

  /**
   * Hides a review from the storefront.
   */
  hideReview(reviewId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/hide`, body);
  }

  /**
   * Replies to a review.
   */
  replyReview(reviewId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/reply`, body);
  }

  /**
   * Escalates a review into a CSKH ticket.
   */
  escalateReview(reviewId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/escalate`, body);
  }

  /**
   * Requests AI reply suggestions for one review.
   */
  suggestReviewReply(reviewId: string): Observable<{ replies?: string[]; source?: string }> {
    return this.http.post<{ replies?: string[]; source?: string }>(
      `${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/suggest-reply`,
      {},
    );
  }

  /**
   * Lists review-module audit rows.
   */
  listReviewAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/reviews/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists price-editable products for pricing readers.
   */
  listPricingProducts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminProductRow>> {
    return this.http.get<AdminListPayload<AdminProductRow>>(`${this.baseUrl}/api/v1/admin/pricing/products`, {
      params: this.params(params),
    });
  }

  /**
   * Lists price history, newest first.
   */
  listPriceHistory(params: Record<string, string> = {}): Observable<AdminListPayload<AdminPriceHistoryRow>> {
    return this.http.get<AdminListPayload<AdminPriceHistoryRow>>(`${this.baseUrl}/api/v1/admin/pricing/history`, {
      params: this.params(params),
    });
  }

  /**
   * Changes catalog prices with a reason and optimistic version.
   */
  changePrice(productId: string, body: AdminPriceChangeInput): Observable<AdminProductRow> {
    return this.http.post<AdminProductRow>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/change-price`,
      body,
    );
  }

  /**
   * Lists pricing/promotion audit rows.
   */
  listPricingAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/pricing/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists catalog products with the server filters the workspace exposes
   * (`q`, `categoryId`, `status`, `lowStock`, `isCombo`, `isFeatured`, `minPrice`, `maxPrice`, `order`).
   */
  listProducts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminProductRow>> {
    return this.http.get<AdminListPayload<AdminProductRow>>(`${this.baseUrl}/api/v1/admin/products`, {
      params: this.params(params),
    });
  }

  /**
   * Lists categories for the category filter and product forms.
   */
  listCategories(): Observable<AdminListPayload<AdminCategoryRow>> {
    return this.http.get<AdminListPayload<AdminCategoryRow>>(`${this.baseUrl}/api/v1/admin/products/categories`);
  }

  /**
   * Loads one product with its full projection, including nested variants.
   */
  getProduct(productId: string): Observable<AdminProductRow> {
    return this.http.get<AdminProductRow>(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}`);
  }

  /**
   * Creates a product with its variant matrix; `expectedVersion` must be 0.
   */
  createProduct(body: AdminProductCreateInput): Observable<AdminProductRow> {
    return this.http.post<AdminProductRow>(`${this.baseUrl}/api/v1/admin/products`, body);
  }

  /**
   * Patches catalog details only. Price and status travel through their own audited endpoints.
   */
  updateProduct(productId: string, body: AdminProductUpdateInput): Observable<AdminProductRow> {
    return this.http.patch<AdminProductRow>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}`,
      body,
    );
  }

  /**
   * Lists the variants of one product.
   */
  listVariants(productId: string): Observable<AdminListPayload<AdminProductVariant>> {
    return this.http.get<AdminListPayload<AdminProductVariant>>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/variants`,
    );
  }

  /**
   * Adds a color/size variant with its opening stock.
   */
  createVariant(productId: string, body: AdminProductVariantInput): Observable<AdminProductVariant> {
    return this.http.post<AdminProductVariant>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/variants`,
      body,
    );
  }

  /**
   * Adjusts one variant and returns the low-stock alert raised by the same write, if any.
   */
  updateStock(productId: string, body: AdminStockAdjustInput): Observable<AdminStockUpdateResult> {
    return this.http.post<AdminStockUpdateResult>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/update-stock`,
      body,
    );
  }

  /**
   * Applies one reason across several variant adjustments of the same product.
   */
  bulkUpdateStock(productId: string, body: AdminBulkStockInput): Observable<AdminBulkStockResult> {
    return this.http.post<AdminBulkStockResult>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/bulk-stock`,
      body,
    );
  }

  /**
   * Moves a product along the catalog state machine with an audited reason.
   */
  changeProductStatus(productId: string, body: AdminStatusChangeInput): Observable<AdminProductRow> {
    return this.http.post<AdminProductRow>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/change-status`,
      body,
    );
  }

  /**
   * Lists every variant at or below its own low-stock threshold.
   */
  listLowStock(): Observable<AdminListPayload<AdminLowStockRow>> {
    return this.http.get<AdminListPayload<AdminLowStockRow>>(`${this.baseUrl}/api/v1/admin/products/low-stock`);
  }

  /**
   * Lists product-domain audit rows (`from`, `to`, `product`, `actionType`, `user`, `targetId`).
   */
  listProductAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/products/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Checks one SKU against the whole catalog; `excludeProductId` ignores the product being edited.
   */
  checkProductSku(sku: string, excludeProductId = ''): Observable<AdminSkuCheck> {
    return this.http.get<AdminSkuCheck>(`${this.baseUrl}/api/v1/admin/products/sku-check`, {
      params: this.params({ sku, excludeProductId }),
    });
  }

  /**
   * Validates a CSV file without writing; only an error-free answer unlocks the commit.
   */
  previewCsv(csv: string): Observable<AdminCsvPreview> {
    return this.http.post<AdminCsvPreview>(`${this.baseUrl}/api/v1/admin/products/import-csv`, { csv });
  }

  /**
   * Commits the exact CSV text that was previewed.
   */
  commitCsv(csv: string): Observable<AdminCsvCommitResult> {
    return this.http.post<AdminCsvCommitResult>(`${this.baseUrl}/api/v1/admin/products/import-csv/commit`, { csv });
  }

  /**
   * Measures studio quality of an uploaded or saved product image.
   */
  analyzeProductImage(body: { imageBase64?: string; imageUrl?: string; mimeType?: string; productName?: string }): Observable<AdminImageQualityAnalysis> {
    return this.http.post<AdminImageQualityAnalysis>(`${this.baseUrl}/api/v1/admin/products/ai-image-analyze`, body);
  }

  /**
   * Runs the studio enhancement pipeline (background, lighting, sharpness, upscale) on one image.
   */
  enhanceProductImage(body: {
    imageBase64?: string;
    imageUrl?: string;
    mimeType?: string;
    options: { background: string; lighting: boolean; sharpness: boolean; upscale: boolean };
  }): Observable<AdminImageEnhanceResult> {
    return this.http.post<AdminImageEnhanceResult>(`${this.baseUrl}/api/v1/admin/products/ai-image-enhance`, body);
  }

  /**
   * Stages the operator's explicit image choice as a server-side approval; the later product save publishes it.
   */
  approveStudioImage(body: {
    imageUrl: string;
    productId: string | null;
    expectedVersion: number;
    selection: 'original' | 'enhanced';
    reviewConfirmed: true;
  }): Observable<AdminImageApproval> {
    return this.http.post<AdminImageApproval>(`${this.baseUrl}/api/v1/admin/products/ai-image-approve`, body);
  }

  /**
   * Generates fashion SEO copy and PDP attributes for a product draft.
   */
  optimizeProductSeo(body: Record<string, unknown>): Observable<AdminProductFashionSeoResult> {
    return this.http.post<AdminProductFashionSeoResult>(`${this.baseUrl}/api/v1/admin/products/ai-seo-optimize`, body);
  }

  /**
   * Lists the components of a combo product.
   */
  listComboItems(productId: string): Observable<AdminListPayload<AdminComboItemRow>> {
    return this.http.get<AdminListPayload<AdminComboItemRow>>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/combo-items`,
    );
  }

  /**
   * Adds a component product to a combo.
   */
  addComboItem(
    productId: string,
    body: { componentProductId: string; componentVariantId?: string | null; quantity: number },
  ): Observable<AdminComboItemRow> {
    return this.http.post<AdminComboItemRow>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/combo-items`,
      body,
    );
  }

  /**
   * Changes the quantity of one combo component.
   */
  updateComboItem(productId: string, itemId: string, body: { quantity: number }): Observable<AdminComboItemRow> {
    return this.http.patch<AdminComboItemRow>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/combo-items/${encodeURIComponent(itemId)}`,
      body,
    );
  }

  /**
   * Removes one combo component.
   */
  removeComboItem(productId: string, itemId: string): Observable<unknown> {
    return this.http.delete(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/combo-items/${encodeURIComponent(itemId)}`,
    );
  }

  /**
   * Lists return requests; `paymentKind` is resolved server-side into COD vs online channels.
   */
  listReturns(params: Record<string, string> = {}, paymentKind: AdminPaymentFilter | '' = ''): Observable<AdminListPayload<AdminReturnRow>> {
    return this.http.get<AdminListPayload<AdminReturnRow>>(`${this.baseUrl}/api/v1/admin/returns`, {
      params: this.params(paymentKind ? { ...params, payment_kind: paymentKind } : params),
    });
  }

  /**
   * Reads one return including the refundable amount computed from its lines.
   */
  getReturn(returnId: string): Observable<AdminReturnRow> {
    return this.http.get<AdminReturnRow>(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}`);
  }

  /** Applies one versioned decision or operational fact to one quantity part. */
  actOnReturnItem(returnId: string, returnItemId: string, body: AdminReturnItemActionInput): Observable<AdminReturnRow> {
    return this.http.post<AdminReturnRow>(
      `${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/items/${encodeURIComponent(returnItemId)}/action`,
      body,
    );
  }

  /**
   * Records one outreach attempt on a return waiting for contact.
   */
  recordReturnContact(returnId: string, body: AdminReturnContactInput): Observable<AdminReturnRow> {
    return this.http.post<AdminReturnRow>(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/contact`, body);
  }


  /**
   * Uploads one private evidence file (pickup/QA/refund proof) and returns its signed URL + storage ref.
   */
  uploadReturnEvidence(returnId: string, file: File, kind: string, note = ''): Observable<AdminReturnEvidence> {
    const params = new HttpParams().set('kind', kind).set('note', note);
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<AdminReturnEvidence>(
      `${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/evidence`,
      form,
      { params },
    );
  }

  /**
   * Runs (or retries) the gateway refund for a Stripe return.
   */
  triggerStripeRefund(
    returnId: string,
    body: { expectedVersion: number; returnItemId: string },
  ): Observable<{ success: boolean; refund: { status: 'refunded' | 'requested' | 'failed' | 'skipped'; message?: string } | null }> {
    return this.http.post<{
      success: boolean;
      refund: { status: 'refunded' | 'requested' | 'failed' | 'skipped'; message?: string } | null;
    }>(
      `${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/trigger-stripe-refund`,
      body,
    );
  }

  /**
   * Reconciles a refund paid outside the gateway; the amount must equal the current refundable amount.
   */
  recordManualRefund(returnId: string, body: AdminManualRefundInput): Observable<AdminReturnRow> {
    return this.http.post<AdminReturnRow>(
      `${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/manual-refund`,
      body,
    );
  }

  /**
   * Asks the customer for missing payout details without changing the return state.
   */
  requestRefundInfo(returnId: string, body: AdminRefundInfoRequestInput): Observable<{ return_id: string; refund_receiver: AdminRefundReceiver }> {
    return this.http.post<{ return_id: string; refund_receiver: AdminRefundReceiver }>(
      `${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/request-refund-info`,
      body,
    );
  }

  /**
   * Lists support tickets with the original filter query.
   */
  listTickets(params: Record<string, string> = {}): Observable<AdminListPayload<AdminTicketRow>> {
    return this.http.get<AdminListPayload<AdminTicketRow>>(`${this.baseUrl}/api/v1/admin/support-tickets`, {
      params: this.params(params),
    });
  }

  /**
   * Reads one support ticket.
   */
  getTicket(ticketId: string): Observable<AdminTicketRow> {
    return this.http.get<AdminTicketRow>(`${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}`);
  }

  /**
   * Answers a ticket and moves it to `processing`.
   */
  respondTicket(ticketId: string, body: AdminTicketReplyInput): Observable<AdminTicketRow> {
    return this.http.post<AdminTicketRow>(
      `${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/respond`,
      body,
    );
  }

  /**
   * Marks a ticket resolved; the customer can still come back before it is closed.
   */
  resolveTicket(ticketId: string, body: AdminTicketNoteInput): Observable<AdminTicketRow> {
    return this.http.post<AdminTicketRow>(
      `${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/resolve`,
      body,
    );
  }

  /**
   * Closes a ticket with the reason recorded on the audit row.
   */
  closeTicket(ticketId: string, body: AdminTicketCloseInput): Observable<AdminTicketRow> {
    return this.http.post<AdminTicketRow>(
      `${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/close`,
      body,
    );
  }

  /**
   * Lists live-chat cases for the CSKH queue.
   */
  listChatSessions(params: Record<string, string> = {}): Observable<AdminListPayload<AdminChatSessionRow>> {
    return this.http.get<AdminListPayload<AdminChatSessionRow>>(`${this.baseUrl}/api/v1/admin/chat-sessions`, {
      params: this.params(params),
    });
  }

  /**
   * Reads the public transcript of one case.
   */
  getChatMessages(sessionId: string): Observable<AdminChatMessagesPayload> {
    return this.http.get<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/messages`,
    );
  }

  /**
   * Claims a case exclusively for the signed-in staff member.
   */
  assignChatSession(sessionId: string): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/assign`,
      { status: 'assigned' },
    );
  }

  /**
   * Sends an agent reply on a case.
   */
  sendChatReply(sessionId: string, message: string): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/reply`,
      { message },
    );
  }

  /**
   * Persists a confirmed review decision; an HTTP failure never means the correction was saved.
   */
  reviewChatSession(sessionId: string, body: AdminChatReviewInput): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/review`,
      body,
    );
  }

  /**
   * Reads a quarantined original after the operator accepts an audited privileged access.
   */
  getChatOriginal(sessionId: string, messageId: string): Observable<AdminChatOriginal> {
    return this.http.get<AdminChatOriginal>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/moderated/${encodeURIComponent(messageId)}`,
    );
  }

  /**
   * Lists the service audit trail used by the CSKH log tab.
   */
  listServiceLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/service-audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists orders with server filters and paging.
   */
  listOrders(params: Record<string, string> = {}): Observable<AdminListPayload<AdminOrderRow>> {
    return this.http.get<AdminListPayload<AdminOrderRow>>(`${this.baseUrl}/api/v1/admin/orders`, {
      params: this.params(params),
    });
  }

  /**
   * Loads one order drawer payload with fresh allowed actions.
   */
  getOrder(orderId: string): Observable<AdminOrderRow> {
    return this.http.get<AdminOrderRow>(`${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Loads order counts by status and the attention count.
   */
  orderSummary(): Observable<AdminOrderSummary> {
    return this.http.get<AdminOrderSummary>(`${this.baseUrl}/api/v1/admin/orders/summary`);
  }

  /**
   * Performs a state-machine action on an order.
   */
  performOrderAction(orderId: string, action: string, body: Record<string, unknown>): Observable<AdminOrderActionResult> {
    return this.http.post<AdminOrderActionResult>(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/actions/${encodeURIComponent(action)}`,
      body,
    );
  }

  /**
   * Resolves a payment manually with both optimistic versions.
   */
  resolvePayment(orderId: string, paymentId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(paymentId)}/resolve`,
      body,
    );
  }

  /**
   * Simulates a carrier outcome for super-admin verification.
   */
  simulateCarrier(orderId: string, body: { outcome: string; note?: string }): Observable<AdminOrderRow> {
    return this.http.post<AdminOrderRow>(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/simulate-carrier`,
      body,
    );
  }

  /**
   * Lists order audit rows.
   */
  orderAuditLogs(orderId: string, params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/audit-logs`,
      { params: this.params(params) },
    );
  }

  /**
   * Uploads one image/video as evidence for a specific order stage.
   */
  uploadOrderEvidence(orderId: string, file: File, stage: string, note: string): Observable<AdminOrderEvidence> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<AdminOrderEvidence>(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/evidence`,
      form,
      { params: this.params({ stage, note }) },
    );
  }

  /**
   * Lists campaign rows with the API-computed summary.
   */
  listPromotions(params: Record<string, string> = {}): Observable<AdminPromotionListPayload> {
    return this.http.get<AdminPromotionListPayload>(`${this.baseUrl}/api/v1/admin/promotions`, {
      params: this.params(params),
    });
  }

  /**
   * Creates a promotion campaign.
   */
  createPromotion(body: Record<string, unknown>): Observable<AdminPromotionRow> {
    return this.http.post<AdminPromotionRow>(`${this.baseUrl}/api/v1/admin/promotions`, body);
  }

  /**
   * Updates a promotion campaign.
   */
  updatePromotion(promoId: string, body: Record<string, unknown>): Observable<AdminPromotionRow> {
    return this.http.patch<AdminPromotionRow>(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}`, body);
  }

  /**
   * Activates a scheduled/paused campaign.
   */
  activatePromotion(promoId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}/activate`, body);
  }

  /**
   * Pauses a running campaign.
   */
  pausePromotion(promoId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}/pause`, body);
  }

  /**
   * Lists voucher rows.
   */
  listVouchers(params: Record<string, string> = {}): Observable<AdminListPayload<AdminVoucherRow>> {
    return this.http.get<AdminListPayload<AdminVoucherRow>>(`${this.baseUrl}/api/v1/admin/vouchers`, {
      params: this.params(params),
    });
  }

  /**
   * Creates a voucher.
   */
  createVoucher(body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/vouchers`, body);
  }

  /**
   * Updates a voucher.
   */
  updateVoucher(voucherId: string, body: Record<string, unknown>): Observable<AdminVoucherRow> {
    return this.http.patch<AdminVoucherRow>(`${this.baseUrl}/api/v1/admin/vouchers/${encodeURIComponent(voucherId)}`, body);
  }

  /**
   * Toggles a voucher active/inactive.
   */
  toggleVoucher(voucherId: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/vouchers/${encodeURIComponent(voucherId)}/toggle`, {});
  }

  /**
   * Loads pricing/promotion statistics for the selected range.
   */
  pricingStatistics(params: Record<string, string> = {}): Observable<AdminPricingStatistics> {
    return this.http.get<AdminPricingStatistics>(`${this.baseUrl}/api/v1/admin/pricing/statistics`, {
      params: this.params(params),
    });
  }

  /**
   * Lists CMS blog rows, drafts included. The API gates this on the `content` module.
   */
  listBlogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminBlogRow>> {
    return this.http.get<AdminListPayload<AdminBlogRow>>(`${this.baseUrl}/api/v1/admin/content/blogs`, {
      params: this.params(params),
    });
  }

  /**
   * Creates a blog post as a draft or publishes it in the same audited write.
   */
  createBlog(body: AdminBlogInput): Observable<AdminBlogRow> {
    return this.http.post<AdminBlogRow>(`${this.baseUrl}/api/v1/admin/content/blogs`, body);
  }

  /**
   * Saves one blog post against the version the editor loaded; a stale copy is rejected.
   */
  updateBlog(blogId: string, body: AdminBlogInput): Observable<AdminBlogRow> {
    return this.http.patch<AdminBlogRow>(`${this.baseUrl}/api/v1/admin/content/blogs/${encodeURIComponent(blogId)}`, body);
  }

  /**
   * Reads content categories. Public endpoint, used here only to offer valid targets.
   */
  listContentCategories(type = 'blog'): Observable<{ rows?: AdminContentCategory[] }> {
    return this.http.get<{ rows?: AdminContentCategory[] }>(`${this.baseUrl}/api/content/categories`, {
      params: this.params({ type }),
    });
  }

  /**
   * Counter strip for the members workspace. Counts the wallet tables, never `users.loyalty_points`.
   */
  memberOverview(): Observable<AdminMemberOverview> {
    return this.http.get<AdminMemberOverview>(`${this.baseUrl}/api/v1/admin/members/overview`);
  }

  /**
   * Lists members with their wallet state. `wallet` accepts all | has | none | negative | locked.
   */
  listMembers(params: Record<string, string> = {}): Observable<AdminListPayload<AdminMemberRow>> {
    return this.http.get<AdminListPayload<AdminMemberRow>>(`${this.baseUrl}/api/v1/admin/members`, {
      params: this.params(params),
    });
  }

  /**
   * Loads one member profile with the ledger trail, referrals and vouchers in a single read.
   */
  memberDetail(userId: string): Observable<AdminMemberDetail> {
    return this.http.get<AdminMemberDetail>(`${this.baseUrl}/api/v1/admin/members/${encodeURIComponent(userId)}`);
  }

  /**
   * Locks or unlocks accrual with an operator reason; the RPC writes the audit row.
   */
  setMemberAccrualLock(userId: string, body: { locked: boolean; reason: string }): Observable<AdminMemberLockResult> {
    return this.http.post<AdminMemberLockResult>(
      `${this.baseUrl}/api/v1/admin/members/${encodeURIComponent(userId)}/accrual-lock`,
      body,
    );
  }

  private params(values: Record<string, string>): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(values)) {
      if (value) {
        params = params.set(key, value);
      }
    }
    return params;
  }
}
