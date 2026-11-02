-- Migration 099: Auto-activate loyalty wallet accounts for 100% of members and protect quote RPC
begin;

-- 1. Ensure loyalty_account exists for all existing members
insert into public.loyalty_account(user_id, referral_code)
select u.user_id, 'VLR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))
from public.users u
where u.role::text = 'member' and u.is_active
on conflict (user_id) do nothing;

-- 2. Trigger on public.users to auto-create loyalty_account whenever a user becomes or is created as a member
create or replace function public.velura_users_ensure_loyalty_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.role::text = 'member' and new.is_active then
    perform public.velura_ensure_loyalty_account(new.user_id);
  end if;
  return new;
end;
$$;

drop trigger if exists users_ensure_loyalty_account on public.users;
create trigger users_ensure_loyalty_account
  after insert or update of role, is_active on public.users
  for each row execute function public.velura_users_ensure_loyalty_trigger();

-- 3. Ensure velura_loyalty_quote creates loyalty_account if missing and handles null gracefully
create or replace function public.velura_loyalty_quote(
  p_actor_id uuid,
  p_subtotal numeric,
  p_shipping numeric,
  p_discount numeric,
  p_points integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s public.loyalty_settings%rowtype;
  a public.loyalty_account%rowtype;
  live bigint;
  available integer;
  by_cap integer;
  requested integer := greatest(0, coalesce(p_points, 0));
begin
  if auth.role() <> 'service_role' then
    raise sqlstate 'PT403' using message = 'LOYALTY_SERVER_ONLY';
  end if;

  select * into s from public.loyalty_settings where id;

  if p_actor_id is null or not exists(
    select 1 from public.users where user_id = p_actor_id and role::text = 'member' and is_active
  ) then
    return jsonb_build_object(
      'available_points', 0, 'max_points', 0, 'points_spent', 0, 'points_discount_amount', 0,
      'policy_approved', coalesce(s.policy_approved_at is not null, true),
      'spending_enabled', coalesce(s.spending_enabled, true) and s.policy_approved_at is not null
    );
  end if;

  perform public.velura_ensure_loyalty_account(p_actor_id);
  select * into a from public.loyalty_account where user_id = p_actor_id;

  select coalesce(sum(remaining_milli), 0) into live from public.loyalty_point_lot
    where user_id = p_actor_id and remaining_milli > 0 and expires_at > now();

  available := greatest(0, floor(least(a.balance_milli_points, live) / 1000))::integer;
  by_cap := greatest(0, floor(greatest(0, p_subtotal - p_discount) * coalesce(s.max_discount_percent, 50) / 100 / 1000))::integer;

  if requested > 0 and (not coalesce(s.spending_enabled, true) or s.policy_approved_at is null) then
    raise sqlstate 'PT409' using message = 'LOYALTY_POLICY_APPROVAL_REQUIRED';
  end if;

  if requested > least(available, by_cap) then
    raise sqlstate 'PT409' using message = 'POINTS_CHANGED';
  end if;

  return jsonb_build_object(
    'available_points', available,
    'max_points', least(available, by_cap),
    'points_spent', requested,
    'points_discount_amount', requested * 1000,
    'balance_points', (a.balance_milli_points - a.debt_milli_points)::numeric / 1000,
    'debt_points', a.debt_milli_points::numeric / 1000,
    'warning_flags', a.warning_flags,
    'policy_approved', s.policy_approved_at is not null,
    'spending_enabled', coalesce(s.spending_enabled, true) and s.policy_approved_at is not null
  );
end;
$$;

revoke all on function public.velura_loyalty_quote(uuid, numeric, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.velura_loyalty_quote(uuid, numeric, numeric, numeric, integer) to service_role;

notify pgrst, 'reload schema';
commit;
