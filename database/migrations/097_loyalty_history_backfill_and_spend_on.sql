begin;

-- Loyalty only ever credited orders delivered after 087 went live, so every member who bought
-- before that has a real order history and an empty wallet, and the storefront shows
-- "Tính năng dùng điểm khi thanh toán đang tạm khóa" forever.
-- velura_award_order_loyalty already carries the whole validity rule (delivered, paid, not an
-- exchange sub-order, one earn per order), so the backfill only has to walk the candidates.
create or replace function public.velura_backfill_loyalty_history()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare o record; considered integer:=0; credited integer:=0; balance_before bigint; balance_after bigint;
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  select coalesce(sum(balance_milli_points-debt_milli_points),0) into balance_before from public.loyalty_account;
  for o in
    select ord.order_id from public.orders ord
    where ord.status::text='delivered' and ord.user_id is not null
      and ord.delivered_at is not null and ord.delivered_at<=now()
      and coalesce(ord.order_kind::text,'sale')<>'exchange'
      and exists(select 1 from public.payment p where p.order_id=ord.order_id
        and p.payment_status::text in ('paid','refund_pending','refunded'))
      and not exists(select 1 from public.loyalty_ledger l where l.order_id=ord.order_id and l.kind='earn')
    order by ord.created_at, ord.order_id
  loop
    considered:=considered+1;
    begin
      perform public.velura_award_order_loyalty(o.order_id);
      if exists(select 1 from public.loyalty_ledger where order_id=o.order_id and kind='earn') then
        credited:=credited+1;
      end if;
    exception when others then
      -- One malformed historical order must not abort the whole backfill; the award function is
      -- idempotent, so a later run retries exactly the orders still missing an earn row.
      raise notice 'bo qua don %: %', o.order_id, sqlerrm;
    end;
  end loop;
  select coalesce(sum(balance_milli_points-debt_milli_points),0) into balance_after from public.loyalty_account;
  return jsonb_build_object('orders_considered',considered,'orders_credited',credited,
    'balance_before_milli',balance_before,'balance_after_milli',balance_after);
end; $$;
revoke all on function public.velura_backfill_loyalty_history() from public,anon,authenticated;
grant execute on function public.velura_backfill_loyalty_history() to service_role;

select public.velura_backfill_loyalty_history();

-- Point earning was on but spending was never approved, so members could accrue and never use.
-- The owner asked for the reward loop to run for all members; the cap stays inside the range the
-- spending RPC enforces (1-100) and an existing approved value is never widened here.
update public.loyalty_settings
   set spending_enabled=true,
       max_discount_percent=case when max_discount_percent between 1 and 100
                                 then max_discount_percent else 50 end,
       policy_approved_at=coalesce(policy_approved_at, now()),
       updated_at=now()
 where id;

notify pgrst, 'reload schema';
commit;
