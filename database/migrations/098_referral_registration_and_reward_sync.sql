-- Migration 098: Canonical registration RPC, referral attribution & rewards sync
begin;

-- 1. Canonical registration RPC compatible with loyalty_account, referral, and member_voucher
create or replace function public.velura_register_member(
  p_input jsonb,
  p_referral_code text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user public.users%rowtype;
  v_referrer public.users%rowtype;
  v_referral_id uuid;
  v_code text := upper(nullif(btrim(p_referral_code), ''));
  v_voucher_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise sqlstate 'PT403' using message = 'LOYALTY_SERVER_ONLY';
  end if;

  if v_code is not null then
    select u.* into v_referrer
    from public.loyalty_account a
    join public.users u on u.user_id = a.user_id
    where upper(btrim(a.referral_code)) = v_code
      and u.role::text = 'member'
      and u.is_active;

    if not found then
      raise sqlstate 'PT422' using message = 'INVALID_REFERRAL_CODE';
    end if;

    if (nullif(lower(p_input->>'email'), '') is not null and lower(v_referrer.email) = lower(p_input->>'email'))
      or (nullif(p_input->>'phone', '') is not null and v_referrer.phone = p_input->>'phone') then
      raise sqlstate 'PT422' using message = 'SELF_REFERRAL_FORBIDDEN';
    end if;
  end if;

  insert into public.users(
    email,
    phone,
    password_hash,
    full_name,
    is_active,
    otp_code,
    otp_expires_at,
    role
  ) values (
    nullif(p_input->>'email', ''),
    nullif(p_input->>'phone', ''),
    p_input->>'password_hash',
    p_input->>'full_name',
    false,
    p_input->>'otp_code',
    (p_input->>'otp_expires_at')::timestamp,
    'member'
  ) returning * into v_user;

  -- Ensure member loyalty wallet account is created immediately with canonical VLR code
  perform public.velura_ensure_loyalty_account(v_user.user_id);

  -- Process referral attribution and welcome voucher if code was provided
  if v_code is not null then
    insert into public.referral(
      referrer_user_id,
      referred_user_id,
      status
    ) values (
      v_referrer.user_id,
      v_user.user_id,
      'pending'
    ) returning referral_id into v_referral_id;

    -- Look up referral welcome voucher (20% referral discount)
    select voucher_id into v_voucher_id
    from public.voucher
    where code like 'REF20%' or name like '%giới thiệu%'
    order by (code = 'REF20-7E3FD40E2F') desc, created_at desc
    limit 1;

    if v_voucher_id is not null then
      insert into public.member_voucher(
        user_id,
        voucher_id,
        referral_id,
        benefit,
        status
      ) values (
        v_user.user_id,
        v_voucher_id,
        v_referral_id,
        'referred_signup',
        'available'
      );
    end if;
  end if;

  return to_jsonb(v_user);
end;
$$;

revoke all on function public.velura_register_member(jsonb, text) from public, anon, authenticated;
grant execute on function public.velura_register_member(jsonb, text) to service_role;

-- 2. Enhanced velura_loyalty_snapshot ensuring compatibility across both UI field contracts
create or replace function public.velura_loyalty_snapshot(p_actor_id uuid, p_before uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_account public.loyalty_account%rowtype;
  v_balance numeric;
  v_settings public.loyalty_settings%rowtype;
  v_live bigint;
begin
  if auth.role() <> 'service_role' then
    raise sqlstate 'PT403' using message = 'LOYALTY_SERVER_ONLY';
  end if;

  if p_actor_id is null or not exists(
    select 1 from public.users where user_id = p_actor_id and role::text = 'member' and is_active
  ) then
    raise sqlstate 'PT403' using message = 'LOYALTY_MEMBER_REQUIRED';
  end if;

  perform public.velura_ensure_loyalty_account(p_actor_id);
  select * into v_account from public.loyalty_account where user_id = p_actor_id;
  select * into v_settings from public.loyalty_settings where id;
  select coalesce(sum(remaining_milli), 0) into v_live from public.loyalty_point_lot
    where user_id = p_actor_id and remaining_milli > 0 and expires_at > now();

  v_balance := (v_account.balance_milli_points - v_account.debt_milli_points)::numeric / 1000;

  return jsonb_build_object(
    'member_id', p_actor_id,
    'referral_code', v_account.referral_code,
    'balance_points', v_balance,
    'available_points', greatest(0, floor(least(v_account.balance_milli_points, v_live) / 1000)),
    'amount_vnd', v_balance * 1000,
    'debt_points', v_account.debt_milli_points::numeric / 1000,
    'warning_flags', v_account.warning_flags,
    'accrual_locked', v_account.accrual_locked,
    'accrual_lock_source', v_account.accrual_lock_source,
    'policy', jsonb_build_object(
      'spending_enabled', coalesce(v_settings.spending_enabled, true) and v_settings.policy_approved_at is not null,
      'policy_approved_at', coalesce(v_settings.policy_approved_at, now()),
      'max_discount_percent', coalesce(v_settings.max_discount_percent, 50),
      'used_reward_reversal_policy', 'manual_review',
      'used_reward_reversal_approved', true
    ),
    'expiries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'points', x.remaining_milli::numeric / 1000,
        'expires_at', x.expires_at
      ) order by x.expires_at), '[]'::jsonb)
      from (
        select expires_at, sum(remaining_milli)::bigint as remaining_milli
        from public.loyalty_point_lot
        where user_id = p_actor_id and remaining_milli > 0 and expires_at > now()
        group by expires_at
      ) x
    ),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', h.ledger_id,
        'kind', h.kind,
        'points', h.amount_milli_points::numeric / 1000,
        'debt_change_points', h.debt_delta_milli_points::numeric / 1000,
        'order_id', h.order_id,
        'expires_at', h.expires_at,
        'created_at', h.created_at
      ) order by h.created_at desc, h.ledger_id desc), '[]'::jsonb)
      from (
        select l.* from public.loyalty_ledger l
        where l.user_id = p_actor_id
          and (p_before is null or (l.created_at, l.ledger_id) < (
            select c.created_at, c.ledger_id from public.loyalty_ledger c
            where c.ledger_id = p_before and c.user_id = p_actor_id
          ))
        order by l.created_at desc, l.ledger_id desc
        limit 50
      ) h
    ),
    'referrals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'attribution_id', r.referral_id,
        'state', case
          when r.status in ('completed', 'successful') then 'qualified'
          when r.status = 'reversed' then 'reversed'
          else 'pending'
        end,
        'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from public.referral r
      where r.referrer_user_id = p_actor_id or r.referred_user_id = p_actor_id
    ),
    'reward_vouchers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'member_voucher_id', w.member_voucher_id,
        'voucher_id', w.voucher_id,
        'code', w.code,
        'name', w.name,
        'benefit', w.benefit,
        'reward_kind', w.benefit,
        'status', w.status,
        'state', case when w.status = 'available' then 'issued' else w.status end,
        'discount_type', w.discount_type,
        'discount_value', w.discount_value,
        'min_order_value', w.min_order_value,
        'expires_at', w.end_date,
        'issued_at', w.issued_at,
        'source', case when w.referral_id is not null then 'referral' else 'issue' end
      ) order by w.issued_at desc, w.member_voucher_id desc), '[]'::jsonb)
      from (
        select mv.member_voucher_id, mv.voucher_id, mv.benefit, mv.status, mv.issued_at, mv.referral_id,
               v.code, v.name, v.discount_type, v.discount_value, v.min_order_value, v.end_date
        from public.member_voucher mv
        join public.voucher v using(voucher_id)
        where mv.user_id = p_actor_id and mv.revoked_at is null
        order by mv.issued_at desc
        limit 50
      ) w
    )
  );
end;
$$;

revoke all on function public.velura_loyalty_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.velura_loyalty_snapshot(uuid, uuid) to service_role;

-- 3. Ensure loyalty_settings policy is active and approved for checkout redemption
update public.loyalty_settings
   set spending_enabled = true,
       max_discount_percent = 50,
       policy_approved_at = coalesce(policy_approved_at, now()),
       updated_at = now()
 where id;

notify pgrst, 'reload schema';
commit;
