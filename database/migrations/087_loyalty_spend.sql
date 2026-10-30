-- KAN-106: 5% point accrual, six-month FIFO lots, 50% checkout cap and cancel/expiry restoration.
-- Spending stays disabled until the owner/UAT flips loyalty_settings.
begin;

create table if not exists public.loyalty_settings (
  id boolean primary key default true check (id),
  spending_enabled boolean not null default false,
  max_discount_percent numeric not null default 50 check (max_discount_percent between 0 and 100),
  point_expiry_months integer not null default 6 check (point_expiry_months between 1 and 60),
  policy_approved_at timestamptz,
  updated_by uuid references public.users(user_id),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
insert into public.loyalty_settings(id) values(true) on conflict (id) do nothing;
alter table public.loyalty_settings enable row level security;
revoke all on public.loyalty_settings from public,anon,authenticated;
grant all on public.loyalty_settings to service_role;

create table if not exists public.loyalty_point_lot (
  lot_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id),
  order_id uuid references public.orders(order_id),
  ledger_id uuid references public.loyalty_ledger(ledger_id),
  earned_milli bigint not null check (earned_milli > 0),
  remaining_milli bigint not null check (remaining_milli >= 0),
  expires_at timestamptz not null,
  source text not null default 'award' check (source in ('award','reconcile','restore')),
  created_at timestamptz not null default now(),
  expired_at timestamptz,
  check (remaining_milli <= earned_milli)
);
create unique index if not exists loyalty_lot_ledger_once on public.loyalty_point_lot(ledger_id) where ledger_id is not null;
create index if not exists loyalty_lot_fifo_idx on public.loyalty_point_lot(user_id, expires_at, lot_id) where remaining_milli > 0;
create table if not exists public.loyalty_lot_use (
  ledger_id uuid not null references public.loyalty_ledger(ledger_id),
  lot_id uuid not null references public.loyalty_point_lot(lot_id),
  amount_milli bigint not null check (amount_milli > 0),
  primary key(ledger_id, lot_id)
);
alter table public.loyalty_point_lot enable row level security;
alter table public.loyalty_lot_use enable row level security;
revoke all on public.loyalty_point_lot,public.loyalty_lot_use from public,anon,authenticated;
grant all on public.loyalty_point_lot,public.loyalty_lot_use to service_role;

-- Production carried a narrower check than the legacy functions now require.
alter table public.loyalty_ledger drop constraint if exists loyalty_ledger_kind_check;
alter table public.loyalty_ledger add constraint loyalty_ledger_kind_check check (kind in (
  'earn','clawback','reversed','expired','expiry','debt_repayment','redeem','redeem_refund',
  'reconcile','refund','adjustment','bonus','reserved','consumed'));

create table if not exists public.loyalty_reconciliation (
  reconciliation_id bigserial primary key,
  user_id uuid not null references public.users(user_id),
  old_balance_milli bigint not null,
  new_balance_milli bigint not null,
  old_debt_milli bigint not null,
  new_debt_milli bigint not null,
  target_earned_milli bigint not null,
  target_clawback_milli bigint not null,
  note text not null,
  created_at timestamptz not null default now()
);
alter table public.loyalty_reconciliation enable row level security;
revoke all on public.loyalty_reconciliation from public,anon,authenticated;
grant all on public.loyalty_reconciliation to service_role;

-- Reconcile every existing account to BA 5% accrual. This is a one-time, audited correction.
create temp table _loyalty_recon on commit drop as
with base as (
  select o.user_id, o.order_id, o.delivered_at,
    greatest(0, coalesce(o.subtotal,0)
      - case when exists(select 1 from public.voucher v where v.voucher_id=o.voucher_id and v.discount_type::text='free_shipping')
          then 0 else coalesce(o.discount_amount,0) end
      - coalesce(o.points_discount,0)) as merchandise
  from public.orders o
  where o.user_id is not null and o.status::text='delivered' and o.delivered_at is not null
    and o.delivered_at<=now() and coalesce(o.order_kind::text,'sale')<>'exchange'
    and exists(select 1 from public.payment p where p.order_id=o.order_id
      and p.payment_status::text in ('paid','refund_pending','refunded'))
), refunded as (
  select b.*,
    coalesce((select sum(p.amount) from public.payment_refund p
      join public.return_exchange r on r.return_id=p.return_id
      left join public.return_item ri on ri.return_item_id=p.return_item_id
      where r.order_id=b.order_id and p.status='succeeded'
        and ((p.return_item_id is null and r.return_type::text='refund') or ri.resolution_type='refund')),0) as refunded_amount
  from base b
)
select user_id, order_id, delivered_at, merchandise,
  floor(merchandise*5/100)::bigint as earned_milli,
  least(floor(merchandise*5/100)::bigint,
    case when merchandise>0 then round(floor(merchandise*5/100)*least(refunded_amount/merchandise,1))::bigint else 0 end) as clawback_milli
