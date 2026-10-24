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
  change_summary?: string;
  result?: string;
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
