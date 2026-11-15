import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  InventoryAlertsResponse,
  ModuleHealthResponse,
  SlaApiResponse
} from '../models/sla-metric.model';
import { MacroKpiResponse } from '../models/macro-kpi.model';

/**
 * Service Model phụ trách truy xuất số liệu phân tích Dashboard & SLA từ API Backend.
 * Tuân thủ nguyên tắc Clean Architecture: Tách biệt hoàn toàn tầng gọi HTTP khỏi View/ViewModel.
 */
@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /**
   * Truy xuất 5 Macro KPIs cấp cao nhất (Chuẩn CDO) với Real Data từ PostgreSQL & Cache 10 phút.
   * Endpoint đích: GET /api/v1/analytics/macro-kpis
   */
  getMacroKpis(params: Record<string, string> = {}): Observable<MacroKpiResponse> {
    return this.http.get<MacroKpiResponse>(`${this.apiUrl}/api/v1/analytics/macro-kpis`, { params });
  }

  /**
   * Truy xuất số liệu SLA vận hành 30 ngày theo vùng miền từ Materialized View Fact Table (Widget Q2).
   * Endpoint đích: GET /api/v1/admin/dashboard/sla-metrics
   */
  getSlaMetrics(): Observable<SlaApiResponse> {
    return this.http.get<SlaApiResponse>(`${this.apiUrl}/api/v1/admin/dashboard/sla-metrics`);
  }

  /**
   * Truy xuất danh sách SKU tồn kho thấp / cạn kho cần cảnh báo (Widget Q5).
   * Endpoint đích: GET /api/v1/admin/dashboard/inventory-alerts
   */
  getInventoryAlerts(): Observable<InventoryAlertsResponse> {
    return this.http.get<InventoryAlertsResponse>(`${this.apiUrl}/api/v1/admin/dashboard/inventory-alerts`);
  }

  /**
   * Truy xuất chỉ số sức khỏe 6 phân hệ cốt lõi (Widget Q1).
   * Endpoint đích: GET /api/v1/admin/dashboard/module-health
   */
  getModuleHealth(): Observable<ModuleHealthResponse> {
    return this.http.get<ModuleHealthResponse>(`${this.apiUrl}/api/v1/admin/dashboard/module-health`);
  }
}
