-- KAN-106: legacy delivered COD orders predate the payment ledger. The refund RPC and
-- payment_refund FK need one captured payment row; create it idempotently without changing
-- any order amount or status.
begin;

insert into public.payment(
  order_id, payment_method, payment_provider, amount, payment_status, paid_at,
  gateway_response_code, created_at, updated_at
)
select o.order_id, 'COD'::public.payment_method, 'cod', o.total_amount, 'paid'::public.payment_status,
  coalesce(o.delivered_at, o.updated_at, o.created_at), 'LEGACY_COD_BACKFILL',
  coalesce(o.created_at, now()), now()
from public.orders o
where upper(o.payment_method::text)='COD'
  and o.status::text='delivered'
  and o.total_amount>0
  and not exists (select 1 from public.payment p where p.order_id=o.order_id);

notify pgrst,'reload schema';
commit;
