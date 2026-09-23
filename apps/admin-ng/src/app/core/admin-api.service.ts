import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdminAuthMe } from './admin-session.service';
import { AdminListPayload } from './admin-http';

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

export interface AdminOrderPayment {
  payment_id?: string;
  payment_status?: string;
  payment_method?: string;
  has_discrepancy?: boolean;
  version?: number;
}

export interface AdminOrderRow {
  order_id: string;
  order_date?: string;
  status?: string;
  shipping_name?: string;
  shipping_phone?: string;
  shipping_address?: string;
  tracking_code?: string | null;
  total_amount?: number;
  version?: number;
  payments?: AdminOrderPayment[];
  items?: Array<{ product_name?: string; quantity?: number; unit_price?: number }>;
  history?: Array<{ new_status?: string; changed_at?: string; note?: string; trigger_type?: string }>;
}

export interface AdminReturnRow {
  return_id: string;
  order_id?: string;
  status?: string;
  request_type?: string;
  return_type?: string;
  description?: string;
  created_at?: string;
  customer_name?: string;
  version?: number;
  /**
   * Tổng tiền đúng những món khách gửi trả, do API tính từ `return_item`.
   * Không phải tổng đơn: một đơn nhiều món mà khách chỉ trả một món thì hoàn cả đơn
   * là thất thoát.
   */
  refundable_amount?: number;
}

export interface AdminTicketRow {
  ticket_id: string;
  status?: string;
  subject?: string;
  priority?: string;
  created_at?: string;
  version?: number;
}

export interface AdminChatSessionRow {
  session_id: string;
  is_active?: boolean;
  updated_at?: string;
  preview?: string;
  title?: string;
  last_message_preview?: string;
  last_message_at?: string;
  created_at?: string;
  guest_id?: string;
  handoff_status?: string;
  metadata?: { guest_email?: string };
}

export interface AdminChatMessageRow {
  message_id?: string;
  sender?: string;
  text?: string;
  created_at?: string;
  product_ids?: string[];
  metadata?: { product_ids?: string[] };
}

export interface AdminChatMessagesPayload {
  messages?: AdminChatMessageRow[];
  products?: Array<{ product_id: string; name?: string; image_url?: string; sale_price?: number; base_price?: number }>;
  session?: AdminChatSessionRow;
  message?: AdminChatMessageRow;
}

export interface AdminProductVariant {
  variant_id: string;
  color?: string;
  color_hex?: string | null;
  size?: string;
  stock_quantity?: number;
  reserved_quantity?: number;
  low_stock_threshold?: number;
  version?: number;
  updated_at?: string | null;
}

export interface AdminProductRow {
  product_id: string;
  sku?: string;
  name: string;
  slug?: string;
  description?: string | null;
  category_id?: string;
  category_name?: string | null;
  category?: { category_id?: string; name?: string };
  brand?: string | null;
  base_price?: number;
  sale_price?: number | null;
  status?: string;
  images?: string[];
  collection?: string | null;
  updated_at?: string | null;
  is_combo?: boolean;
  is_featured?: boolean;
  version?: number;
  variants?: AdminProductVariant[];
}

export interface AdminCategoryRow {
  category_id: string;
  name: string;
  slug?: string;
  parent_id?: string | null;
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
  starts_at?: string;
  ends_at?: string;
  budget?: number;
  budget_limit?: number;
  total_discount_issued?: number;
  version?: number;
  paused_at?: string | null;
  /**
   * Vòng đời do API tính (`promotion-lifecycle.ts`), không tính lại ở trình duyệt —
   * badge, nút thao tác và trang ưu đãi bên khách phải cùng một câu trả lời.
   */
  lifecycle_status?: 'scheduled' | 'running' | 'paused' | 'ended' | 'budget_exhausted';
  lifecycle_label?: string;
  can_activate?: boolean;
  can_pause?: boolean;
  /** `budget_limit = 0` là "không đặt trần", không phải ngân sách bằng 0. */
  budget_unlimited?: boolean;
  /** Ngân sách chỉ tăng khi có mã được dùng; chiến dịch chưa phát mã thì không theo dõi được. */
  budget_tracked?: boolean;
  voucher_count?: number;
  active_voucher_count?: number;
  warnings?: Array<{ code: string; level: 'info' | 'warning' | 'danger'; message: string }>;
  /** Nội dung marketing hiển thị cho khách trên trang Ưu đãi — xem migration 026. */
  description?: string | null;
  banner_image_url?: string | null;
  highlight_label?: string | null;
  display_order?: number | null;
  is_featured?: boolean | null;
}

