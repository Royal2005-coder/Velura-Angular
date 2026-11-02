-- Migration 105: BA 3.1.9 (accounts) + 3.1.15 (loyalty / referral) alignment.
--   1. REF_03  referrer reward voucher cap 500.000 -> 200.000 (20%, min 1.000.000, 60 days, single use).
--   2. REF_xx  referred-signup voucher is created explicitly + idempotently per referral; a failure leaves a
--              retryable `referral_reward_pending` row instead of silently skipping; reconcile grants it later.
--   3. MBR_06  one return request raises the warning flag at most once, however many refund operations it has.
--   4. 3.1.9   temporary lock auto-unlock (system audit 'AUTO_UNLOCK' + email) and super-admin resend of
--              email_outbox rows that failed after 3 attempts.
-- MBR_08 (2 flags auto-lock accrual) is intentionally NOT touched: business decision pending.
begin;

-- ---------------------------------------------------------------------------
-- 1. REF_03: cap 200.000đ.
-- The money functions may exist outside Git (see 079), so patch their live definition instead of copying it.
-- `\m500000\M` matches the literal only (never 1500000 / 5000000).
-- ---------------------------------------------------------------------------
do $patch$
declare v_fn record; v_def text; v_new text;
begin
  for v_fn in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('velura_complete_referral', 'velura_issue_referral_voucher', 'velura_create_checkout_order')
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    v_new := regexp_replace(v_def, '\m500000\M', '200000', 'g');
    if v_new <> v_def then
      execute v_new;
    end if;
  end loop;
end
$patch$;

-- Already issued, still UNUSED referrer rewards: lower the cap only when nobody has consumed the voucher.
-- Used / redeemed / revoked vouchers are left alone so history and past discounts stay truthful.
update public.voucher v
set max_discount_amount = 200000
from public.member_voucher mv
where mv.voucher_id = v.voucher_id
  and mv.benefit = 'referrer_reward'
  and mv.status = 'available'
  and mv.revoked_at is null
  and mv.used_order_id is null
  and v.max_discount_amount > 200000
  and coalesce(v.used_count, 0) = 0
  and not exists (select 1 from public.orders o where o.voucher_id = v.voucher_id);

update public.voucher v
set max_discount_amount = 200000
from public.reward_voucher rv
where rv.voucher_id = v.voucher_id
  and rv.reward_kind = 'referrer_delivery'
  and rv.state = 'issued'
  and v.max_discount_amount > 200000
  and coalesce(v.used_count, 0) = 0
  and not exists (select 1 from public.orders o where o.voucher_id = v.voucher_id);

-- ---------------------------------------------------------------------------
-- 2. Referred-signup voucher: explicit, idempotent, retryable.
-- ---------------------------------------------------------------------------
create table if not exists public.referral_reward_pending (
  referral_id uuid primary key references public.referral(referral_id) on delete cascade,
  user_id uuid not null references public.users(user_id),
  reward_kind text not null default 'referred_signup',
  reason text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  granted_at timestamptz,
  member_voucher_id uuid references public.member_voucher(member_voucher_id)
);
create index if not exists referral_reward_pending_open_idx
  on public.referral_reward_pending(created_at) where granted_at is null;
alter table public.referral_reward_pending enable row level security;
revoke all on public.referral_reward_pending from public, anon, authenticated;

-- BA REF: 20%, max 200.000đ, min order 1.000.000đ, 60 days from issue, one use. Per-member voucher so the
-- 60-day window starts at issue time and `usage_limit_total = 1` enforces single use. One per referral.
create or replace function public.velura_issue_referral_signup_voucher(p_referral_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_existing uuid; v_voucher uuid; v_code text;
begin
  select member_voucher_id into v_existing from public.member_voucher
    where referral_id = p_referral_id and user_id = p_user_id and benefit = 'referred_signup' limit 1;
  if found then return v_existing; end if;

  v_code := 'REF' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 24));
  insert into public.voucher(code, name, discount_type, discount_value, max_discount_amount, min_order_value,
    usage_limit_total, usage_limit_per_user, applicable_user_group, start_date, end_date, is_active,
    created_by, reward_member_id)
  values (v_code, 'Ưu đãi giới thiệu thành viên', 'percentage', 20, 200000, 1000000, 1, 1, 'all_users',
    now(), now() + interval '60 days', true, p_user_id, p_user_id)
  returning voucher_id into v_voucher;

  insert into public.member_voucher(user_id, voucher_id, referral_id, benefit, status)
  values (p_user_id, v_voucher, p_referral_id, 'referred_signup', 'available')
  returning member_voucher_id into v_existing;
  return v_existing;
