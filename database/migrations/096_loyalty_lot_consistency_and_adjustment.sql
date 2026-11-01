begin;

-- Return clawback reduced loyalty_account.balance but never touched loyalty_point_lot, while the
-- expiry job subtracts whatever a lot still reports as remaining. A point that had already been
-- taken back for a refund was therefore subtracted a second time when its lot aged out.
-- Consuming the lots at the moment the clawback is booked makes the two jobs agree.
create or replace function public.velura_consume_loyalty_lots_tolerant(
  p_user_id uuid,p_amount_milli bigint,p_ledger_id uuid
) returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare lot record; remaining bigint:=p_amount_milli; taken bigint:=0; take bigint;
begin
  if coalesce(p_amount_milli,0)<=0 or p_ledger_id is null then return 0; end if;
  for lot in select lot_id,remaining_milli from public.loyalty_point_lot
    where user_id=p_user_id and remaining_milli>0 and expires_at>now()
    order by expires_at,created_at,lot_id for update loop
    exit when remaining=0;
    take:=least(remaining,lot.remaining_milli);
    update public.loyalty_point_lot set remaining_milli=remaining_milli-take where lot_id=lot.lot_id;
    insert into public.loyalty_lot_use(ledger_id,lot_id,amount_milli) values(p_ledger_id,lot.lot_id,take);
    remaining:=remaining-take; taken:=taken+take;
  end loop;
  -- Unlike redemption, a refund reversal must never fail because lots do not cover the amount:
  -- legacy and reconciled balances legitimately exceed live lots, and the account is already right.
  return taken;
end; $$;
revoke all on function public.velura_consume_loyalty_lots_tolerant(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.velura_consume_loyalty_lots_tolerant(uuid,bigint,uuid) to service_role;

create or replace function public.velura_loyalty_clawback_uses_lots() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- Only refund reversals: redemption already books its own lot usage through the spend path.
  if new.kind='clawback' and new.amount_milli_points<0 then
    perform public.velura_consume_loyalty_lots_tolerant(new.user_id,-new.amount_milli_points,new.ledger_id);
  end if;
  return new;
end; $$;

drop trigger if exists loyalty_clawback_uses_lots on public.loyalty_ledger;
create trigger loyalty_clawback_uses_lots
  after insert on public.loyalty_ledger
  for each row execute function public.velura_loyalty_clawback_uses_lots();

-- Operations had no way to correct a wallet by hand: the ledger, RBAC and audit helpers existed but
-- no writer did, so every fix went through support as a new request.
create table if not exists public.loyalty_manual_adjustment_key (
  idempotency_key text primary key,
  user_id uuid not null references public.users(user_id),
  ledger_id uuid not null references public.loyalty_ledger(ledger_id),
  created_at timestamptz not null default now()
);
alter table public.loyalty_manual_adjustment_key enable row level security;
revoke all on public.loyalty_manual_adjustment_key from public,anon,authenticated;
grant all on public.loyalty_manual_adjustment_key to service_role;

create or replace function public.admin_adjust_member_points(
  p_user_id uuid,p_points integer,p_reason text,p_idempotency_key text,
  p_return_id uuid default null,p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_actor uuid:=public.velura_current_user_id(); v_role text;
  a public.loyalty_account%rowtype; l public.loyalty_ledger%rowtype;
  milli bigint; taken bigint; short bigint; existing jsonb;
begin
  if not public.velura_has_admin_role(array['super_admin']) then raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
  select admin_role::text into v_role from public.users where user_id=v_actor and role::text='admin' and is_active;
  if v_role is null then raise sqlstate 'PT403' using message='RBAC_DENIED'; end if;
  if p_user_id is null then raise sqlstate 'PT422' using message='MEMBER_NOT_FOUND'; end if;
  if p_points is null or p_points=0 or abs(p_points)>1000000 then
    raise sqlstate 'PT422' using message='INVALID_POINTS'; end if;
  if length(btrim(coalesce(p_reason,'')))<10 then raise sqlstate 'PT422' using message='MEMBER_LOCK_REASON_REQUIRED'; end if;
  if length(btrim(coalesce(p_idempotency_key,'')))<8 then raise sqlstate 'PT422' using message='TRANSFER_REFERENCE_REQUIRED'; end if;

  select jsonb_build_object('ledger_id',k.ledger_id,'user_id',k.user_id,'idempotent',true)
    into existing from public.loyalty_manual_adjustment_key k
    where k.idempotency_key=btrim(p_idempotency_key);
  if existing is not null then
    select * into l from public.loyalty_ledger where ledger_id=existing->>'ledger_id';
    if not found then raise sqlstate 'PT409' using message='IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('ledger_id',l.ledger_id,'user_id',l.user_id,
      'balance_milli',l.balance_after_milli_points,'idempotent',true);
  end if;

  perform public.velura_ensure_loyalty_account(p_user_id);
  select * into a from public.loyalty_account where user_id=p_user_id for update;
  milli:=p_points::bigint*1000;

  if milli>0 then
    update public.loyalty_account set balance_milli_points=balance_milli_points+milli,updated_at=now()
      where user_id=p_user_id returning * into a;
    insert into public.loyalty_ledger(user_id,return_id,kind,amount_milli_points,balance_after_milli_points,
      expires_at,note) values(p_user_id,p_return_id,'adjustment',milli,a.balance_milli_points,
      now()+interval '6 months','Điều chỉnh thủ công: '||btrim(p_reason)) returning * into l;
    -- The credit needs a lot of its own, otherwise the expiry job cannot see it and it never ages out.
    insert into public.loyalty_point_lot(user_id,ledger_id,earned_milli,remaining_milli,expires_at,source)
      values(p_user_id,l.ledger_id,milli,milli,now()+interval '6 months','restore');
  else
    taken:=least(a.balance_milli_points,-milli);
    short:=-milli-taken;
    update public.loyalty_account set balance_milli_points=balance_milli_points-taken,
      debt_milli_points=debt_milli_points+short,
      warning_flags=least(2,warning_flags+case when short>0 then 1 else 0 end),updated_at=now()
      where user_id=p_user_id returning * into a;
    insert into public.loyalty_ledger(user_id,return_id,kind,amount_milli_points,balance_after_milli_points,
      debt_delta_milli_points,note) values(p_user_id,p_return_id,'adjustment',milli,a.balance_milli_points,
      short,'Điều chỉnh thủ công: '||btrim(p_reason)) returning * into l;
    perform public.velura_consume_loyalty_lots_tolerant(p_user_id,taken,l.ledger_id);
  end if;

  insert into public.loyalty_manual_adjustment_key(idempotency_key,user_id,ledger_id)
    values(btrim(p_idempotency_key),p_user_id,l.ledger_id);
  perform public.velura_append_module_audit('loyalty',v_actor,v_role,'update',null,
    to_jsonb(a),jsonb_build_object('points',p_points,'ledger_id',l.ledger_id,'reason',btrim(p_reason),
      'return_id',p_return_id,'target_user',p_user_id),p_ip_address);
  return jsonb_build_object('ledger_id',l.ledger_id,'user_id',p_user_id,
    'balance_milli',a.balance_milli_points,'debt_milli',a.debt_milli_points,'idempotent',false);
end; $$;
revoke all on function public.admin_adjust_member_points(uuid,integer,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_adjust_member_points(uuid,integer,text,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
commit;
