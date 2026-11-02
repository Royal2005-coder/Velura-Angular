-- Migration 080: RPC functions hỗ trợ Widget Q5 (Cảnh báo tồn kho) và Widget Q1 (Sức khỏe 6 phân hệ)
-- Phục vụ kết nối dữ liệu thật End-to-End cho Dashboard Quản trị Velura

-- -----------------------------------------------------------------------------
-- 1. RPC Function cho Widget Q5: Lấy danh sách Top SKU chạm ngưỡng cảnh báo / cạn kho
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_inventory_alerts()
RETURNS TABLE (
  variant_id UUID,
  product_name TEXT,
  sku TEXT,
  color TEXT,
  size TEXT,
  stock_quantity INT,
  low_stock_threshold INT,
  category_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    v.variant_id,
    p.name::TEXT AS product_name,
    p.sku::TEXT,
    v.color::TEXT,
    v.size::TEXT,
    v.stock_quantity::INT,
    v.low_stock_threshold::INT,
    COALESCE(c.name::TEXT, 'Chưa phân loại') AS category_name
  FROM public.variant v
  JOIN public.product p ON v.product_id = p.product_id
  LEFT JOIN public.category c ON p.category_id = c.category_id
  WHERE v.stock_quantity <= v.low_stock_threshold
  ORDER BY v.stock_quantity ASC, v.low_stock_threshold DESC
  LIMIT 20;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_inventory_alerts() TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. RPC Function cho Widget Q1: Lấy 6 chỉ số sức khỏe mở của 6 phân hệ cốt lõi
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_module_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_orders_pending_24h INT;
  v_variants_out_of_stock INT;
  v_tickets_open_24h INT;
  v_promotions_near_budget INT;
  v_reviews_urgent INT;
  v_admin_requests_pending INT;
  v_total INT;
BEGIN
  -- 1. Đơn hàng: Đơn pending > 24h (hoặc tổng đơn pending nếu mới seed)
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_orders_pending_24h
    FROM public.orders
   WHERE status::TEXT = 'pending'
     AND created_at < (NOW() - INTERVAL '24 hours');

  IF v_orders_pending_24h = 0 THEN
    SELECT COALESCE(COUNT(*)::INT, 0)
      INTO v_orders_pending_24h
      FROM public.orders
     WHERE status::TEXT = 'pending';
  END IF;

  -- 2. SP & Kho: Biến thể cạn tồn kho (stock = 0) hoặc chạm ngưỡng an toàn
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_variants_out_of_stock
    FROM public.variant
   WHERE stock_quantity <= low_stock_threshold;

  -- 3. CSKH: Ticket hỗ trợ chưa giải quyết (hoặc mở > 24h)
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_tickets_open_24h
    FROM public.support_ticket
   WHERE status::TEXT NOT IN ('resolved', 'closed');

  -- 4. Giá & KM: Voucher đang hoạt động đã dùng trên 80% hạn mức (hoặc active)
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_promotions_near_budget
    FROM public.voucher
   WHERE is_active = TRUE
     AND (used_count >= COALESCE(usage_limit_total, 100) * 0.8 OR COALESCE(usage_limit_total, 0) = 0);

  IF v_promotions_near_budget = 0 THEN
    SELECT COALESCE(COUNT(*)::INT, 0)
      INTO v_promotions_near_budget
      FROM public.voucher
     WHERE is_active = TRUE;
  END IF;

  -- 5. Review: Đánh giá tiêu cực (<= 2 sao) hoặc chờ duyệt
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_reviews_urgent
    FROM public.review
   WHERE rating <= 2 OR status::TEXT = 'pending';

  -- 6. Tài khoản: Yêu cầu phân quyền admin đang chờ phê duyệt
  SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_admin_requests_pending
    FROM public.approval_admin_request
   WHERE status::TEXT = 'pending';

  v_total := v_orders_pending_24h + v_variants_out_of_stock + v_tickets_open_24h +
             v_promotions_near_budget + v_reviews_urgent + v_admin_requests_pending;

  RETURN jsonb_build_object(
    'orders_pending_24h', v_orders_pending_24h,
    'variants_out_of_stock', v_variants_out_of_stock,
    'tickets_open_24h', v_tickets_open_24h,
    'promotions_near_budget', v_promotions_near_budget,
    'reviews_urgent', v_reviews_urgent,
    'admin_requests_pending', v_admin_requests_pending,
    'total_issues', v_total,
    'fetched_at', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_module_health() TO anon, authenticated, service_role;