/**
 * Chỉ số đầu trang Khuyến mãi, do API tính trên toàn bộ chiến dịch.
 *
 * Trước đây trang tự cộng trên `rows` của trang hiện tại, nên bốn con số đổi theo mỗi
 * lần bấm sang trang. Đây là số thật.
 */
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

/** Danh sách chiến dịch kèm chỉ số tổng hợp. */
export interface AdminPromotionListPayload extends AdminListPayload<AdminPromotionRow> {
  summary?: AdminPromotionSummary;
}

/** Số liệu tổng hợp trả về từ `/api/v1/admin/pricing/statistics`. */
export interface AdminPricingStatistics {
  promotions: {
    total: number;
    active: number;
    paused: number;
    totalBudget: number;
    totalIssued: number;
    budgetRemaining: number;
    budgetUsagePercent: number;
  };
  vouchers: {
    total: number;
    active: number;
    expired: number;
    totalUsed: number;
    totalLimit: number;
    usagePercent: number;
  };
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
  usage_limit_total?: number;
  end_date?: string;
  expires_at?: string;
  is_active?: boolean;
  promo_id?: string;
  applicable_user_group?: string;
  version?: number;
}

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
  target_id?: string;
  target_label?: string;
  old_value?: unknown;
  new_value?: unknown;
  change_summary?: string;
  ip_address?: string;
  result?: string;
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
  /** Sản phẩm của dòng lịch sử, do API nhúng kèm — xem `PRICE_HISTORY_SELECT`. */
  product?: { product_id?: string; name?: string; sku?: string } | null;
}

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
    categoryContributions?: Array<{
      category_id?: string;
      name: string;
      revenue: number;
      pct: number;
    }>;
    bestSellers?: Array<{
      product_id?: string;
      name: string;
      sku?: string;
      sold?: number;
      revenue: number;
      lowStock?: boolean;
    }>;
    revenueTrend?: Array<{ date: string; dateStr: string; revenue: number; orderCount: number }>;
    insights?: Record<string, unknown>;
  };
  recentLogs?: AdminAuditRow[];
  periodDays?: number;
  range?: string;
  from?: string;
  to?: string;
  filters?: { categoryId?: string | null; productId?: string | null };
  meta?: {
    generatedAt?: string;
    definitions?: Record<string, string>;
    source?: string;
    samples?: { reviews?: number; csat?: number; deliveredOrders?: number };
    /**
     * `complete` bằng false nghĩa là kỳ này có nhiều dữ liệu hơn trần đọc của API, nên
     * các chỉ số tiếng nói khách hàng chỉ tính trên một phần.
     */
    reliable?: { reviews?: boolean; csat?: boolean; complete?: boolean };
  };
  voice?: AdminVoiceInsights;
  board?: AdminInsightBoardModel;
}

export type AdminInsightRange = 'day' | 'week' | 'month';
export type AdminInsightSeverity = 'critical' | 'high' | 'watch' | 'ok';

export interface AdminInsightQuestion {
  id: string;
  question: string;
  answer: string;
  severity: AdminInsightSeverity;
  evidence: Array<{ label: string; value: string }>;
}

export interface AdminInsightAction {
  id: string;
  title: string;
  reason: string;
  route: string;
  routeLabel: string;
  severity: AdminInsightSeverity;
  clientSteer: string;
}

export interface AdminInsightBoardModel {
  scope: string;
  range: string;
  periodLabel: string;
  headline: string;
  questions: AdminInsightQuestion[];
  actions: AdminInsightAction[];
}

