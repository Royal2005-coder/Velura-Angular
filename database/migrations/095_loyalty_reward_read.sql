begin;

-- The storefront wallet promised "điểm thưởng / voucher của tôi" but the server always answered
-- with an empty array, so a member who earned a referral voucher could never see it. The rows
-- already exist in member_voucher; only the read was missing.
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

-- admin_set_loyalty_spending existed with no reader: the ERP could not show whether point spending
-- was on, so the switch was invisible even to super admin. Overview now carries its live state.
create or replace function public.admin_member_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare s public.loyalty_settings%rowtype;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into s from public.loyalty_settings where id;

  return jsonb_build_object(
    'members', (select count(*) from public.users where role::text = 'member'),
    'with_wallet', (select count(*) from public.loyalty_account),
    'total_points_milli', (select coalesce(sum(balance_milli_points - debt_milli_points), 0) from public.loyalty_account),
    'negative_accounts', (select count(*) from public.loyalty_account where balance_milli_points < debt_milli_points),
    'locked_accounts', (select count(*) from public.loyalty_account where accrual_locked),
    'flagged_accounts', (select count(*) from public.loyalty_account where warning_flags > 0),
    'referrals_pending', (select count(*) from public.referral where status = 'pending'),
    'referrals_successful', (select count(*) from public.referral where status = 'successful'),
    'vouchers_available', (select count(*) from public.member_voucher where status = 'available'),
    'ledger_entries', (select count(*) from public.loyalty_ledger),
    'zero_entries', (select count(*) from public.loyalty_ledger where amount_milli_points = 0),
    'earliest_expiry', (select min(expires_at) from public.loyalty_ledger where kind = 'earn' and expires_at > now()),
    'last_ledger_at', (select max(created_at) from public.loyalty_ledger),
    'loyalty_spending', jsonb_build_object(
      'spending_enabled', s.spending_enabled,
      'effectively_enabled', s.spending_enabled and s.policy_approved_at is not null,
      'max_discount_percent', s.max_discount_percent,
      'policy_approved_at', s.policy_approved_at,
      'version', s.version)
  );
end;
$$;

notify pgrst, 'reload schema';
commit;
