-- KAN-316: production loyalty_account/loyalty_ledger policy.
-- Earn only after delivery: 1 point per 1,000 VND. Expiry is 1 January of the
-- following year. Refund clawbacks remain debt-backed so the displayed balance
-- can become negative when a refund exceeds the available balance.
begin;

update public.loyalty_ledger
set expires_at = date_trunc('year', created_at + interval '1 year')
where kind = 'earn' and created_at is not null;

create or replace function public.velura_award_order_loyalty(p_order_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_order public.orders%rowtype;
  v_account public.loyalty_account%rowtype;
  v_earned bigint;
  v_debt_paid bigint;
  v_credit bigint;
  v_expiry timestamptz;
begin
  select * into v_order from public.orders
  where order_id=p_order_id and status::text='delivered' for update;
  if v_order.order_id is null
     or exists(select 1 from public.loyalty_ledger where order_id=p_order_id and kind='earn') then
    return;
  end if;
  v_account := public.velura_ensure_loyalty_account(v_order.user_id);
  select * into v_account from public.loyalty_account where user_id=v_order.user_id for update;
  v_earned := floor(greatest(v_order.subtotal-v_order.discount_amount-v_order.points_discount,0) / 1000) * 1000;
  if v_earned <= 0 then return; end if;
  v_debt_paid := least(v_earned, v_account.debt_milli_points);
  v_credit := v_earned-v_debt_paid;
  v_expiry := date_trunc('year',coalesce(v_order.delivered_at,now()) + interval '1 year');
  update public.loyalty_account set balance_milli_points=balance_milli_points+v_credit,
    debt_milli_points=debt_milli_points-v_debt_paid,
    warning_flags=case when debt_milli_points-v_debt_paid=0 then 0 else warning_flags end,
    accrual_locked=case when debt_milli_points-v_debt_paid=0 then false else accrual_locked end,
    updated_at=now()
  where user_id=v_order.user_id returning * into v_account;
  update public.orders set points_earned_milli=v_earned where order_id=p_order_id;
  insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,expires_at,note)
  values(v_order.user_id,p_order_id,'earn',v_credit,v_account.balance_milli_points,v_expiry,'Thưởng 1 Point / 1.000đ khi giao thành công');
  if v_debt_paid>0 then
    insert into public.loyalty_ledger(user_id,order_id,kind,amount_milli_points,balance_after_milli_points,note)
    values(v_order.user_id,p_order_id,'debt_repayment',v_debt_paid,v_account.balance_milli_points,'Bù Point còn thiếu');
  end if;
  perform public.velura_complete_referral(v_order.user_id,p_order_id);
end; $$;

create or replace function public.velura_adjust_loyalty_for_return(p_return_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_return public.return_exchange%rowtype;
  v_order public.orders%rowtype;
  v_account public.loyalty_account%rowtype;
  v_return_value numeric;
  v_clawback bigint;
  v_taken bigint;
  v_short bigint;
  v_full boolean;
begin
  select * into v_return from public.return_exchange
  where return_id=p_return_id and status::text in ('completed','COMPLETED','refunded','REFUNDED') for update;
  if v_return.return_id is null or exists(select 1 from public.loyalty_ledger where return_id=p_return_id and kind='clawback') then return; end if;
  select * into v_order from public.orders where order_id=v_return.order_id for update;
  if v_order.points_earned_milli <= 0 then return; end if;
  select coalesce(sum(ri.quantity*oi.unit_price),0) into v_return_value
  from public.return_item ri join public.order_item oi on oi.item_id=ri.order_item_id where ri.return_id=p_return_id;
  v_clawback := least(v_order.points_earned_milli, round(v_order.points_earned_milli * v_return_value / greatest(v_order.subtotal,1)));
  select * into v_account from public.loyalty_account where user_id=v_order.user_id for update;
  v_taken := least(v_account.balance_milli_points,v_clawback); v_short := v_clawback-v_taken;
  update public.loyalty_account set balance_milli_points=balance_milli_points-v_taken,
    debt_milli_points=debt_milli_points+v_short,
    warning_flags=least(2,warning_flags+case when v_short>0 then 1 else 0 end),
    accrual_locked=(least(2,warning_flags+case when v_short>0 then 1 else 0 end)>=2), updated_at=now()
  where user_id=v_order.user_id returning * into v_account;
  insert into public.loyalty_ledger(user_id,order_id,return_id,kind,amount_milli_points,balance_after_milli_points,note)
  values(v_order.user_id,v_order.order_id,p_return_id,'clawback',-v_clawback,v_account.balance_milli_points,'Thu hồi Point theo hàng trả');
  select coalesce(sum(ri.quantity),0) >= coalesce((select sum(oi.quantity) from public.order_item oi where oi.order_id=v_order.order_id),1)
  into v_full from public.return_item ri where ri.return_id=p_return_id;
  if v_full then
    update public.referral set status='reversed',reversed_at=now() where qualifying_order_id=v_order.order_id and status='successful';
    update public.voucher v set is_active=false from public.member_voucher mv, public.referral r
      where mv.voucher_id=v.voucher_id and mv.referral_id=r.referral_id and r.qualifying_order_id=v_order.order_id
        and mv.benefit='referrer_reward' and mv.status='available';
    update public.member_voucher mv set status='revoked',revoked_at=now() from public.referral r
      where mv.referral_id=r.referral_id and r.qualifying_order_id=v_order.order_id and mv.benefit='referrer_reward' and mv.status='available';
  end if;
end; $$;

create or replace function public.velura_loyalty_return_trigger()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.status::text in ('completed','COMPLETED','refunded','REFUNDED')
     and old.status::text is distinct from new.status::text then
    perform public.velura_adjust_loyalty_for_return(new.return_id);
  end if;
  return new;
end; $$;

notify pgrst,'reload schema';
commit;