export interface AdminVoiceInsights {
  range: string;
  periodLabel: string;
  coverage: {
    deliveredOrders: number;
    reviewedOrders: number;
    silentOrders: number;
    coveragePct: number;
  };
  productReaction: {
    reviewCount: number;
    avgRating: number | null;
    loved: Array<{ product_id: string; name: string; sku: string; reviews: number; avgRating: number; lowStarCount: number }>;
    complained: Array<{ product_id: string; name: string; sku: string; reviews: number; avgRating: number; lowStarCount: number }>;
  };
  serviceQuality: {
    tickets: number;
    closedTickets: number;
    csatCount: number;
    csatAvg: number | null;
    ticketsWithoutCsat: number;
    returns: number;
    returnRatePct: number;
  };
  orderFriction: {
    orderCount: number;
    completedOrders: number;
    cancelledOrders: number;
    failedDelivery: number;
    cancelReasons: Array<{ reason: string; count: number }>;
  };
}

export interface AdminInsightsPayload {
  scope: string;
  range: string;
  from?: string;
  to?: string;
  voice: AdminVoiceInsights;
  board: AdminInsightBoardModel;
}

/**
 * Admin HTTP model. Pages bind signals; they do not construct URLs in templates.
 * JSON contracts are owned by `apps/api`. Trace: `git log --show-notes --follow -- this file`.
 */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  /**
   * Verifies the original `/api/auth/me` admin context.
   */
  me(): Observable<AdminAuthMe> {
    return this.http.get<AdminAuthMe>(`${this.baseUrl}/api/auth/me`);
  }

  /**
   * Signs in through the API proxy of the vanilla Supabase password grant.
   */
  signIn(email: string, password: string): Observable<{ token?: string }> {
    return this.http.post<{ token?: string }>(`${this.baseUrl}/api/auth/signin`, { email, password });
  }

  /**
   * Records AUTH-08 sign-out on the API, then the ViewModel clears the client session.
   */
  signOut(): Observable<{ success?: boolean }> {
    return this.http.post<{ success?: boolean }>(`${this.baseUrl}/api/auth/signout`, {});
  }

  /**
   * Sends the original Supabase password-reset email through the API.
   */
  requestPasswordReset(email: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/auth/recover`, { email });
  }

  /**
   * Changes the signed-in admin password after verifying the current one.
   */
  changePassword(currentPassword: string, newPassword: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.baseUrl}/api/auth/change-password`, {
      currentPassword,
      newPassword,
    });
  }

  /**
   * Exchanges a Google PKCE auth code the same way vanilla `auth-callback.html` does.
   */
  exchangePkce(authCode: string, codeVerifier: string, redirectUri: string): Observable<{ token?: string }> {
    return this.http.post<{ token?: string }>(`${this.baseUrl}/api/auth/pkce`, {
      auth_code: authCode,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
  }

  /**
   * Loads the admin dashboard OLAP/legacy summary.
   */
  dashboard(params: Record<string, string> = {}): Observable<AdminDashboardSummary> {
    return this.http.get<AdminDashboardSummary>(`${this.baseUrl}/api/v1/admin/dashboard`, { params: this.params(params) });
  }

  /**
   * Loads the question-driven insight board for one admin module.
   */
  insights(params: Record<string, string> = {}): Observable<AdminInsightsPayload> {
    return this.http.get<AdminInsightsPayload>(`${this.baseUrl}/api/v1/admin/insights`, { params: this.params(params) });
  }

  /**
   * Lists member accounts after an admin session exists.
   */
  listAccounts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAccountRow>> {
    return this.http.get<AdminListPayload<AdminAccountRow>>(`${this.baseUrl}/api/v1/admin/accounts`, { params: this.params(params) });
  }

  /**
   * Creates a new member or admin account through the admin API.
   */
  createAccount(body: Record<string, unknown>): Observable<AdminAccountRow & { temporary_password?: string }> {
    return this.http.post<AdminAccountRow & { temporary_password?: string }>(`${this.baseUrl}/api/v1/admin/accounts`, body);
  }

  /**
   * Lists pending role-upgrade requests.
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
   * Locks a member account through the original admin API.
   */
  lockAccount(userId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(userId)}/lock`, body);
  }

  /**
   * Unlocks a member account through the original admin API.
   */
  unlockAccount(userId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(userId)}/unlock`, body);
  }

  /**
   * Changes member/admin role through the original admin API.
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
    return this.http.get<AdminListPayload<AdminReviewRow>>(`${this.baseUrl}/api/v1/admin/reviews`, { params: this.params(params) });
  }

  /**
   * Loads one review drawer payload.
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
   * Hides a review through the original moderation API.
   */
  hideReview(reviewId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/reviews/${encodeURIComponent(reviewId)}/hide`, body);
  }

  /**
   * Replies to a review through the original moderation API.
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
   * Lists review-module audit rows.
   */
  listReviewAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/reviews/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists admin catalog products (not the public lite feed).
   */
  listProducts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminProductRow>> {
    return this.http.get<AdminListPayload<AdminProductRow>>(`${this.baseUrl}/api/v1/admin/products`, { params: this.params(params) });
  }

  /**
   * Lists catalog categories for product create/edit.
   */
  listCategories(): Observable<AdminListPayload<AdminCategoryRow>> {
    return this.http.get<AdminListPayload<AdminCategoryRow>>(`${this.baseUrl}/api/v1/admin/products/categories`);
  }

  /**
   * Loads one catalog product including nested variants.
   */
  getProduct(productId: string): Observable<AdminProductRow> {
    return this.http.get<AdminProductRow>(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}`);
  }

  /**
   * Creates a catalog product through the original admin API.
   */
  createProduct(body: Record<string, unknown>): Observable<AdminProductRow> {
    return this.http.post<AdminProductRow>(`${this.baseUrl}/api/v1/admin/products`, body);
  }

  /**
   * Updates catalog fields (not price or status) through PATCH.
   */
  updateProduct(productId: string, body: Record<string, unknown>): Observable<AdminProductRow> {
    return this.http.patch<AdminProductRow>(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}`, body);
  }

  /**
   * Lists variants for one product.
   */
  listVariants(productId: string): Observable<AdminListPayload<AdminProductVariant>> {
    return this.http.get<AdminListPayload<AdminProductVariant>>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/variants`,
    );
  }

  /**
   * Creates a color/size variant with initial stock.
   */
  createVariant(productId: string, body: Record<string, unknown>): Observable<AdminProductVariant> {
    return this.http.post<AdminProductVariant>(
      `${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/variants`,
      body,
    );
  }

  /**
   * Adjusts variant stock (delta) or low-stock threshold.
   */
  updateStock(productId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/update-stock`, body);
  }

  /**
   * Resolves a failed or discrepancy payment on an order.
   */
  resolvePayment(orderId: string, paymentId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(paymentId)}/resolve`,
      body,
    );
  }

  /**
   * Lists low-stock products for the original catalog KPI.
   */
  listLowStock(): Observable<AdminListPayload<AdminProductRow>> {
    return this.http.get<AdminListPayload<AdminProductRow>>(`${this.baseUrl}/api/v1/admin/products/low-stock`);
  }

  /**
   * Previews a product CSV import.
   */
  /**
   * Stores one catalog photo and returns its public URL.
   * The product form keeps that URL on the image list.
   */
  uploadProductImage(file: File): Observable<{ url?: string }> {
    const body = new FormData();
    body.append("file", file);
    return this.http.post<{ url?: string }>(`${this.baseUrl}/api/v1/admin/products/image`, body);
  }

  previewCsv(csv: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/products/import-csv`, { csv });
  }

  /**
   * Commits a validated product CSV import.
   */
  commitCsv(csv: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/products/import-csv/commit`, { csv });
  }

  /**
   * Lists admin orders with the original filter query.
   */
  listOrders(params: Record<string, string> = {}): Observable<AdminListPayload<AdminOrderRow>> {
    return this.http.get<AdminListPayload<AdminOrderRow>>(`${this.baseUrl}/api/v1/admin/orders`, { params: this.params(params) });
  }

  /**
   * Loads one order drawer payload.
   */
  getOrder(orderId: string): Observable<AdminOrderRow> {
    return this.http.get<AdminOrderRow>(`${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Lists audit rows for one order.
   */
  orderAuditLogs(orderId: string, params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(
      `${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/audit-logs`,
      { params: this.params(params) },
    );
  }

  /**
   * Changes order status using the original transition API.
   */
  changeOrderStatus(orderId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/change-status`, body);
  }

  /**
   * Cancels an order through the original admin API.
   */
  cancelOrder(orderId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/orders/${encodeURIComponent(orderId)}/cancel`, body);
  }

  /**
   * Lists return requests.
   */
  listReturns(params: Record<string, string> = {}): Observable<AdminListPayload<AdminReturnRow>> {
    return this.http.get<AdminListPayload<AdminReturnRow>>(`${this.baseUrl}/api/v1/admin/returns`, { params: this.params(params) });
  }

  /**
   * Lists CSKH support tickets.
   */
  listTickets(params: Record<string, string> = {}): Observable<AdminListPayload<AdminTicketRow>> {
    return this.http.get<AdminListPayload<AdminTicketRow>>(`${this.baseUrl}/api/v1/admin/support-tickets`, { params: this.params(params) });
  }

  /**
   * Lists live-chat sessions for the CSKH workspace.
   */
  listChatSessions(params: Record<string, string> = {}): Observable<AdminListPayload<AdminChatSessionRow>> {
    return this.http.get<AdminListPayload<AdminChatSessionRow>>(`${this.baseUrl}/api/v1/admin/chat-sessions`, { params: this.params(params) });
  }

  /**
   * Lists service audit logs used by the CSKH log tab.
   */
  listServiceLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/service-audit-logs`, { params: this.params(params) });
  }

  /**
   * Loads messages for one CSKH chat session.
   */
  getChatMessages(sessionId: string, params: Record<string, string> = {}): Observable<AdminChatMessagesPayload> {
    return this.http.get<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/messages`,
      { params: this.params(params) },
    );
  }

  /**
   * Assigns or closes a CSKH chat session.
   */
  assignChatSession(sessionId: string, status: string): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/assign`,
      { status },
    );
  }

  /**
   * Sends an agent reply on a CSKH chat session.
   */
  sendChatReply(sessionId: string, message: string): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(
      `${this.baseUrl}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/reply`,
      { message },
    );
  }

  /**
   * Reads one return, including the refundable amount computed from its items.
   */
  getReturn(returnId: string): Observable<AdminReturnRow> {
    return this.http.get<AdminReturnRow>(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}`);
  }

  /**
   * Approves a return as a refund.
   */
  approveRefund(returnId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/approve-refund`, body);
  }

  /**
   * Approves a return as an exchange.
   */
  approveExchange(returnId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/approve-exchange`, body);
  }

  /**
   * Rejects a return request.
   */
  rejectReturn(returnId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/reject`, body);
  }

  /**
   * Updates a return workflow status.
   */
  updateReturnStatus(returnId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/returns/${encodeURIComponent(returnId)}/update-status`, body);
  }

  /**
   * Replies to a support ticket.
   */
  respondTicket(ticketId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/respond`, body);
  }

  /**
   * Marks a support ticket as resolved, which is the state between "đang xử lý" and
   * "đã đóng" — the customer can still come back before it is closed for good.
   */
  resolveTicket(ticketId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/resolve`, body);
  }

  /**
   * Closes a support ticket.
   */
  closeTicket(ticketId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/support-tickets/${encodeURIComponent(ticketId)}/close`, body);
  }

  /**
   * Lists price-change history.
   */
  listPriceHistory(params: Record<string, string> = {}): Observable<AdminListPayload<AdminPriceHistoryRow>> {
    return this.http.get<AdminListPayload<AdminPriceHistoryRow>>(`${this.baseUrl}/api/v1/admin/pricing/history`, {
      params: this.params(params),
    });
  }

  /**
   * Updates catalog prices through the original pricing API.
   */
  changePrice(productId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/change-price`, body);
  }

  /**
   * Changes a product sales status.
   */
  changeProductStatus(productId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/products/${encodeURIComponent(productId)}/change-status`, body);
  }

  /**
   * Lists product-module audit rows.
   */
  listProductAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/products/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Tạo một chiến dịch khuyến mãi. Chiến dịch mới luôn ở trạng thái tạm dừng; phải bấm
   * "Chạy" riêng, để không có chiến dịch nào lên sóng chỉ vì lỡ tay bấm Lưu.
   */
  createPromotion(body: Record<string, unknown>): Observable<AdminPromotionRow> {
    return this.http.post<AdminPromotionRow>(`${this.baseUrl}/api/v1/admin/promotions`, body);
  }

  /**
   * Sửa một chiến dịch. Trường bỏ trống nghĩa là giữ nguyên, chuỗi rỗng là xoá.
   */
  updatePromotion(promoId: string, body: Record<string, unknown>): Observable<AdminPromotionRow> {
    return this.http.patch<AdminPromotionRow>(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}`, body);
  }

  /**
   * Tải ảnh banner chiến dịch lên kho và nhận lại đường dẫn công khai.
   *
   * Không đặt content-type: trình duyệt phải tự sinh boundary của multipart, đặt tay
   * vào sẽ làm máy chủ không tách được tệp.
   */
  uploadPromotionBanner(file: File): Observable<{ url: string }> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ url: string }>(`${this.baseUrl}/api/v1/admin/promotions/banner`, form);
  }

  /**
   * Activates a promotion campaign.
   */
  activatePromotion(promoId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}/activate`, body);
  }

  /**
   * Pauses a promotion campaign.
   */
  pausePromotion(promoId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/promotions/${encodeURIComponent(promoId)}/pause`, body);
  }

  /**
   * Toggles a voucher through the original promotions API.
   */
  /**
   * Issues one voucher for guests, members, or both.
   * Checkout ranks that set and keeps a single code.
   */
  createVoucher(body: Record<string, unknown>): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/vouchers`, body);
  }

  toggleVoucher(voucherId: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/vouchers/${encodeURIComponent(voucherId)}/toggle`, {});
  }

  /**
   * Lists promotions for the original campaign table.
   */
  listPromotions(params: Record<string, string> = {}): Observable<AdminPromotionListPayload> {
    return this.http.get<AdminPromotionListPayload>(`${this.baseUrl}/api/v1/admin/promotions`, { params: this.params(params) });
  }

  /**
   * Lists vouchers for the original voucher table.
   */
  listVouchers(params: Record<string, string> = {}): Observable<AdminListPayload<AdminVoucherRow>> {
    return this.http.get<AdminListPayload<AdminVoucherRow>>(`${this.baseUrl}/api/v1/admin/vouchers`, { params: this.params(params) });
  }

  /**
   * Số liệu tổng hợp chiến dịch và mã giảm giá.
   *
   * Endpoint này đã tồn tại từ trước nhưng chưa màn hình nào gọi tới, nên tab Thống kê
   * hiển thị một khối rỗng viết cứng.
   */
  pricingStatistics(): Observable<AdminPricingStatistics> {
    return this.http.get<AdminPricingStatistics>(`${this.baseUrl}/api/v1/admin/pricing/statistics`);
  }

  /**
   * Nhật ký phân hệ giá & khuyến mãi, đã được API bổ sung tên người thao tác và nội
   * dung thay đổi thay vì chỉ có UUID.
   */
  listPricingAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/pricing/audit-logs`, {
      params: this.params(params),
    });
  }

  /**
   * Lists system audit logs.
   */
  listAuditLogs(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAuditRow>> {
    return this.http.get<AdminListPayload<AdminAuditRow>>(`${this.baseUrl}/api/v1/admin/audit-logs`, { params: this.params(params) });
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