from refunded;

do $$
declare
  u record; a public.loyalty_account%rowtype; e bigint; c bigint; target bigint;
  new_balance bigint; new_debt bigint; delta bigint;
begin
  for u in select distinct user_id from _loyalty_recon loop
    select * into a from public.loyalty_account where user_id=u.user_id for update;
    if not found then continue; end if;
    select coalesce(sum(earned_milli),0), coalesce(sum(clawback_milli),0) into e,c
      from _loyalty_recon where user_id=u.user_id;
    target:=e-c;
    new_balance:=greatest(0,target);
    new_debt:=greatest(0,-target);
    delta:=new_balance-a.balance_milli_points;
    insert into public.loyalty_reconciliation(user_id,old_balance_milli,new_balance_milli,old_debt_milli,new_debt_milli,
      target_earned_milli,target_clawback_milli,note)
      values(u.user_id,a.balance_milli_points,new_balance,a.debt_milli_points,new_debt,e,c,
        'One-time BA 5% reconciliation; manual accrual lock preserved');
    update public.loyalty_account set balance_milli_points=new_balance,debt_milli_points=new_debt,
      warning_flags=case when new_debt>0 then greatest(1,least(2,warning_flags)) else 0 end,
      updated_at=now() where user_id=u.user_id;
    update public.orders o set points_earned_milli=r.earned_milli
      from _loyalty_recon r where r.order_id=o.order_id and r.user_id=u.user_id;
    update public.loyalty_ledger l set amount_milli_points=r.earned_milli,
      expires_at=r.delivered_at+interval '6 months', note='Đối soát Point 5% theo BA'
      from _loyalty_recon r where l.user_id=u.user_id and l.order_id=r.order_id and l.kind='earn';
    insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at,note,created_at)
      select r.user_id,r.order_id,'earn',r.earned_milli,new_balance,r.delivered_at+interval '6 months',
        'Đối soát Point 5% theo BA',r.delivered_at
      from _loyalty_recon r where r.user_id=u.user_id and r.earned_milli>0
        and not exists(select 1 from public.loyalty_ledger l where l.user_id=u.user_id and l.order_id=r.order_id and l.kind='earn');
    if delta<>0 then
      insert into public.loyalty_ledger(user_id,kind,amount_milli_points,balance_after_milli_points,note)
        values(u.user_id,'reconcile',delta,new_balance,'Đối soát số dư Point 5% theo BA');
    end if;
    if new_balance>0 then
      insert into public.loyalty_point_lot(user_id,earned_milli,remaining_milli,expires_at,source)
        values(u.user_id,new_balance,new_balance,now()+interval '6 months','reconcile');
    end if;
  end loop;
end $$;

create or replace function public.velura_consume_loyalty_lots(
  p_user_id uuid,p_amount_milli bigint,p_ledger_id uuid
) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare lot record; remaining bigint:=p_amount_milli; take bigint;
begin
  if remaining<=0 then return; end if;
  for lot in select lot_id,remaining_milli from public.loyalty_point_lot
    where user_id=p_user_id and remaining_milli>0 and expires_at>now()
    order by expires_at,created_at,lot_id for update loop
    exit when remaining=0;
    take:=least(remaining,lot.remaining_milli);
    update public.loyalty_point_lot set remaining_milli=remaining_milli-take where lot_id=lot.lot_id;
    insert into public.loyalty_lot_use(ledger_id,lot_id,amount_milli) values(p_ledger_id,lot.lot_id,take);
    remaining:=remaining-take;
  end loop;
  if remaining>0 then raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
end; $$;
revoke all on function public.velura_consume_loyalty_lots(uuid,bigint,uuid) from public,anon,authenticated,service_role;

