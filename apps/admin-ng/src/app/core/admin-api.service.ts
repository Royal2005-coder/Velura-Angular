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
  created_at?: string;
  customer_name?: string;
  version?: number;
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

export interface AdminProductRow {
  product_id: string;
  sku?: string;
  name: string;
  category_name?: string | null;
  category?: { name?: string };
  base_price?: number;
  sale_price?: number | null;
  status?: string;
  images?: string[];
  collection?: string | null;
  updated_at?: string | null;
  is_combo?: boolean;
  version?: number;
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
  version?: number;
}

export interface AdminAuditRow {
  audit_id?: string;
  timestamp?: string;
  actor_name?: string;
  actor_id?: string;
  actor_role?: string;
  module?: string;
  action?: string;
  target_id?: string;
  old_value?: unknown;
  new_value?: unknown;
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
    categoryContributions?: Array<{ name: string; revenue: number; pct: number }>;
    bestSellers?: Array<{ name: string; sku?: string; sold?: number; revenue: number; lowStock?: boolean }>;
    insights?: Record<string, unknown>;
  };
  recentLogs?: AdminAuditRow[];
  periodDays?: number;
  range?: string;
  meta?: { generatedAt?: string; definitions?: Record<string, string> };
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
   * Sends the original Supabase password-reset email through the API.
   */
  requestPasswordReset(email: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/auth/recover`, { email });
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
   * Loads the original admin dashboard RPC summary.
   */
  dashboard(params: Record<string, string> = {}): Observable<AdminDashboardSummary> {
    return this.http.get<AdminDashboardSummary>(`${this.baseUrl}/api/admin/dashboard`, { params: this.params(params) });
  }

  /**
   * Lists member accounts after an admin session exists.
   */
  listAccounts(params: Record<string, string> = {}): Observable<AdminListPayload<AdminAccountRow>> {
    return this.http.get<AdminListPayload<AdminAccountRow>>(`${this.baseUrl}/api/v1/admin/accounts`, { params: this.params(params) });
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
   * Lists low-stock products for the original catalog KPI.
   */
  listLowStock(): Observable<AdminListPayload<AdminProductRow>> {
    return this.http.get<AdminListPayload<AdminProductRow>>(`${this.baseUrl}/api/v1/admin/products/low-stock`);
  }

  /**
   * Previews a product CSV import.
   */
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
  toggleVoucher(voucherId: string): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/api/v1/admin/vouchers/${encodeURIComponent(voucherId)}/toggle`, {});
  }

  /**
   * Lists promotions for the original campaign table.
   */
  listPromotions(params: Record<string, string> = {}): Observable<AdminListPayload<AdminPromotionRow>> {
    return this.http.get<AdminListPayload<AdminPromotionRow>>(`${this.baseUrl}/api/v1/admin/promotions`, { params: this.params(params) });
  }

  /**
   * Lists vouchers for the original voucher table.
   */
  listVouchers(params: Record<string, string> = {}): Observable<AdminListPayload<AdminVoucherRow>> {
    return this.http.get<AdminListPayload<AdminVoucherRow>>(`${this.baseUrl}/api/v1/admin/vouchers`, { params: this.params(params) });
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
