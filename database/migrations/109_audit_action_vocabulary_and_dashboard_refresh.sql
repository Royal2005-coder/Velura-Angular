-- Migration 109: làm cho nhật ký kiểm toán ghi được thật, và tạo lại RPC mà cron dashboard gọi.
--
-- Vì sao cần: `audit_action` khai báo từ schema gốc chỉ có 7 nhãn CRUD, còn API và trang nhật ký
-- dùng bộ action theo nghiệp vụ (đăng nhập, thanh toán, hoàn tiền, lưu outfit, xem nội dung gốc…).
-- Mọi dòng ngoài CRUD vì thế thất bại với 22P02 `invalid input value for enum audit_action` và
-- bị bỏ — log API hiện `[audit] auth write failed` ở mỗi lần đăng nhập production.
--
-- `ALTER TYPE ... ADD VALUE` chạy trong transaction của runner (PG12+ cho phép) nhưng giá trị mới
-- không được dùng trong cùng transaction, nên file này không INSERT/UPDATE gì cả.

ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'hide';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'unhide';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'reply';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'escalate';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'role';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'login';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'logout';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'signin';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'signout';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'signin_failed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'signin_blocked';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'view_moderated_original';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'refund';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'exchange';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'confirm_cod';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'customer_cancel';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payment_succeeded';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'refund_failed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'save_favorite_outfit';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'stripe_refund_requested';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'stripe_refund_succeeded';

-- `apps/api/src/features/dashboard/dashboard.cron.ts` gọi rpc này từ khi có widget Q2, nhưng chưa
-- migration nào tạo nó → mỗi lần cron chạy là 404 PGRST202 và số liệu MV dừng tuổi.
-- REFRESH CONCURRENTLY dùng được vì 102 đã tạo unique index trên mv_fact_order_fulfillment,
-- nên dashboard vẫn đọc được trong lúc refresh.
CREATE OR REPLACE FUNCTION public.velura_refresh_dashboard_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fact_order_fulfillment;
END;
$$;

-- Hàm này ghi lại toàn bộ fact table fulfilment: chỉ role dịch vụ (cron) được gọi, không phải anon.
REVOKE ALL ON FUNCTION public.velura_refresh_dashboard_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.velura_refresh_dashboard_mv() TO service_role;
