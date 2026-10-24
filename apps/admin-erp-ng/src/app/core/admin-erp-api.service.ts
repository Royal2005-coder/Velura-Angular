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
  target_id?: string;
  target_label?: string;
  old_value?: unknown;
  new_value?: unknown;
  change_summary?: string;
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

export interface AdminProductRow {
  product_id: string;
  name: string;
  sku?: string;
  base_price?: number;
  sale_price?: number | null;
  version?: number;
  status?: string;
  updated_at?: string;
  category?: { name?: string } | null;
  category_name?: string;
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
  changePrice(productId: string, body: Record<string, unknown>): Observable<AdminProductRow> {
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
