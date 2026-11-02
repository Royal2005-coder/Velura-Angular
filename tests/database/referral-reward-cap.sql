-- Disposable/local PostgreSQL only, after migrations through 105. All fixtures roll back.
\set ON_ERROR_STOP on
begin;
set local session_replication_role=replica;
insert into public.users(user_id,email,password_hash,full_name,role,is_active) values
 ('a5000000-0000-4000-8000-000000000001','ref-owner@example.invalid','fixture','Ref Owner','member',true);
set local session_replication_role=origin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $$
declare v_code text; v_new jsonb; v_ref uuid; v_mv public.member_voucher%rowtype; v_v public.voucher%rowtype; v_granted integer;
begin
  perform public.velura_ensure_loyalty_account('a5000000-0000-4000-8000-000000000001');
  select referral_code into v_code from public.loyalty_account where user_id='a5000000-0000-4000-8000-000000000001';

  -- Registration with a referral code issues one explicit signup voucher: 20%, cap 200k, min 1M, 60 days, single use.
  v_new := public.velura_register_member(jsonb_build_object('email','ref-new@example.invalid','password_hash','fixture',
    'full_name','Ref New','otp_code','000000','otp_expires_at',(now()+interval '5 minutes')::text), v_code);
  select * into v_mv from public.member_voucher where user_id=(v_new->>'user_id')::uuid and benefit='referred_signup';
  if v_mv.member_voucher_id is null then raise exception 'signup voucher missing'; end if;
  select * into v_v from public.voucher where voucher_id=v_mv.voucher_id;
  if v_v.discount_value<>20 or v_v.max_discount_amount<>200000 or v_v.min_order_value<>1000000
     or v_v.usage_limit_total<>1 or v_v.end_date>now()+interval '61 days' or v_v.end_date<now()+interval '59 days' then
    raise exception 'signup voucher shape wrong';
  end if;

  -- Issuing twice is idempotent.
  v_ref := v_mv.referral_id;
  if public.velura_issue_referral_signup_voucher(v_ref,(v_new->>'user_id')::uuid)<>v_mv.member_voucher_id then
    raise exception 'issue not idempotent';
  end if;

  -- Reconcile grants a parked reward later, and only once.
  delete from public.member_voucher where member_voucher_id=v_mv.member_voucher_id;
  insert into public.referral_reward_pending(referral_id,user_id,reason)
    values(v_ref,(v_new->>'user_id')::uuid,'TEST');
  v_granted := public.velura_reconcile_referral_rewards();
  if v_granted<1 then raise exception 'reconcile granted nothing'; end if;
  if (select count(*) from public.member_voucher where referral_id=v_ref and benefit='referred_signup')<>1 then
    raise exception 'reconcile did not grant exactly one voucher';
  end if;
  if public.velura_reconcile_referral_rewards()<>0 then raise exception 'reconcile not idempotent'; end if;
end $$;

-- Temporary lock expiry: auto-unlock restores access, writes the audit row and queues the email.
set local session_replication_role=replica;
update public.users set is_active=false,lock_type='temporary',locked_until=now()-interval '1 minute',lock_reason='x'
  where user_id='a5000000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
do $$
begin
  if public.velura_auto_unlock_expired_locks('a5000000-0000-4000-8000-000000000001')<>1 then raise exception 'auto unlock missed'; end if;
  if not exists(select 1 from public.users where user_id='a5000000-0000-4000-8000-000000000001' and is_active and lock_type is null) then
    raise exception 'account still locked';
  end if;
  if not exists(select 1 from public.audit_log where target_id='a5000000-0000-4000-8000-000000000001'
    and new_value->>'audit_event'='AUTO_UNLOCK') then raise exception 'AUTO_UNLOCK audit missing'; end if;
  if public.velura_auto_unlock_expired_locks('a5000000-0000-4000-8000-000000000001')<>0 then raise exception 'auto unlock not idempotent'; end if;
end $$;
rollback;
