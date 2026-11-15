/**
 * Hợp đồng dữ liệu 5 Macro KPIs cấp cao nhất (Chuẩn CDO)
 * Endpoint: GET /api/v1/analytics/macro-kpis
 */

export interface MacroKpiItem {
  title: string;
  value: number;
  formatted: string;
  trend_value: number;
  trend_direction: 'up' | 'down' | 'flat';
  is_inverted_metric: boolean;
  unit: string;
  trend_label: string;
}

export interface MacroKpisData {
  period: {
    from: string;
    to: string;
    range: string;
    cached_at: string;
    cache_ttl_seconds: number;
  };
  kpis: {
    net_revenue: MacroKpiItem;
    gross_margin: MacroKpiItem;
    aov: MacroKpiItem;
    repeat_rate: MacroKpiItem;
    return_rate: MacroKpiItem;
  };
}

export interface MacroKpiResponse {
  status: 'success' | 'error';
  data: MacroKpisData;
  error?: string;
}
