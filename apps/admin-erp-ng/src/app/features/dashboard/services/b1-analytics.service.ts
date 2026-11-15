import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface B1AnalyticsParams {
  tab?: 'time_combo' | 'price_bar' | 'payment_stacked';
  grain?: 'day' | 'week' | 'month' | 'quarter';
  measure?: 'revenue' | 'profit';
  dimension?: 'category' | 'customer' | 'channel';
  range?: '7d' | '30d' | '90d' | 'ytd';
  from?: string;
  to?: string;
}

export interface B1TimeSpineRow {
  bucket_date: string;
  revenue: number;
  cogs: number;
  profit: number;
  metric_val: number;
  order_count: number;
  prev_metric_val: number;
  margin_pct: number;
}

export interface B1PriceTierSegment {
  dimension_name: string;
  metric_val: number;
  revenue: number;
  profit: number;
  share_pct: number;
}

export interface B1PriceTierRow {
  tier_code: string;
  tier_label: string;
  tier_metric_val: number;
  tier_revenue: number;
  tier_profit: number;
  tier_orders: number;
  margin_pct: number;
  segments: B1PriceTierSegment[];
}

export interface B1PaymentChannelRow {
  code: string;
  name: string;
  revenue: number;
  total_orders: number;
  gateway_fee_rate: number;
  return_rate_pct: number;
  net_cash_flow: number;
  share_pct: number;
}

export interface B1AnalyticsResponse {
  status: 'success' | 'error';
  generated_at: string;
  query_context: {
    tab: 'time_combo' | 'price_bar' | 'payment_stacked';
    grain: 'day' | 'week' | 'month' | 'quarter';
    measure: 'revenue' | 'profit';
    dimension: 'category' | 'customer' | 'channel';
    date_range: {
      from: string;
      to: string;
      comparison_from: string;
      comparison_to: string;
    };
  };
  chart_payload: {
    rows?: B1TimeSpineRow[];
    tiers?: B1PriceTierRow[];
    channels?: B1PaymentChannelRow[];
    count?: number;
  };
  cache: {
    hit: boolean;
    ttl_remaining_seconds: number;
    latency_ms: number;
  };
}

/**
 * Service Angular chuyên trách truy xuất dữ liệu phân tích Widget B1
 * Đảm bảo 100% dữ liệu thực từ PostgreSQL qua API Node.js, không dùng mock data
 */
@Injectable({ providedIn: 'root' })
export class B1AnalyticsService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /**
   * Truy vấn dữ liệu Widget B1 động theo Tab, Grain, Measure, Dimension & Range
   * Endpoint: GET /api/v1/analytics/dashboard/b1
   */
  getB1Data(params: B1AnalyticsParams): Observable<B1AnalyticsResponse> {
    let httpParams = new HttpParams();

    if (params.tab) httpParams = httpParams.set('tab', params.tab);
    if (params.grain) httpParams = httpParams.set('grain', params.grain);
    if (params.measure) httpParams = httpParams.set('measure', params.measure);
    if (params.dimension) httpParams = httpParams.set('dimension', params.dimension);
    if (params.range) httpParams = httpParams.set('range', params.range);
    if (params.from) httpParams = httpParams.set('from', params.from);
    if (params.to) httpParams = httpParams.set('to', params.to);

    return this.http.get<B1AnalyticsResponse>(`${this.apiUrl}/api/v1/analytics/dashboard/b1`, {
      params: httpParams
    });
  }
}