create or replace function public.velura_expire_loyalty_points(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare total bigint; a public.loyalty_account%rowtype;
begin
  select * into a from public.loyalty_account where user_id=p_user_id for update;
  if not found then return jsonb_build_object('user_id',p_user_id,'expired_milli',0); end if;
  perform 1 from public.loyalty_point_lot
    where user_id=p_user_id and remaining_milli>0 and expires_at<=now() for update;
  select coalesce(sum(remaining_milli),0) into total from public.loyalty_point_lot
    where user_id=p_user_id and remaining_milli>0 and expires_at<=now();
  if total=0 then return jsonb_build_object('user_id',p_user_id,'expired_milli',0); end if;
  update public.loyalty_point_lot set remaining_milli=0,expired_at=now()
    where user_id=p_user_id and remaining_milli>0 and expires_at<=now();
  update public.loyalty_account set balance_milli_points=greatest(0,balance_milli_points-total),updated_at=now()
    where user_id=p_user_id returning * into a;
  insert into public.loyalty_ledger(user_id,kind,amount_milli_points,balance_after_milli_points,note)
    values(p_user_id,'expired',-total,a.balance_milli_points,'Point hết hạn 6 tháng');
  return jsonb_build_object('user_id',p_user_id,'expired_milli',total,'balance_milli',a.balance_milli_points);
end; $$;
revoke all on function public.velura_expire_loyalty_points(uuid) from public,anon,authenticated;
grant execute on function public.velura_expire_loyalty_points(uuid) to service_role;

create or replace function public.velura_expire_all_loyalty_points()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare u record; result jsonb; total bigint:=0; users integer:=0;
begin
  for u in select distinct user_id from public.loyalty_point_lot where remaining_milli>0 and expires_at<=now() loop
    result:=public.velura_expire_loyalty_points(u.user_id);
    total:=total+coalesce((result->>'expired_milli')::bigint,0); users:=users+1;
  end loop;
  return jsonb_build_object('users',users,'expired_milli',total);
end; $$;
revoke all on function public.velura_expire_all_loyalty_points() from public,anon,authenticated;
grant execute on function public.velura_expire_all_loyalty_points() to service_role;

create or replace function public.velura_loyalty_quote(
  p_actor_id uuid,p_subtotal numeric,p_shipping numeric,p_discount numeric,p_points integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare s public.loyalty_settings%rowtype; a public.loyalty_account%rowtype;
  live bigint; available integer; by_cap integer; requested integer:=coalesce(p_points,0);
begin
  if p_subtotal<0 or p_shipping<0 or p_discount<0 or requested<0 then
    raise sqlstate 'PT422' using message='INVALID_POINTS'; end if;
  select * into s from public.loyalty_settings where id;
  select * into a from public.loyalty_account where user_id=p_actor_id;
  if not found then
    return jsonb_build_object('available_points',0,'max_points',0,'points_spent',0,'points_discount_amount',0,
      'policy_approved',false,'spending_enabled',false);
  end if;
  select coalesce(sum(remaining_milli),0) into live from public.loyalty_point_lot
    where user_id=p_actor_id and remaining_milli>0 and expires_at>now();
  available:=greatest(0,floor(least(a.balance_milli_points,live)/1000))::integer;
  by_cap:=greatest(0,floor(greatest(0,p_subtotal-p_discount)*s.max_discount_percent/100/1000))::integer;
  if requested>0 and (not s.spending_enabled or s.policy_approved_at is null) then
    raise sqlstate 'PT409' using message='LOYALTY_POLICY_APPROVAL_REQUIRED'; end if;
  if requested>least(available,by_cap) then raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
  return jsonb_build_object('available_points',available,'max_points',least(available,by_cap),
    'points_spent',requested,'points_discount_amount',requested*1000,
    'balance_points',(a.balance_milli_points-a.debt_milli_points)::numeric/1000,
    'debt_points',a.debt_milli_points::numeric/1000,'warning_flags',a.warning_flags,
    'policy_approved',s.policy_approved_at is not null,
    'spending_enabled',s.spending_enabled and s.policy_approved_at is not null);
end; $$;
revoke all on function public.velura_loyalty_quote(uuid,numeric,numeric,numeric,integer) from public,anon,authenticated;
grant execute on function public.velura_loyalty_quote(uuid,numeric,numeric,numeric,integer) to service_role;

create or replace function public.velura_award_order_loyalty(p_order_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_order public.orders%rowtype; v_account public.loyalty_account%rowtype;
  v_earned bigint; v_debt_paid bigint; v_credit bigint; v_merchandise numeric; v_ledger uuid;
begin
  select * into v_order from public.orders where order_id=p_order_id for update;
  if not found or v_order.status::text <> 'delivered' or v_order.user_id is null
     or v_order.delivered_at is null or v_order.delivered_at > now()
     or coalesce(v_order.order_kind::text,'sale')='exchange'
     or exists(select 1 from public.loyalty_ledger where order_id=p_order_id and kind='earn')
     or not exists(select 1 from public.payment where order_id=p_order_id
       and payment_status::text in ('paid','refund_pending','refunded')) then return; end if;
  perform public.velura_ensure_loyalty_account(v_order.user_id);
  select * into v_account from public.loyalty_account where user_id=v_order.user_id for update;
  if v_account.accrual_locked and v_account.accrual_lock_source in ('manual','legacy_unknown') then return; end if;
  v_merchandise := greatest(0,coalesce(v_order.subtotal,0)
    - case when exists(select 1 from public.voucher where voucher_id=v_order.voucher_id
        and discount_type::text='free_shipping') then 0 else coalesce(v_order.discount_amount,0) end
    - coalesce(v_order.points_discount,0));
  v_earned := floor(v_merchandise*5/100);
  v_debt_paid := least(v_earned,greatest(0,v_account.debt_milli_points));
  v_credit := v_earned-v_debt_paid;
  update public.loyalty_account set balance_milli_points=balance_milli_points+v_credit,
    debt_milli_points=debt_milli_points-v_debt_paid,
    warning_flags=case when debt_milli_points-v_debt_paid=0 then 0 else warning_flags end,
    updated_at=now() where user_id=v_order.user_id returning * into v_account;
  update public.orders set points_earned_milli=v_earned where order_id=p_order_id;
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at,note)
  values(v_order.user_id,p_order_id,'earn',v_credit,v_account.balance_milli_points,
    v_order.delivered_at+interval '6 months','Thưởng 5% khi đơn đã thanh toán và giao thành công')
  returning ledger_id into v_ledger;
  if v_credit>0 then
    insert into public.loyalty_point_lot(user_id,order_id,ledger_id,earned_milli,remaining_milli,expires_at,source)
      values(v_order.user_id,p_order_id,v_ledger,v_credit,v_credit,v_order.delivered_at+interval '6 months','award');
  end if;
  if v_debt_paid>0 then
    insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,
      debt_delta_milli_points,note)
    values(v_order.user_id,p_order_id,'debt_repayment',v_debt_paid,v_account.balance_milli_points,
      -v_debt_paid,'Điểm tích luỹ bù nợ trước khi cộng số dư khả dụng');
  end if;
  perform public.velura_complete_referral(v_order.user_id,p_order_id);
end; $$;

create or replace function public.velura_restore_order_points()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.loyalty_account%rowtype; redeem uuid; total bigint; restored bigint; use_row record;
  lot public.loyalty_point_lot%rowtype;
begin
  if new.status::text<>'cancelled' or old.status::text='cancelled' or coalesce(new.points_used,0)<=0 then return new; end if;
  if exists(select 1 from public.loyalty_ledger where order_id=new.order_id and kind='redeem_refund') then return new; end if;
  select ledger_id into redeem from public.loyalty_ledger where order_id=new.order_id and kind='redeem' order by created_at limit 1;
  select * into a from public.loyalty_account where user_id=new.user_id for update;
  if not found then return new; end if;
  total:=new.points_used::bigint*1000;
  update public.loyalty_account set balance_milli_points=balance_milli_points+total,updated_at=now()
    where user_id=new.user_id returning * into a;
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,note)
    values(new.user_id,new.order_id,'redeem_refund',total,a.balance_milli_points,'Hoàn Point khi đơn hủy/hết hạn');
  restored:=0;
  if redeem is not null then
    for use_row in select u.lot_id,u.amount_milli from public.loyalty_lot_use u where u.ledger_id=redeem loop
      select * into lot from public.loyalty_point_lot where lot_id=use_row.lot_id for update;
      if found and lot.expires_at>now() then
        update public.loyalty_point_lot set remaining_milli=least(earned_milli,remaining_milli+use_row.amount_milli)
          where lot_id=lot.lot_id;
      else
        insert into public.loyalty_point_lot(user_id,order_id,earned_milli,remaining_milli,expires_at,source)
          values(new.user_id,new.order_id,use_row.amount_milli,use_row.amount_milli,now()+interval '6 months','restore');
      end if;
      restored:=restored+use_row.amount_milli;
    end loop;
  end if;
  if total>restored then
    insert into public.loyalty_point_lot(user_id,order_id,earned_milli,remaining_milli,expires_at,source)
      values(new.user_id,new.order_id,total-restored,total-restored,now()+interval '6 months','restore');
  end if;
  return new;
