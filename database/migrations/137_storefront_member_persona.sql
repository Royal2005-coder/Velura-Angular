-- KAN-32: one active account may shop as a member on the storefront while retaining
-- its admin capability in the admin console. The API admits the account to these
-- server-only RPCs only after a server-signed storefront session dropped admin RBAC.
begin;

create or replace function public.velura_loyalty_snapshot(p_actor_id uuid,p_before uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_account public.loyalty_account%rowtype; v_balance numeric; v_settings public.loyalty_settings%rowtype;
  v_live bigint;
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if p_actor_id is null or not exists(select 1 from public.users
    where user_id=p_actor_id and role::text in ('member','admin') and is_active) then
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
    'reward_vouchers',(select coalesce(jsonb_agg(jsonb_build_object(
      'member_voucher_id',w.member_voucher_id,'code',w.code,'name',w.name,'benefit',w.benefit,
      'status',w.status,'discount_type',w.discount_type,'discount_value',w.discount_value,
      'min_order_value',w.min_order_value,'expires_at',w.end_date,'issued_at',w.issued_at,
      'source',case when w.referral_id is not null then 'referral' else 'issue' end)
      order by w.issued_at desc,w.member_voucher_id desc),'[]'::jsonb)
      from (select mv.member_voucher_id,mv.benefit,mv.status,mv.issued_at,mv.referral_id,
               v.code,v.name,v.discount_type,v.discount_value,v.min_order_value,v.end_date
        from public.member_voucher mv join public.voucher v using(voucher_id)
        where mv.user_id=p_actor_id and mv.revoked_at is null
        order by mv.issued_at desc limit 50) w));
end; $$;

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
       and payment_status::text in ('paid','refund_pending','refunded'))
     or v_order.is_guest is distinct from false
     or not exists(select 1 from public.users
       where user_id=v_order.user_id and role::text in ('member','admin') and is_active) then return; end if;
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

notify pgrst, 'reload schema';
commit;
