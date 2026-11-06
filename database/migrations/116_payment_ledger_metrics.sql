-- KAN-109: số liệu ledger thanh toán cho /metrics, tính một lần trong DB.
--
-- Vì sao không đọc thẳng bảng payment từ API: bản nháp cũ select toàn bộ hàng (provider, status,
-- amount, refunded_amount) MỖI lần scrape với cache 30 giây. Bảng payment lớn theo số đơn, nên
-- "/metrics" sẽ biến thành một lần quét bảng đầy đủ mỗi nửa phút — vừa chậm vừa kéo toàn bộ số tiền
-- của khách vào memory process API chỉ để đếm.
--
-- RPC này trả về tổng hợp theo (provider, status) — số dòng trả về bị chặn bởi số nhà mạng × trạng
-- thái, không phụ thuộc số đơn. Read-only, security definer, không đụng đường ghi nào.
begin;

create or replace function public.velura_payment_ledger_metrics()
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object(
   'payments', coalesce((
     select jsonb_agg(jsonb_build_object(
       'provider', coalesce(p.payment_provider, 'unknown'),
       'status', p.payment_status::text,
       'count', p.count,
       'amount', p.total))
     from (select payment_provider, payment_status, count(*) as count, coalesce(sum(amount), 0) as total
           from public.payment group by 1, 2) p), '[]'::jsonb),
   -- Hoàn tiền lấy từ sổ payment_refund, không suy từ payment.refunded_amount: chỉ sổ này mới phân
   -- biệt succeeded / pending / failed, và pending chính là thứ vòng đối soát mới đóng.
   'refunds', coalesce((
     select jsonb_agg(jsonb_build_object(
       'provider', coalesce(r.payment_provider, 'unknown'),
       'status', r.status,
       'count', r.count,
       'amount', r.total))
     from (select pay.payment_provider, ref.status, count(*) as count, coalesce(sum(ref.amount), 0) as total
           from public.payment_refund ref
           left join public.payment pay on pay.payment_id = ref.payment_id
           group by 1, 2) r), '[]'::jsonb),
   'generated_at', extract(epoch from now())::bigint);
 $$;

revoke all on function public.velura_payment_ledger_metrics() from public, anon, authenticated;
grant execute on function public.velura_payment_ledger_metrics() to service_role;

comment on function public.velura_payment_ledger_metrics() is
 'Tổng hợp ledger thanh toán/hoàn tiền theo provider+status cho /metrics; read-only, số dòng không phụ thuộc số đơn.';

notify pgrst, 'reload schema';
commit;
