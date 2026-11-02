/**
 * Hợp đồng dữ liệu phân tích SLA theo vùng miền từ Materialized View Fact Table
 * (mv_fact_order_fulfillment qua vw_dashboard_sla_summary).
 */
export interface SlaMetric {
  /** Tên phân vùng địa lý (Miền Nam, Miền Bắc, Miền Trung, Khác) */
  region_name: string;
  /** Tổng số đơn hàng hợp lệ đo SLA trong chu kỳ 30 ngày */
  total_orders: number;
  /** Số đơn xử lý nhanh trong vòng 12h (nhãn 'new') */
  new_orders: number;
  /** Số đơn xử lý tiêu chuẩn trong vòng 12-24h (nhãn 'normal') */
  normal_orders: number;
  /** Số đơn cảnh báo trễ hạn trong vòng 24-48h (nhãn 'warning') */
  warning_orders: number;
  /** Số đơn vi phạm cam kết SLA vượt quá 48h (nhãn 'violated') */
  violated_orders: number;
  /** Thời gian xử lý bình quân (giờ) từ lúc đặt đơn đến khi xuất kho */
  avg_processing_hours: number;
  /** Tỷ lệ tuân thủ SLA (%) = (new + normal + warning) / total * 100 */
  sla_compliance_pct: number;
  /** Mốc thời gian Materialized View được làm mới lần gần nhất */
  mv_refreshed_at: string;
}

/**
 * Cấu trúc phản hồi chuẩn từ Backend API endpoint GET /api/v1/admin/dashboard/sla-metrics
 */
export interface SlaApiResponse {
  /** Cờ trạng thái xử lý của backend */
  success: boolean;
  /** Danh sách số liệu SLA tổng hợp theo từng vùng */
  data: SlaMetric[];
  /** Mốc thời gian API thực thi và trả về dữ liệu */
  fetched_at: string;
}

/**
 * Bản ghi cảnh báo tồn kho SKU cho Widget Q5
 */
export interface InventoryAlertItem {
  variant_id: string;
  product_name: string;
  sku: string;
  color: string;
  size: string;
  stock_quantity: number;
  low_stock_threshold: number;
  category_name: string;
}

export interface InventoryAlertsResponse {
  success: boolean;
  data: InventoryAlertItem[];
  fetched_at: string;
}

/**
 * Dữ liệu sức khỏe 6 phân hệ cốt lõi cho Widget Q1
 */
export interface ModuleHealthData {
  orders_pending_24h: number;
  variants_out_of_stock: number;
  tickets_open_24h: number;
  promotions_near_budget: number;
  reviews_urgent: number;
  admin_requests_pending: number;
  total_issues: number;
  fetched_at: string;
}

export interface ModuleHealthResponse {
  success: boolean;
  data: ModuleHealthData;
  fetched_at: string;
}
