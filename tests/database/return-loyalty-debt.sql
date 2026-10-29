-- Disposable/local PostgreSQL only, after migrations 084, 085 and 086. All fixtures roll back.
-- Fixtures alone bypass unrelated inventory/history triggers; business function assertions run normally.
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

insert into public.users(user_id,email,password_hash,full_name,role,is_active)
select ('96000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'loyalty-return-'||n||'@example.test','synthetic-only','Loyalty fixture '||n,'member',true
from generate_series(1,6) n;
insert into public.loyalty_account(user_id,referral_code,balance_milli_points,debt_milli_points,warning_flags,accrual_locked,accrual_lock_source)
select ('96000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'VLRTESTRETURN'||n,
  case n when 1 then 20000 when 2 then 10000 when 4 then 100000 else 0 end,
  case n when 3 then 100000 when 6 then 30000 else 0 end,
  case when n=6 then 2 else 0 end,n=6,case when n=6 then 'manual' else 'none' end
from generate_series(1,6) n;
insert into public.orders(order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_address,
  subtotal,total_amount,payment_method,delivered_at,points_earned_milli,points_discount_amount,points_spent,order_kind)
select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('96000000-0000-4000-8000-'||lpad((case n when 2 then 1 when 3 then 2 when 4 then 3 when 5 then 4 when 6 then 5 when 7 then 6 else 1 end)::text,12,'0'))::uuid,
  'LR-TEST-'||n,'delivered','Synthetic buyer','0900000000','Local only',
  case when n=2 then 120000 else 100000 end,100000,'COD',now()-interval '1 day',
  case when n in (1,3,4,5) then 100000 else 0 end,
  case when n=2 then 20000 else 0 end,case when n=2 then 20 else 0 end,
  case when n=9 then 'exchange' else 'sale' end
from generate_series(1,9) n;
insert into public.order_item(item_id,order_id,variant_id,product_name,quantity,unit_price,subtotal_item)
select ('98000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '98000000-0000-4000-8000-999999999999','Synthetic garment',2,50000,100000
from generate_series(1,9) n;
insert into public.payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status)
select ('99000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'COD','cod',100000,
  (case when n=8 then 'pending' else 'paid' end)::public.payment_status
from generate_series(1,9) n;
insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at)
select o.user_id,o.order_id,'earn',100000,100000,
  case when o.order_id='97000000-0000-4000-8000-000000000003' then now()-interval '1 day' else now()+interval '30 days' end
from public.orders o where o.order_id in ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000004','97000000-0000-4000-8000-000000000005');
insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points)
values('96000000-0000-4000-8000-000000000003','97000000-0000-4000-8000-000000000004','clawback',-100000,0);

-- Requests stay nonterminal: a successful part must reconcile immediately, not wait for the header.
insert into public.return_exchange(return_id,order_id,user_id,return_type,status,version)
select ('9a000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('97000000-0000-4000-8000-'||lpad((case when n=7 then 6 else n end)::text,12,'0'))::uuid,
  ('96000000-0000-4000-8000-'||lpad((case n when 2 then 1 when 3 then 2 when 4 then 3 when 5 then 4 when 6 then 5 when 7 then 5 else 1 end)::text,12,'0'))::uuid,
  (case when n in (5,7) then 'exchange' else 'refund' end)::public.return_type,'REQUESTED',1
from generate_series(1,7) n;
insert into public.return_item(return_item_id,return_id,order_item_id,quantity,resolution_type,item_status,decision_status)
select ('9b000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('9a000000-0000-4000-8000-'||lpad((case when n=8 then 1 else n end)::text,12,'0'))::uuid,
  ('98000000-0000-4000-8000-'||lpad((case when n=8 then 1 when n=7 then 6 else n end)::text,12,'0'))::uuid,
  case when n in (2,3,4,5) then 2 else 1 end,case when n=5 then 'exchange' else 'refund' end,
  'COMPLETED','approved'
from generate_series(1,8) n;
insert into public.payment_refund(refund_id,return_id,return_item_id,payment_id,amount,status,created_at)
select ('9c000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('9a000000-0000-4000-8000-'||lpad((case when n=8 then 1 else n end)::text,12,'0'))::uuid,
  ('9b000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('99000000-0000-4000-8000-'||lpad((case when n=8 then 1 when n=7 then 6 else n end)::text,12,'0'))::uuid,
  case when n in (1,6,7,8) then 50000 else 100000 end,
  case when n=8 then 'pending' when n=7 then 'failed' when n=2 then 'requested' else 'succeeded' end,
  now()+n*interval '1 second'
from generate_series(1,8) n;
insert into public.referral(referral_id,referrer_user_id,referred_user_id,qualifying_order_id,status)
values('9d000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000006',
  '96000000-0000-4000-8000-000000000005','97000000-0000-4000-8000-000000000006','successful');
insert into public.voucher(voucher_id,code,name,discount_type,discount_value,start_date,end_date,is_active,created_by)
 values('9e000000-0000-4000-8000-000000000001','V-AVAIL','Synthetic reward','percentage',20,now(),now()+interval '1 day',true,'96000000-0000-4000-8000-000000000006'),
  ('9e000000-0000-4000-8000-000000000002','V-USED','Synthetic used reward','percentage',20,now(),now()+interval '1 day',true,'96000000-0000-4000-8000-000000000006');
insert into public.member_voucher(user_id,voucher_id,referral_id,benefit,status)
values('96000000-0000-4000-8000-000000000006','9e000000-0000-4000-8000-000000000001','9d000000-0000-4000-8000-000000000001','referrer_reward','available'),
  ('96000000-0000-4000-8000-000000000006','9e000000-0000-4000-8000-000000000002','9d000000-0000-4000-8000-000000000001','referrer_reward','used');
set local session_replication_role = origin;

do $$
declare a public.loyalty_account%rowtype; n integer;
begin
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000001');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>0 or a.debt_milli_points<>30000 or a.accrual_locked or a.warning_flags<>1 then
    raise exception '50-point refund must take20 and create30 warning-only debt: %',to_jsonb(a); end if;
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000001');
  select count(*) into n from public.loyalty_ledger where payment_refund_id='9c000000-0000-4000-8000-000000000001';
  if n<>1 then raise exception 'Duplicate refund created duplicate ledger markers'; end if;
  if exists(select 1 from public.loyalty_ledger where payment_refund_id='9c000000-0000-4000-8000-000000000008') then
    raise exception 'Pending operation clawed back points'; end if;
  update public.payment_refund set status='succeeded' where refund_id='9c000000-0000-4000-8000-000000000008';
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000001');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000001';
  if a.debt_milli_points<>80000 or a.warning_flags<>2 or a.accrual_locked then
    raise exception 'Second successful part must reach80 debt without automatic lock: %',to_jsonb(a); end if;
  if (select sum(amount_milli_points) from public.loyalty_ledger where order_id='97000000-0000-4000-8000-000000000001' and kind='clawback')<>-100000 then
    raise exception 'Partial refund aggregate differs from100 originally earned'; end if;

  perform public.velura_award_order_loyalty('97000000-0000-4000-8000-000000000002');
  perform public.velura_award_order_loyalty('97000000-0000-4000-8000-000000000002');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>20000 or a.debt_milli_points<>0 or a.warning_flags<>0 then
    raise exception '100 earned must repay80 debt then credit20 exactly once: %',to_jsonb(a); end if;
  if (select count(*) from public.loyalty_ledger where order_id='97000000-0000-4000-8000-000000000002' and kind='debt_repayment' and debt_delta_milli_points=-80000)<>1 then
    raise exception 'Debt repayment audit missing or duplicated'; end if;
  update public.payment_refund set status='succeeded' where refund_id='9c000000-0000-4000-8000-000000000002';
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000002');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000001';
  if a.balance_milli_points<>0 or a.debt_milli_points<>80000 then
    raise exception 'Refund must reverse100 earned including debt offset, never charge20 checkout redemption again: %',to_jsonb(a); end if;

  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000003');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000002';
  if a.balance_milli_points<>10000 or a.debt_milli_points<>0 then raise exception 'Expired earn lot clawed back: %',to_jsonb(a); end if;
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000004');
  if (select debt_milli_points from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000003')<>100000 then
    raise exception 'Already reversed earned points created a second debt'; end if;
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000005');
  if (select balance_milli_points from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000004')<>100000 then
    raise exception 'Exchange clawed back earned points'; end if;
  if exists(select 1 from public.loyalty_ledger where payment_refund_id='9c000000-0000-4000-8000-000000000005') then
    raise exception 'Exchange financial fixture was treated as a refundable part'; end if;

  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000006');
  if (select status from public.referral where referral_id='9d000000-0000-4000-8000-000000000001')<>'successful' then
    raise exception 'Failed second refund reversed referral early'; end if;
  update public.payment_refund set status='succeeded' where refund_id='9c000000-0000-4000-8000-000000000007';
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000007');
  perform public.velura_adjust_loyalty_for_return('9a000000-0000-4000-8000-000000000006');
  if (select status from public.referral where referral_id='9d000000-0000-4000-8000-000000000001')<>'reversed' then
    raise exception 'Zero-earned order full refund across two requests failed to reverse referral'; end if;
  if (select status from public.member_voucher where voucher_id='9e000000-0000-4000-8000-000000000001')<>'revoked'
    or (select is_active from public.voucher where voucher_id='9e000000-0000-4000-8000-000000000001') then
    raise exception 'Available referral reward was not revoked'; end if;
  if (select status from public.member_voucher where voucher_id='9e000000-0000-4000-8000-000000000002')<>'used' then
    raise exception 'Used referral reward policy unexpectedly changed'; end if;

  perform public.velura_award_order_loyalty('97000000-0000-4000-8000-000000000007');
  select * into a from public.loyalty_account where user_id='96000000-0000-4000-8000-000000000006';
  if a.debt_milli_points<>30000 or not a.accrual_locked or a.accrual_lock_source<>'manual' then
    raise exception 'Manual lock was cleared by automatic debt/accrual processing'; end if;
  perform public.velura_award_order_loyalty('97000000-0000-4000-8000-000000000008');
  perform public.velura_award_order_loyalty('97000000-0000-4000-8000-000000000009');
  if exists(select 1 from public.loyalty_ledger where kind='earn' and order_id in
    ('97000000-0000-4000-8000-000000000008','97000000-0000-4000-8000-000000000009')) then
    raise exception 'Unpaid or exchange order accrued revenue points'; end if;

  -- 086 regression: velura_loyalty_snapshot returns negative balance and positive debt_points
  -- without altering available_points or dropping ledger integrity.
  if (select (public.velura_loyalty_snapshot('96000000-0000-4000-8000-000000000001')->>'balance_points')::numeric)<> -80 then
    raise exception 'Snapshot balance points calculation failed'; end if;
  if (select (public.velura_loyalty_snapshot('96000000-0000-4000-8000-000000000001')->>'debt_points')::numeric)<> 80 then
    raise exception 'Snapshot debt points calculation failed'; end if;
end $$;
rollback;
