-- KAN-315: expose the existing loyalty_account/loyalty_ledger model through the storefront wallet contract.
begin;

create or replace function public.velura_loyalty_snapshot(p_actor_id uuid, p_before uuid default null)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,auth
as $$
declare
  account public.loyalty_account%rowtype;
  balance_points numeric;
begin
  if auth.role() <> 'service_role' then
    raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY';
  end if;
  if p_actor_id is null or not exists (
    select 1 from public.users
    where user_id=p_actor_id and role::text='member' and is_active
  ) then
    raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED';
  end if;

  insert into public.loyalty_account(user_id,referral_code)
  values(p_actor_id,'VLR'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16)))
  on conflict(user_id) do nothing;

  select * into account from public.loyalty_account where user_id=p_actor_id;
  balance_points := (account.balance_milli_points-account.debt_milli_points)::numeric/1000;

  return jsonb_build_object(
    'member_id',p_actor_id,
    'referral_code',account.referral_code,
    'balance_points',balance_points,
    'available_points',greatest(0,floor(balance_points)),
    'amount_vnd',balance_points*1000,
    'policy',jsonb_build_object(
      'spending_enabled',false,
      'policy_approved_at',null,
      'used_reward_reversal_policy','manual_review',
      'used_reward_reversal_approved',false
    ),
    'expiries','[]'::jsonb,
    'history',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id',history.ledger_id,
        'kind',history.kind,
        'points',history.amount_milli_points::numeric/1000,
        'order_id',history.order_id,
        'expires_at',history.expires_at,
        'created_at',history.created_at
      ) order by history.created_at desc,history.ledger_id desc),'[]'::jsonb)
      from (
        select ledger.* from public.loyalty_ledger ledger
        where ledger.user_id=p_actor_id and (
          p_before is null or (ledger.created_at,ledger.ledger_id)<(
            select cursor.created_at,cursor.ledger_id from public.loyalty_ledger cursor
            where cursor.ledger_id=p_before and cursor.user_id=p_actor_id
          )
        )
        order by ledger.created_at desc,ledger.ledger_id desc limit 50
      ) history
    ),
    'referrals',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'attribution_id',referral.referral_id,
        'state',case referral.status when 'completed' then 'qualified' when 'reversed' then 'reversed' else 'pending' end,
        'created_at',referral.created_at
      ) order by referral.created_at desc),'[]'::jsonb)
      from public.referral
      where referral.referrer_user_id=p_actor_id or referral.referred_user_id=p_actor_id
    ),
    'reward_vouchers','[]'::jsonb
  );
end;
$$;

revoke all on function public.velura_loyalty_snapshot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.velura_loyalty_snapshot(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
