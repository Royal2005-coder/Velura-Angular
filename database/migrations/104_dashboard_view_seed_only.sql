-- Migration 079 — Điều chỉnh View SLA chỉ tổng hợp Seed Data (Demo Mode)
-- Thực thi trên Supabase Dashboard SQL Editor
-- Mục tiêu: Lọc dữ liệu thuần khiết từ 200 đơn hàng mẫu (Seed Data) của đồ án, loại bỏ các đơn thử nghiệm cũ để số liệu khớp chính xác 100% với tài liệu và kịch bản bảo vệ.
-- Ghi chú sản xuất: Trong môi trường Production thật sẽ bỏ điều kiện: AND o.shipping_name LIKE 'Khách Seed%'

CREATE OR REPLACE VIEW public.vw_dashboard_sla_summary AS
SELECT
  r.region_name,
  count(*) AS total_orders,
  count(*) FILTER (WHERE f.sla_bucket = 'new') AS new_orders,
  count(*) FILTER (WHERE f.sla_bucket = 'normal') AS normal_orders,
  count(*) FILTER (WHERE f.sla_bucket = 'warning') AS warning_orders,
  count(*) FILTER (WHERE f.sla_bucket = 'violated') AS violated_orders,
  ROUND(AVG(f.processing_hours), 1) AS avg_processing_hours,
  ROUND(
    (count(*) FILTER (WHERE f.sla_bucket IN ('new', 'normal', 'warning'))::numeric / 
     NULLIF(count(*), 0)) * 100.0, 
    1
  ) AS sla_compliance_pct,
  MAX(f.refreshed_at) AS mv_refreshed_at
FROM public.mv_fact_order_fulfillment f
JOIN public.dim_region r ON f.region_key = r.region_key
JOIN public.orders o ON f.order_id = o.order_id
WHERE f.is_valid_order = TRUE
  AND f.date_key >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYYMMDD')::int
  AND o.shipping_name LIKE 'Khách Seed%'
GROUP BY r.region_name;

-- Cấp quyền SELECT cho API và PostgREST
GRANT SELECT ON public.vw_dashboard_sla_summary TO anon, authenticated;
