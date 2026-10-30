-- KAN-106: complete the 5% reconciliation for accounts that had no eligible delivered order.
-- Migration 087 only iterated users present in the recomputed order set; any residual balance
-- without a live lot is not spendable and would otherwise stay as a contradictory wallet value.
begin;

do $$
declare a public.loyalty_account%rowtype; lots bigint;
begin
  for a in select la.* from public.loyalty_account la
    where la.balance_milli_points<>0 or la.debt_milli_points<>0
    order by la.user_id loop
    select coalesce(sum(remaining_milli),0) into lots
      from public.loyalty_point_lot where user_id=a.user_id and remaining_milli>0;
    if lots=a.balance_milli_points and a.debt_milli_points=0 then continue; end if;
    insert into public.loyalty_reconciliation(user_id,old_balance_milli,new_balance_milli,old_debt_milli,new_debt_milli,
      target_earned_milli,target_clawback_milli,note)
      values(a.user_id,a.balance_milli_points,lots,a.debt_milli_points,0,lots,0,
        'Hoàn tất đối soát 5%: số dư không có lot hợp lệ');
    if a.balance_milli_points<>lots then
      insert into public.loyalty_ledger(user_id,kind,amount_milli_points,balance_after_milli_points,note)
        values(a.user_id,'reconcile',lots-a.balance_milli_points,lots,'Đối soát số dư Point không có lot hợp lệ');
    end if;
    update public.loyalty_account set balance_milli_points=lots,debt_milli_points=0,
      warning_flags=0,updated_at=now() where user_id=a.user_id;
  end loop;
  if exists(select 1 from public.loyalty_account a where a.balance_milli_points<>0
    and not exists(select 1 from public.loyalty_point_lot l where l.user_id=a.user_id and l.remaining_milli>0)) then
    raise exception 'LOYALTY_RECONCILE_ORPHAN_BALANCE';
  end if;
end $$;

notify pgrst,'reload schema';
commit;
