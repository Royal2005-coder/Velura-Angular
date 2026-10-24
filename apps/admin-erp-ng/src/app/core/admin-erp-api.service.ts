import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
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
  items?: Array<{ product_name?: string; quantity?: number; unit_price?: number }>;
  history?: Array<{ old_status?: string | null; new_status?: string; changed_at?: string; note?: string; trigger_type?: string }>;
  events?: AdminOrderEvent[];
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
    revenue: number;
    orderCount: number;
    averageOrderValue: number;
    completionRate: number;
    promotionRevenue: number;
    promotionRevenueShare: number;
    pendingReviews: number;
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
  meta?: { generatedAt?: string; source?: string };
}

/**
 * Typed HTTP model for the ERP admin. Endpoints are added per workspace; pages never
 * construct URLs or call `HttpClient` directly.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  /**
   * Verifies the current admin context and returns pages, modules and capabilities.
   */
  me(): Observable<AdminAuthMe> {
    return this.http.get<AdminAuthMe>(`${this.baseUrl}/api/auth/me`);
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
