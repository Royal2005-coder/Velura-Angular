-- KAN-106: successful refund operations reconcile independently; debt never locks purchasing or accrual.
begin;

alter table public.loyalty_ledger
  add column if not exists payment_refund_id uuid references public.payment_refund(refund_id),
  add column if not exists debt_delta_milli_points bigint not null default 0;
create unique index if not exists loyalty_refund_operation_once
  on public.loyalty_ledger(payment_refund_id) where payment_refund_id is not null;

alter table public.loyalty_account add column if not exists accrual_lock_source text;
-- 073/080 changed the flag and wrote a clawback at the same transaction timestamp.
-- Only that positive evidence permits removal of an automatic lock. Missing provenance stays locked.
with provenance as (
  select a.user_id,a.accrual_locked,a.warning_flags,a.updated_at,
    (select h.new_value->>'accrual_locked' from public.audit_log h
      where h.module='members' and h.target_id=a.user_id and h.actor_id is not null
        and h.actor_role::text='super_admin' and h.action::text in ('lock','unlock')
        and h.old_value ? 'accrual_locked' and h.new_value ? 'accrual_locked'
      order by h.timestamp desc,h.audit_id desc limit 1) as manual_state,
    exists(select 1 from public.loyalty_ledger l where l.user_id=a.user_id and l.kind='clawback'
      and l.created_at=a.updated_at) as automated_write
  from public.loyalty_account a where a.accrual_lock_source is null
)
update public.loyalty_account a set
  accrual_locked=case when p.manual_state='true' then true
    when p.accrual_locked and p.warning_flags>=2 and p.automated_write then false else p.accrual_locked end,
  accrual_lock_source=case when p.manual_state='true' then 'manual'
    when p.accrual_locked and p.warning_flags>=2 and p.automated_write then 'none'
    when p.accrual_locked then 'legacy_unknown' else 'none' end
from provenance p where p.user_id=a.user_id;
alter table public.loyalty_account alter column accrual_lock_source set default 'none';
alter table public.loyalty_account alter column accrual_lock_source set not null;

create or replace function public.admin_set_member_accrual_lock(
  p_user_id uuid,p_locked boolean,p_reason text,p_ip_address text default null
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare
  v_actor uuid:=public.velura_current_user_id();
  v_role text;
  v_account public.loyalty_account%rowtype;
  v_before boolean;
  v_source text;
begin
  if not public.velura_has_admin_role(array['super_admin']) then
    raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
  select admin_role::text into v_role from public.users
    where user_id=v_actor and role::text='admin' and is_active;
  if not exists(select 1 from public.users where user_id=p_user_id and role::text='member') then
    raise sqlstate 'PT404' using message='MEMBER_NOT_FOUND'; end if;
  if p_locked is null then raise sqlstate 'PT422' using message='MEMBER_LOCK_STATE_REQUIRED'; end if;
  if length(btrim(coalesce(p_reason,'')))<8 then
    raise sqlstate 'PT422' using message='MEMBER_LOCK_REASON_REQUIRED'; end if;
  perform public.velura_ensure_loyalty_account(p_user_id);
  select * into v_account from public.loyalty_account where user_id=p_user_id for update;
  v_before:=v_account.accrual_locked;
  v_source:=v_account.accrual_lock_source;
  if v_before=p_locked and v_source=(case when p_locked then 'manual' else 'none' end) then
    return jsonb_build_object('user_id',p_user_id,'accrual_locked',v_before,'changed',false); end if;
  update public.loyalty_account set accrual_locked=p_locked,
    accrual_lock_source=case when p_locked then 'manual' else 'none' end,updated_at=now()
    where user_id=p_user_id;
  perform public.velura_append_module_audit('members',v_actor,v_role,
    case when p_locked then 'lock' else 'unlock' end,p_user_id,
    jsonb_build_object('accrual_locked',v_before,'accrual_lock_source',v_source),
    jsonb_build_object('accrual_locked',p_locked,'accrual_lock_source',case when p_locked then 'manual' else 'none' end,
      'reason',btrim(p_reason)),p_ip_address);
  return jsonb_build_object('user_id',p_user_id,'accrual_locked',p_locked,'changed',true);
end; $$;

create or replace function public.velura_award_order_loyalty(p_order_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_order public.orders%rowtype;
  v_account public.loyalty_account%rowtype;
  v_earned bigint;
  v_debt_paid bigint;
  v_credit bigint;
  v_merchandise numeric;
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
  -- Only the independently administered lock is consulted; debt and warnings are not eligibility rules.
  if v_account.accrual_locked and v_account.accrual_lock_source in ('manual','legacy_unknown') then return; end if;
  v_merchandise := greatest(0,coalesce(v_order.subtotal,0)
    - case when exists(select 1 from public.voucher where voucher_id=v_order.voucher_id
        and discount_type::text='free_shipping') then 0 else coalesce(v_order.discount_amount,0) end
    - coalesce(v_order.points_discount,0));
  v_earned := floor(v_merchandise/1000)*1000;
  v_debt_paid := least(v_earned,greatest(0,v_account.debt_milli_points));
  v_credit := v_earned-v_debt_paid;
  update public.loyalty_account set balance_milli_points=balance_milli_points+v_credit,
    debt_milli_points=debt_milli_points-v_debt_paid,
    warning_flags=case when debt_milli_points-v_debt_paid=0 then 0 else warning_flags end,
    updated_at=now() where user_id=v_order.user_id returning * into v_account;
  update public.orders set points_earned_milli=v_earned where order_id=p_order_id;
  -- A zero credit is still an award marker when all earned points repay debt.
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at,note)
  values(v_order.user_id,p_order_id,'earn',v_credit,v_account.balance_milli_points,
    date_trunc('year',v_order.delivered_at+interval '1 year'),'Thưởng khi đơn đã thanh toán và giao thành công');
  if v_debt_paid>0 then
    insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,
      debt_delta_milli_points,note)
    values(v_order.user_id,p_order_id,'debt_repayment',v_debt_paid,v_account.balance_milli_points,
      -v_debt_paid,'Điểm tích luỹ bù nợ trước khi cộng số dư khả dụng');
  end if;
  perform public.velura_complete_referral(v_order.user_id,p_order_id);