end;
$$;
revoke all on function public.velura_issue_referral_signup_voucher(uuid, uuid) from public, anon, authenticated;
grant execute on function public.velura_issue_referral_signup_voucher(uuid, uuid) to service_role;

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
  v_error text;
begin
  if auth.role() <> 'service_role' then
    raise sqlstate 'PT403' using message = 'LOYALTY_SERVER_ONLY';
  end if;

  if v_code is not null then
    select u.* into v_referrer
    from public.loyalty_account a
    join public.users u on u.user_id = a.user_id
    where upper(btrim(a.referral_code)) = v_code and u.role::text = 'member' and u.is_active;
    if not found then
      raise sqlstate 'PT422' using message = 'INVALID_REFERRAL_CODE';
    end if;
    if (nullif(lower(p_input->>'email'), '') is not null and lower(v_referrer.email) = lower(p_input->>'email'))
      or (nullif(p_input->>'phone', '') is not null and v_referrer.phone = p_input->>'phone') then
      raise sqlstate 'PT422' using message = 'SELF_REFERRAL_FORBIDDEN';
    end if;
  end if;

  insert into public.users(email, phone, password_hash, full_name, is_active, otp_code, otp_expires_at, role)
  values (nullif(p_input->>'email', ''), nullif(p_input->>'phone', ''), p_input->>'password_hash',
    p_input->>'full_name', false, p_input->>'otp_code', (p_input->>'otp_expires_at')::timestamp, 'member')
  returning * into v_user;

  perform public.velura_ensure_loyalty_account(v_user.user_id);

  if v_code is not null then
    insert into public.referral(referrer_user_id, referred_user_id, status)
    values (v_referrer.user_id, v_user.user_id, 'pending')
    returning referral_id into v_referral_id;

    -- Never let a voucher problem break signup, but never lose the reward either: park it as pending.
    begin
      perform public.velura_issue_referral_signup_voucher(v_referral_id, v_user.user_id);
    exception when others then
      get stacked diagnostics v_error = message_text;
      insert into public.referral_reward_pending(referral_id, user_id, reason, attempts, last_error, last_attempt_at)
      values (v_referral_id, v_user.user_id, 'VOUCHER_ISSUE_FAILED', 1, left(v_error, 500), now())
      on conflict (referral_id) do nothing;
    end;
  end if;

  return to_jsonb(v_user);
end;
$$;
revoke all on function public.velura_register_member(jsonb, text) from public, anon, authenticated;
grant execute on function public.velura_register_member(jsonb, text) to service_role;

-- Same shape as 088: safe to re-run. Retries parked rows and also backfills referrals that never received the
-- signup voucher (e.g. registered before this migration). Returns the number of rewards granted.
create or replace function public.velura_reconcile_referral_rewards()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_row public.referral_reward_pending%rowtype; v_mv uuid; v_granted integer := 0; v_error text;
begin
  insert into public.referral_reward_pending(referral_id, user_id, reason)
  select r.referral_id, r.referred_user_id, 'MISSING_SIGNUP_VOUCHER'
  from public.referral r
  where r.status in ('pending', 'successful', 'completed')
    and not exists (select 1 from public.member_voucher mv
      where mv.referral_id = r.referral_id and mv.benefit = 'referred_signup')
  on conflict (referral_id) do nothing;

  for v_row in
    select * from public.referral_reward_pending where granted_at is null order by created_at for update skip locked
  loop
    begin
      v_mv := public.velura_issue_referral_signup_voucher(v_row.referral_id, v_row.user_id);
      update public.referral_reward_pending
        set granted_at = now(), member_voucher_id = v_mv, attempts = attempts + 1,
            last_attempt_at = now(), last_error = null
        where referral_id = v_row.referral_id;
      v_granted := v_granted + 1;
    exception when others then
      get stacked diagnostics v_error = message_text;
      update public.referral_reward_pending
        set attempts = attempts + 1, last_attempt_at = now(), last_error = left(v_error, 500)
        where referral_id = v_row.referral_id;
    end;
  end loop;
  return v_granted;
