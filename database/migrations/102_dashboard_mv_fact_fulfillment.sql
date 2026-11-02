-- Migration 077 — Tạo Materialized View Fact Table (mv_fact_order_fulfillment)
-- Thực thi trên Supabase Dashboard SQL Editor
-- Mục tiêu: Tạo Fact Table vật lý tự động tính toán số giờ xử lý kho vận và gán bucket SLA. Fact Table có thể REFRESH CONCURRENTLY không gây lock bảng nguồn.

DROP MATERIALIZED VIEW IF EXISTS public.mv_fact_order_fulfillment CASCADE;

CREATE MATERIALIZED VIEW public.mv_fact_order_fulfillment AS
WITH order_dispatch AS (
  -- Xác định mốc kết thúc hoàn tất đóng gói xuất kho
  SELECT 
    order_id,
    min(changed_at) AS dispatched_at
  FROM public.order_status_history
  WHERE new_status = 'shipping'
  GROUP BY order_id
),
prepared_fact AS (
  SELECT
    o.order_id,
    to_char(o.created_at, 'YYYYMMDD')::int AS date_key,
    r.region_key,
    s.status_key,
    -- Giờ xử lý: từ lúc đặt đơn đến khi xuất kho
    ROUND(
      EXTRACT(EPOCH FROM (COALESCE(od.dispatched_at, o.updated_at) - o.created_at)) / 3600.0, 
      1
    ) AS processing_hours,
    o.total_amount,
    (o.status::text NOT IN ('cancelled', 'delivery_failed')) AS is_valid_order,
    NOW() AS refreshed_at
  FROM public.orders o
  LEFT JOIN order_dispatch od ON o.order_id = od.order_id
  JOIN public.dim_region r ON r.region_name = public.extract_region(o.shipping_address)
  JOIN public.dim_order_status s ON s.status_name = o.status::text
  -- Design choice: Chính xác hóa phạm vi đo SLA (chỉ đo đơn đã qua khâu shipping hoặc đã có audit history để tránh đơn pending chưa xử lý bị phồng bucket new)
  WHERE o.created_at >= CURRENT_DATE - INTERVAL '90 days'
    AND o.created_at IS NOT NULL
    AND (
      o.status::text IN ('shipping', 'delivered')
      OR EXISTS (SELECT 1 FROM public.order_status_history h WHERE h.order_id = o.order_id)
    )
)
SELECT
  order_id,
  date_key,
  region_key,
  status_key,
  CASE 
    WHEN processing_hours < 0 THEN 0 
    ELSE processing_hours 
  END AS processing_hours,
  CASE
    WHEN processing_hours <= 12 THEN 'new'
    WHEN processing_hours <= 24 THEN 'normal'
    WHEN processing_hours <= 48 THEN 'warning'
    ELSE 'violated'
  END AS sla_bucket,
  total_amount,
  is_valid_order,
  refreshed_at
FROM prepared_fact;

-- Bắt buộc tạo UNIQUE INDEX để thực thi REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_fact_order_fulfillment_order_id 
ON public.mv_fact_order_fulfillment (order_id);

CREATE INDEX IF NOT EXISTS idx_mv_fact_fulfillment_date_region 
ON public.mv_fact_order_fulfillment (date_key, region_key);

-- Cấp quyền SELECT cho API / PostgREST
GRANT SELECT ON public.mv_fact_order_fulfillment TO anon, authenticated;
