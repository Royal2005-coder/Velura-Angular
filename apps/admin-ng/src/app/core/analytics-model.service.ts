import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { AdminAuditRow, AdminManagementGroup, AdminInsightRange } from './admin-api.service';

/** Production dashboard DTO: unavailable measurements and empty denominators are nullable. */
export interface AnalyticsDashboard {
  range: AdminInsightRange; from: string; toExclusive: string; previousFrom: string; previousToExclusive: string;
  operations: Record<string, number | null>;
  business: {
    revenue: number | null; orderCount: number | null; averageOrderValue: number | null; completionRate: number | null;
    customers: number | null; promotionRevenue: number | null; promotionRevenueShare: number | null; pendingReviews: number | null;
    comparisons: Record<string, number | null>;
    revenueTrend: Array<{ date: string; dateStr: string; revenue: number | null; orderCount: number | null }>;
    bestSellers: Array<{ product_id?: string; sku?: string; name: string; sold: number | null; revenue: number | null; lowStock: boolean }>;
    categoryContributions: Array<{ category_id?: string; name: string; revenue: number | null; pct: number | null }>;
  };
  recentLogs?: AdminAuditRow[];
  management: { groups: Array<AdminManagementGroup & { ruleVersion?: string; source?: string; updated_at?: string; kpis?: Record<string, number | null> }>; lastSyncedAt?: string; evidence?: Record<string, unknown> };
  meta: { source: string; updated_at: string | null; generatedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable';
    validated: boolean; reconciled: boolean; pendingEvents: number | null; operationsSource: string; sourceWarning?: string | null;
    openDefinitions: string[]; lastSync?: { status: string; error_code?: string } | null };
}
/** Scoped HTTP Model reuses the app's auth interceptors without adding HTTP to the page. */
@Injectable({ providedIn: 'root' })
export class AnalyticsModel {
  private readonly http = inject(HttpClient);
  /** Read-only snapshot; this method never initiates synchronization. */
  dashboard(params: Record<string, string>): Observable<AnalyticsDashboard> {
    return this.http.get<AnalyticsDashboard>(`${environment.apiUrl}/api/v1/admin/dashboard`, { params });
  }
  /** Authorized, audited sync with persisted server-side ten-second anti-repeat. */
  refresh(): Observable<{ status: 'succeeded'; success: true; snapshotAt: string }> {
    return this.http.post<{ status: 'succeeded'; success: true; snapshotAt: string }>(`${environment.apiUrl}/api/v1/admin/dashboard/refresh`, {});
  }
  /** Narrative is optional; underlying validated KPI cards are always kept visible. */
  recommend(params: Record<string, string>): Observable<{ source: string; availability: string; lines: string[]; narrative: string[] }> {
    return this.http.post<{ source: string; availability: string; lines: string[]; narrative: string[] }>(`${environment.apiUrl}/api/v1/admin/insights/recommend`, {}, { params });
  }
}