end;
$$;
revoke all on function public.velura_reconcile_referral_rewards() from public, anon, authenticated;
grant execute on function public.velura_reconcile_referral_rewards() to service_role;

-- ---------------------------------------------------------------------------
-- 3. MBR_06: at most one warning flag per return request.
-- The 086 loop adds a flag for every refund operation with a shortfall. Patch the live definition: a flag is only
-- added when this return has no earlier clawback ledger row carrying debt (rows are written inside the same loop).
-- ---------------------------------------------------------------------------
do $mbr06$
declare v_oid oid; v_def text; v_new text;
begin
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'velura_adjust_loyalty_for_return' and p.pronargs = 1;
  if v_oid is null then raise exception 'MBR06_FUNCTION_MISSING'; end if;
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def,
    'warning_flags=least(2,warning_flags+case when v_short>0 then 1 else 0 end),updated_at=now()',
    'warning_flags=least(2,warning_flags+case when v_short>0 and not exists(select 1 from public.loyalty_ledger pl '
    || 'where pl.return_id=v_operation.return_id and pl.kind=''clawback'' and pl.debt_delta_milli_points>0) '
    || 'then 1 else 0 end),updated_at=now()');
  if v_new = v_def then raise exception 'MBR06_PATCH_NOT_APPLIED'; end if;
  execute v_new;
end
$mbr06$;

-- ---------------------------------------------------------------------------
-- 4a. Temporary lock auto-unlock. System actor, so audit uses action 'unlock' (audit_action enum has no
--     auto value) and tags the row with new_value.audit_event = 'AUTO_UNLOCK'.
-- ---------------------------------------------------------------------------
create or replace function public.velura_auto_unlock_expired_locks(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_before public.users%rowtype; v_after public.users%rowtype; v_count integer := 0;
begin
  for v_before in
    select * from public.users
    where lock_type = 'temporary' and locked_until is not null and locked_until <= now()
      and (p_user_id is null or user_id = p_user_id)
    order by locked_until for update skip locked
  loop
    update public.users
    set is_active = true, lock_type = null, lock_reason = null, locked_by = null, locked_at = null,
        locked_until = null, unlock_reason = 'Tự động mở khóa khi hết hạn khóa tạm thời',
        login_fail_count = 0, version = version + 1, updated_at = now()
    where user_id = v_before.user_id and lock_type = 'temporary'
    returning * into v_after;
    if v_after.user_id is null then continue; end if;

    perform public.velura_append_module_audit('accounts', null, 'system', 'unlock', v_after.user_id,
      public.velura_safe_user(v_before),
      public.velura_safe_user(v_after) || jsonb_build_object('audit_event', 'AUTO_UNLOCK'), null);
    perform public.velura_enqueue_account_email(v_after.email, 'account_unlocked',
      'Tai khoan Velura da duoc mo khoa',
      'Tai khoan cua ban da duoc mo khoa tu dong vi het han khoa tam thoi.', v_after.user_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.velura_auto_unlock_expired_locks(uuid) from public, anon, authenticated;
grant execute on function public.velura_auto_unlock_expired_locks(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. Super admin re-queues an email that failed for good (status failed, attempts >= 3). Idempotent: a row
--     that is no longer in that state returns false and is left untouched.
-- ---------------------------------------------------------------------------
create or replace function public.admin_resend_failed_email(p_email_id uuid, p_ip_address text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_actor public.users%rowtype; v_row public.email_outbox%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  update public.email_outbox
  set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null,
      metadata = metadata || jsonb_build_object('resent_by', v_actor.user_id, 'resent_at', now())
  where email_id = p_email_id and status = 'failed' and attempts >= 3
  returning * into v_row;

  if v_row.email_id is null then
    return jsonb_build_object('email_id', p_email_id, 'requeued', false);
  end if;
  if v_row.related_user_id is not null then
    perform public.velura_append_module_audit('accounts', v_actor.user_id, v_actor.admin_role::text, 'update',
      v_row.related_user_id, jsonb_build_object('email_status', 'failed'),
      jsonb_build_object('email_status', 'pending', 'audit_event', 'EMAIL_RESEND', 'email_id', v_row.email_id,
        'template_code', v_row.template_code), p_ip_address);
  end if;
  return jsonb_build_object('email_id', v_row.email_id, 'requeued', true);
end;
$$;
revoke all on function public.admin_resend_failed_email(uuid, text) from public, anon;
grant execute on function public.admin_resend_failed_email(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