end; $$;

create or replace function public.velura_adjust_loyalty_for_return(p_return_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_order public.orders%rowtype;
  v_account public.loyalty_account%rowtype;
  v_operation record;
  v_refunded numeric;
  v_net_paid numeric;
  v_prior bigint;
  v_live_earned bigint;
  v_target bigint;
  v_clawback bigint;
  v_taken bigint;
  v_short bigint;
begin
  -- Same order lock as payment completion serializes different requests for the original purchase.
  select o.* into v_order from public.orders o join public.return_exchange r on r.order_id=o.order_id
    where r.return_id=p_return_id for update of o;
  if not found or v_order.user_id is null then return; end if;
  if not exists(select 1 from public.payment_refund p join public.return_exchange r on r.return_id=p.return_id
    where r.order_id=v_order.order_id and p.status='succeeded') then return; end if;
  perform public.velura_ensure_loyalty_account(v_order.user_id);
  select * into v_account from public.loyalty_account where user_id=v_order.user_id for update;
  v_net_paid := greatest(0,coalesce(v_order.subtotal,0)
    - case when exists(select 1 from public.voucher where voucher_id=v_order.voucher_id
        and discount_type::text='free_shipping') then 0 else coalesce(v_order.discount_amount,0) end
    - coalesce(v_order.points_discount,0));
  -- Legacy earn rows are the lots. Never collect a lot after its expiry, even if the expiry job is late.
  -- Debt repayments are earned value too, but have no spendable lot; use their paired earn's expiry.
  select greatest(0,least(coalesce(v_order.points_earned_milli,0),
    coalesce(sum(case when l.kind='earn' and (l.expires_at is null or l.expires_at>now())
      then greatest(0,l.amount_milli_points)
      when l.kind='debt_repayment' and exists(select 1 from public.loyalty_ledger e
        where e.order_id=v_order.order_id and e.kind='earn' and (e.expires_at is null or e.expires_at>now()))
      then greatest(0,l.amount_milli_points)
      when l.kind in ('expiry','expired') then -abs(l.amount_milli_points) else 0 end),0)))
    into v_live_earned from public.loyalty_ledger l where l.order_id=v_order.order_id;
  select coalesce(sum(-amount_milli_points),0) into v_prior from public.loyalty_ledger
    where order_id=v_order.order_id and kind in ('clawback','reversed') and amount_milli_points<0;
  select coalesce(sum(p.amount),0) into v_refunded from public.payment_refund p
    join public.loyalty_ledger l on l.payment_refund_id=p.refund_id
    join public.return_exchange r on r.return_id=p.return_id
    where r.order_id=v_order.order_id and p.status='succeeded';
  for v_operation in
    select p.* from public.payment_refund p join public.return_exchange r on r.return_id=p.return_id
    left join public.return_item ri on ri.return_item_id=p.return_item_id
    where r.order_id=v_order.order_id and p.status='succeeded'
      and ((p.return_item_id is not null and ri.resolution_type='refund')
        or (p.return_item_id is null and r.return_type::text='refund'))
      and not exists(select 1 from public.loyalty_ledger l where l.payment_refund_id=p.refund_id)
    order by p.created_at,p.refund_id
  loop
    v_refunded := v_refunded+v_operation.amount;
    v_target := case when v_net_paid>0 then least(coalesce(v_order.points_earned_milli,0),
      round(coalesce(v_order.points_earned_milli,0)*least(v_refunded/v_net_paid,1))) else 0 end;
    v_clawback := greatest(0,least(v_target-v_prior,v_live_earned-v_prior));
    v_taken := least(greatest(0,v_account.balance_milli_points),v_clawback);
    v_short := v_clawback-v_taken;
    update public.loyalty_account set balance_milli_points=balance_milli_points-v_taken,
      debt_milli_points=debt_milli_points+v_short,
      warning_flags=least(2,warning_flags+case when v_short>0 then 1 else 0 end),updated_at=now()
      where user_id=v_order.user_id returning * into v_account;
    -- Zero records intentionally reconcile expired/previously reversed lots without charging them again.
    insert into public.loyalty_ledger(user_id,order_id,return_id,payment_refund_id,kind,amount_milli_points,
      balance_after_milli_points,debt_delta_milli_points,note)
    values(v_order.user_id,v_order.order_id,v_operation.return_id,v_operation.refund_id,'clawback',-v_clawback,
      v_account.balance_milli_points,v_short,'Đối soát thu hồi điểm theo giao dịch hoàn tiền thành công');
    v_prior := v_prior+v_clawback;
  end loop;

  -- Every original order line must be fully refunded, cumulatively across requests; exchanges never count.
  -- EXISTS avoids multiplying quantities when more than one financial row references the same part.
  if exists(select 1 from public.order_item where order_id=v_order.order_id)
     and not exists(select 1 from public.order_item oi where oi.order_id=v_order.order_id and oi.quantity>(
       select coalesce(sum(ri.quantity),0) from public.return_item ri
       join public.return_exchange r on r.return_id=ri.return_id
       where r.order_id=v_order.order_id and ri.order_item_id=oi.item_id and ri.resolution_type='refund'
         and exists(select 1 from public.payment_refund p where p.return_id=r.return_id and p.status='succeeded'
           and (p.return_item_id=ri.return_item_id or (p.return_item_id is null and r.return_type::text='refund')))
     )) then
    update public.referral set status='reversed',reversed_at=now()
      where qualifying_order_id=v_order.order_id and status='successful';
    update public.voucher v set is_active=false from public.member_voucher mv,public.referral r
      where mv.voucher_id=v.voucher_id and mv.referral_id=r.referral_id and r.qualifying_order_id=v_order.order_id
        and r.status='reversed' and mv.benefit='referrer_reward' and mv.status='available';
    update public.member_voucher mv set status='revoked',revoked_at=now() from public.referral r
      where mv.referral_id=r.referral_id and r.qualifying_order_id=v_order.order_id and r.status='reversed'
        and mv.benefit='referrer_reward' and mv.status='available';
  end if;
end; $$;

create or replace function public.velura_loyalty_snapshot(p_actor_id uuid,p_before uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_account public.loyalty_account%rowtype; v_balance numeric;
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if p_actor_id is null or not exists(select 1 from public.users
    where user_id=p_actor_id and role::text='member' and is_active) then
    raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED'; end if;
  perform public.velura_ensure_loyalty_account(p_actor_id);
  select * into v_account from public.loyalty_account where user_id=p_actor_id;
  v_balance := (v_account.balance_milli_points-v_account.debt_milli_points)::numeric/1000;
  return jsonb_build_object(
    'member_id',p_actor_id,'referral_code',v_account.referral_code,'balance_points',v_balance,
    'available_points',greatest(0,floor(v_account.balance_milli_points::numeric/1000)),
    'amount_vnd',v_balance*1000,'debt_points',v_account.debt_milli_points::numeric/1000,
    'warning_flags',v_account.warning_flags,'accrual_locked',v_account.accrual_locked,
    'accrual_lock_source',v_account.accrual_lock_source,
    'policy',jsonb_build_object('spending_enabled',false,'policy_approved_at',null,
      'used_reward_reversal_policy','manual_review','used_reward_reversal_approved',false),
    'expiries','[]'::jsonb,
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

comment on function public.velura_adjust_loyalty_for_return(uuid) is
  'Reconcile succeeded per-item refund operations across original order requests; warning-only debt, no exchange clawback, expired lots excluded.';
comment on column public.loyalty_ledger.debt_delta_milli_points is
  'Debt movement audited independently of spendable balance; positive creates debt, negative repays it.';
comment on column public.loyalty_account.accrual_lock_source is
  'none/manual/legacy_unknown: explicit operator locks remain separate from warning-only refund debt; unknown legacy provenance requires review.';
revoke all on function public.velura_adjust_loyalty_for_return(uuid),public.velura_award_order_loyalty(uuid)
  from public,anon,authenticated;
grant execute on function public.velura_adjust_loyalty_for_return(uuid),public.velura_award_order_loyalty(uuid) to service_role;
notify pgrst,'reload schema';
commit;