end; $$;
drop trigger if exists loyalty_restore_order_points on public.orders;
create trigger loyalty_restore_order_points after update of status on public.orders
  for each row execute function public.velura_restore_order_points();

create unique index if not exists loyalty_order_refund_once on public.loyalty_ledger(order_id)
  where kind='redeem_refund';

create or replace function public.velura_create_checkout_order(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_actor uuid:=nullif(p_input->>'actorId','')::uuid; v_user uuid:=(p_input->>'userId')::uuid;
  v_points integer:=coalesce((p_input->>'pointsSpent')::integer,0); v_result jsonb; v_quote jsonb;
  v_order uuid; v_existing public.orders%rowtype; v_account public.loyalty_account%rowtype;
  v_base numeric; v_ledger uuid;
begin
  if auth.role() <> 'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if nullif(p_input->>'idempotencyKey','') is not null then
    select * into v_existing from public.orders where user_id=v_user
      and checkout_request_key=left(p_input->>'idempotencyKey',128);
    if found then
      return jsonb_build_object('order',to_jsonb(v_existing),
        'items',(select coalesce(jsonb_agg(to_jsonb(oi)),'[]') from public.order_item oi where order_id=v_existing.order_id));
    end if;
  end if;
  if v_points<=0 then return public.velura_create_checkout_order_commerce(p_input); end if;
  if v_actor is null or v_actor<>v_user or coalesce((p_input->>'isGuest')::boolean,false) then
    raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED'; end if;
  perform public.velura_expire_loyalty_points(v_actor);
  v_quote:=public.velura_loyalty_quote(v_actor,(p_input->>'subtotal')::numeric,
    (p_input->>'shippingFee')::numeric,(p_input->>'discountAmount')::numeric,v_points);
  if (v_quote->>'points_spent')::integer<>v_points then raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
  v_base:=greatest(0,(p_input->>'subtotal')::numeric+(p_input->>'shippingFee')::numeric-(p_input->>'discountAmount')::numeric);
  if (p_input->>'totalAmount')::numeric<>v_base-v_points*1000 then
    raise sqlstate 'PT422' using message='ORDER_TOTAL_MISMATCH'; end if;
  v_result:=public.velura_create_checkout_order_commerce(jsonb_set(p_input,'{totalAmount}',to_jsonb(v_base)));
  v_order:=(v_result#>>'{order,order_id}')::uuid;
  select * into v_account from public.loyalty_account where user_id=v_actor for update;
  if not found or v_account.balance_milli_points<v_points*1000 then
    raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
  update public.loyalty_account set balance_milli_points=balance_milli_points-v_points*1000,updated_at=now()
    where user_id=v_actor returning * into v_account;
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,note)
    values(v_actor,v_order,'redeem',-v_points*1000,v_account.balance_milli_points,'Sử dụng Point khi thanh toán')
    returning ledger_id into v_ledger;
  perform public.velura_consume_loyalty_lots(v_actor,v_points*1000,v_ledger);
  update public.orders set points_used=v_points,points_discount=v_points*1000,
    total_amount=v_base-v_points*1000,updated_at=now() where order_id=v_order;
  return jsonb_set(v_result,'{order}',(select to_jsonb(o) from public.orders o where order_id=v_order));
end; $$;
revoke all on function public.velura_create_checkout_order(jsonb) from public,anon,authenticated;
grant execute on function public.velura_create_checkout_order(jsonb) to service_role;

create or replace function public.admin_set_loyalty_spending(
  p_enabled boolean,p_max_percent numeric,p_reason text,p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_actor uuid:=public.velura_current_user_id(); v_role text; s public.loyalty_settings%rowtype;
begin
  if not public.velura_has_admin_role(array['super_admin']) then raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
  if length(btrim(coalesce(p_reason,'')))<10 then raise sqlstate 'PT422' using message='REASON_REQUIRED'; end if;
  if p_max_percent is null or p_max_percent<1 or p_max_percent>100 then raise sqlstate 'PT422' using message='INVALID_PERCENT'; end if;
  select admin_role::text into v_role from public.users where user_id=v_actor and role::text='admin' and is_active;
  select * into s from public.loyalty_settings where id for update;
  update public.loyalty_settings set spending_enabled=p_enabled,max_discount_percent=p_max_percent,
    policy_approved_at=case when p_enabled then coalesce(policy_approved_at,now()) else policy_approved_at end,
    updated_by=v_actor,updated_at=now(),version=version+1 where id;
  perform public.velura_append_module_audit('loyalty',v_actor,v_role,'update',null,
    to_jsonb(s),jsonb_build_object('spending_enabled',p_enabled,'max_discount_percent',p_max_percent,'reason',p_reason),p_ip_address);
  return jsonb_build_object('spending_enabled',p_enabled,'max_discount_percent',p_max_percent);
end; $$;
revoke all on function public.admin_set_loyalty_spending(boolean,numeric,text,text) from public,anon,authenticated;
grant execute on function public.admin_set_loyalty_spending(boolean,numeric,text,text) to service_role;


create or replace function public.velura_loyalty_snapshot(p_actor_id uuid,p_before uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_account public.loyalty_account%rowtype; v_balance numeric; v_settings public.loyalty_settings%rowtype;
  v_live bigint;
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if p_actor_id is null or not exists(select 1 from public.users
    where user_id=p_actor_id and role::text='member' and is_active) then
    raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED'; end if;
  perform public.velura_ensure_loyalty_account(p_actor_id);
  select * into v_account from public.loyalty_account where user_id=p_actor_id;
  select * into v_settings from public.loyalty_settings where id;
  select coalesce(sum(remaining_milli),0) into v_live from public.loyalty_point_lot
    where user_id=p_actor_id and remaining_milli>0 and expires_at>now();
  v_balance := (v_account.balance_milli_points-v_account.debt_milli_points)::numeric/1000;
  return jsonb_build_object(
    'member_id',p_actor_id,'referral_code',v_account.referral_code,'balance_points',v_balance,
    'available_points',greatest(0,floor(least(v_account.balance_milli_points,v_live)/1000)),
    'amount_vnd',v_balance*1000,'debt_points',v_account.debt_milli_points::numeric/1000,
    'warning_flags',v_account.warning_flags,'accrual_locked',v_account.accrual_locked,
    'accrual_lock_source',v_account.accrual_lock_source,
    'policy',jsonb_build_object('spending_enabled',v_settings.spending_enabled and v_settings.policy_approved_at is not null,
      'policy_approved_at',v_settings.policy_approved_at,
      'max_discount_percent',v_settings.max_discount_percent,
      'used_reward_reversal_policy','manual_review','used_reward_reversal_approved',false),
    'expiries',(select coalesce(jsonb_agg(jsonb_build_object(
      'points',x.remaining_milli::numeric/1000,'expires_at',x.expires_at) order by x.expires_at),'[]'::jsonb)
      from (select expires_at,sum(remaining_milli)::bigint remaining_milli from public.loyalty_point_lot
        where user_id=p_actor_id and remaining_milli>0 and expires_at>now() group by expires_at) x),
    'history',(select coalesce(jsonb_agg(jsonb_build_object(
      'entry_id',h.ledger_id,'kind',h.kind,'points',h.amount_milli_points::numeric/1000,
      'debt_change_points',h.debt_delta_milli_points::numeric/1000,
      'order_id',h.order_id,'expires_at',h.expires_at,'created_at',h.created_at)
      order by h.created_at desc,h.ledger_id desc),'[]'::jsonb)
      from (select l.* from public.loyalty_ledger l where l.user_id=p_actor_id and (
        p_before is null or (l.created_at,l.ledger_id)<(select c.created_at,c.ledger_id
          from public.loyalty_ledger c where c.ledger_id=p_before and c.user_id=p_actor_id))
        order by l.created_at desc,l.ledger_id desc limit 50) h),
    'referrals',(select coalesce(jsonb_agg(jsonb_build_object(
      'attribution_id',r.referral_id,'state',case when r.status in ('completed','successful') then 'qualified'
        when r.status='reversed' then 'reversed' else 'pending' end,'created_at',r.created_at)
      order by r.created_at desc),'[]'::jsonb) from public.referral r
      where r.referrer_user_id=p_actor_id or r.referred_user_id=p_actor_id),
    'reward_vouchers','[]'::jsonb);
end; $$;

notify pgrst,'reload schema';
commit;
