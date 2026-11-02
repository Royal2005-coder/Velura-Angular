-- Migration 078 — Tạo View SLA tổng hợp theo miền (vw_dashboard_sla_summary)
-- Thực thi trên Supabase Dashboard SQL Editor
-- Mục tiêu: Cung cấp dữ liệu đã tiền tổng hợp theo vùng miền cho Widget Q2 (Đơn hàng & SLA), đọc trực tiếp từ Materialized View Fact.

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
WHERE f.is_valid_order = TRUE
  AND f.date_key >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYYMMDD')::int
GROUP BY r.region_name;

-- Cấp quyền SELECT cho API / PostgREST
GRANT SELECT ON public.vw_dashboard_sla_summary TO anon, authenticated;
