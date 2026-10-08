-- KAN-32: rewards are committed with commerce, never granted by a browser callback.
-- PO gates: FIFO/calendar-month expiry and retained-goods proportional money are
-- conservative baselines, NOT approved policy. Spending stays disabled until approved.
create table public.loyalty_policy (
  singleton boolean primary key default true check(singleton),
  spending_enabled boolean not null default false,
  expiry_spending_policy text not null default 'fifo_calendar_months_utc' check(expiry_spending_policy = 'fifo_calendar_months_utc'),
  retained_money_policy text not null default 'proportional_numeric_12' check(retained_money_policy = 'proportional_numeric_12'),
  policy_approved_at timestamptz,
  used_reward_reversal_policy text not null default 'manual_review' check(used_reward_reversal_policy = 'manual_review'),
  used_reward_reversal_approved boolean not null default true
);
insert into public.loyalty_policy(singleton) values(true);
create table public.loyalty_wallet (
  member_id uuid primary key references public.users(user_id),
  referral_code text not null unique default ('VLR' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,16))),
  balance numeric(24,12) not null default 0,
  updated_at timestamptz not null default now()
);
create table public.loyalty_event_outbox (
  event_id uuid primary key default gen_random_uuid(), event_key text not null unique,
  event_type text not null, member_id uuid not null references public.users(user_id),
  order_id uuid references public.orders(order_id), payload jsonb not null,
  occurred_at timestamptz not null default now()
);
create trigger loyalty_analytics_capture after insert on public.loyalty_event_outbox
  for each row execute function analytics.capture_source_event('event_id');
create table public.loyalty_ledger (
  entry_id uuid primary key default gen_random_uuid(), member_id uuid not null references public.loyalty_wallet(member_id),
  event_key text not null unique, kind text not null,
  points numeric(24,12) not null, order_id uuid references public.orders(order_id),
  expires_at timestamptz, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create index loyalty_ledger_member_history on public.loyalty_ledger(member_id,created_at desc,entry_id);
create table public.loyalty_earn_lot (
  lot_id uuid primary key default gen_random_uuid(), member_id uuid not null references public.loyalty_wallet(member_id),
  order_id uuid not null unique references public.orders(order_id),
  earned_points numeric(24,12) not null check(earned_points >= 0),
  reversed_points numeric(24,12) not null default 0,
  remaining_points numeric(24,12) not null check(remaining_points >= 0),
  expires_at timestamptz not null, expired_at timestamptz, created_at timestamptz not null default now()
);
create index loyalty_lot_expiry on public.loyalty_earn_lot(member_id,expires_at,lot_id);
create table public.loyalty_order_award (
  order_id uuid primary key references public.orders(order_id), member_id uuid not null references public.loyalty_wallet(member_id),
  original_paid_merchandise numeric(24,12) not null,
  earned_points numeric(24,12) not null, reversed_points numeric(24,12) not null default 0,
  retained_merchandise numeric(24,12) not null, created_at timestamptz not null default now()
);
create table public.loyalty_reservation (
  order_id uuid primary key references public.orders(order_id), member_id uuid not null references public.loyalty_wallet(member_id),
  points integer not null check(points > 0), state text not null check(state in ('reserved','consumed','released')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.loyalty_reservation_lot (
  order_id uuid not null references public.loyalty_reservation(order_id), lot_id uuid not null references public.loyalty_earn_lot(lot_id),
  points numeric(24,12) not null check(points > 0), primary key(order_id,lot_id)
);
create table public.referral_attribution (
  attribution_id uuid primary key default gen_random_uuid(), referred_member_id uuid not null unique references public.users(user_id),
  referrer_member_id uuid not null references public.users(user_id),
  referral_code text not null, state text not null default 'pending' check(state in ('pending','qualified','reversed')),
  anchor_order_id uuid unique references public.orders(order_id), created_at timestamptz not null default now(),
  qualified_at timestamptz, reversed_at timestamptz, check(referred_member_id <> referrer_member_id)
);
create table public.reward_voucher (
  voucher_id uuid primary key references public.voucher(voucher_id), member_id uuid not null references public.users(user_id),
  attribution_id uuid not null references public.referral_attribution(attribution_id),
  reward_kind text not null check(reward_kind in ('referred_registration','referrer_delivery')),
  state text not null default 'issued' check(state in ('issued','used','revoked')),
  used_order_id uuid unique references public.orders(order_id), issued_at timestamptz not null default now(), revoked_at timestamptz,
  unique(attribution_id,reward_kind)
);
create table public.reward_voucher_history (
  history_id uuid primary key default gen_random_uuid(), voucher_id uuid not null references public.reward_voucher(voucher_id),
  event_key text not null unique, action text not null, order_id uuid references public.orders(order_id),
  metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create table public.loyalty_policy_review (
  review_id uuid primary key default gen_random_uuid(), attribution_id uuid not null references public.referral_attribution(attribution_id),
  voucher_id uuid not null references public.reward_voucher(voucher_id), reason text not null,
  state text not null default 'open' check(state in ('open','resolved')),
  resolution jsonb, created_at timestamptz not null default now(), unique(attribution_id,voucher_id,reason)
);
alter table public.voucher add column reward_member_id uuid references public.users(user_id);
alter table public.orders add column points_spent integer not null default 0 check(points_spent >= 0),
  add column points_discount_amount numeric(12,0) not null default 0;

-- Ledger and issuance history are append-only, including service-role table writes.
create function public.velura_loyalty_append_only() returns trigger language plpgsql as $$
begin raise sqlstate 'PT403' using message='LOYALTY_HISTORY_IMMUTABLE'; end; $$;
create trigger loyalty_ledger_immutable before update or delete on public.loyalty_ledger for each row execute function public.velura_loyalty_append_only();
create trigger reward_history_immutable before update or delete on public.reward_voucher_history for each row execute function public.velura_loyalty_append_only();
create trigger referral_identity_immutable before delete on public.referral_attribution for each row execute function public.velura_loyalty_append_only();
create function public.velura_referral_identity_guard() returns trigger language plpgsql as $$
begin
  if new.referred_member_id <> old.referred_member_id or new.referrer_member_id <> old.referrer_member_id
    or new.referral_code <> old.referral_code or new.attribution_id <> old.attribution_id then
    raise sqlstate 'PT403' using message='REFERRAL_ATTRIBUTION_IMMUTABLE';
  end if;
  return new;
end; $$;
create trigger referral_identity_guard before update on public.referral_attribution for each row execute function public.velura_referral_identity_guard();

create function public.velura_loyalty_require_member(p_actor_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
begin
  if p_actor_id is null or not exists(select 1 from public.users where user_id=p_actor_id and role::text='member' and is_active) then
    raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED';
  end if;
  if auth.role() <> 'service_role' and public.velura_current_user_id() is distinct from p_actor_id then
    raise sqlstate 'PT403' using message='LOYALTY_ACTOR_MISMATCH';
  end if;
  insert into public.loyalty_wallet(member_id) values(p_actor_id) on conflict(member_id) do nothing;
end; $$;

create function public.velura_loyalty_post(p_member_id uuid,p_key text,p_kind text,p_points numeric,p_order_id uuid default null,p_expiry timestamptz default null,p_metadata jsonb default '{}')
returns boolean language plpgsql security definer set search_path=pg_catalog,public,auth as $$
begin
  insert into public.loyalty_ledger(member_id,event_key,kind,points,order_id,expires_at,metadata)
    values(p_member_id,p_key,p_kind,p_points,p_order_id,p_expiry,p_metadata) on conflict(event_key) do nothing;
  if not found then return false; end if;
  update public.loyalty_wallet set balance=balance+p_points,updated_at=now() where member_id=p_member_id;
  insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
    values(p_key,'loyalty.'||p_kind,p_member_id,p_order_id,
      jsonb_build_object('points',p_points,'value_vnd',p_points*1000,'kind',p_kind)||p_metadata);
  return true;
end; $$;

create function public.velura_loyalty_expire(p_member_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_lot public.loyalty_earn_lot%rowtype;
begin
  perform 1 from public.loyalty_wallet where member_id=p_member_id for update;
  for v_lot in select * from public.loyalty_earn_lot where member_id=p_member_id and expires_at<=now() and expired_at is null order by expires_at,lot_id for update loop
    perform public.velura_loyalty_post(p_member_id,'expire:'||v_lot.lot_id,'expired',-v_lot.remaining_points,v_lot.order_id,null,
      jsonb_build_object('lot_id',v_lot.lot_id));
    update public.loyalty_earn_lot set remaining_points=0,expired_at=now() where lot_id=v_lot.lot_id;
  end loop;
end; $$;

create function public.velura_loyalty_quote(p_actor_id uuid,p_subtotal numeric,p_shipping numeric,p_discount numeric,p_points integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_balance numeric; v_live numeric; v_max integer; v_policy public.loyalty_policy%rowtype;
begin
  if p_points<0 or p_points is null or p_subtotal<0 or p_shipping<0 or p_discount<0 then raise sqlstate 'PT422' using message='INVALID_POINTS'; end if;
  select * into v_policy from public.loyalty_policy;
  if p_actor_id is null then
    if p_points>0 then raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED'; end if;
    return jsonb_build_object('available_points',0,'max_points',0,'points_spent',0,'points_discount_amount',0,'policy_approved',v_policy.policy_approved_at is not null,'spending_enabled',false);
  end if;
  perform public.velura_loyalty_require_member(p_actor_id);
  perform public.velura_loyalty_expire(p_actor_id);
  select balance into v_balance from public.loyalty_wallet where member_id=p_actor_id;
  select coalesce(sum(remaining_points),0) into v_live from public.loyalty_earn_lot where member_id=p_actor_id and expires_at>now();
  v_max:=greatest(0,floor(least(v_balance,v_live,greatest(0,p_subtotal-p_discount)/2000)))::integer;
  if p_points>0 and (not v_policy.spending_enabled or v_policy.policy_approved_at is null) then raise sqlstate 'PT409' using message='LOYALTY_POLICY_APPROVAL_REQUIRED'; end if;
  if p_points>v_max then raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
  return jsonb_build_object('available_points',greatest(0,floor(least(v_balance,v_live))),'balance_points',v_balance,
    'max_points',v_max,'points_spent',p_points,'points_discount_amount',p_points*1000,
    'policy_approved',v_policy.policy_approved_at is not null,'spending_enabled',v_policy.spending_enabled and v_policy.policy_approved_at is not null);
end; $$;

-- Private implementation keeps the established stock/voucher transaction unchanged.
alter function public.velura_create_checkout_order(jsonb) rename to velura_create_checkout_order_commerce;
revoke all on function public.velura_create_checkout_order_commerce(jsonb) from public,anon,authenticated,service_role;
create function public.velura_create_checkout_order(p_input jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_actor uuid:=nullif(p_input->>'actorId','')::uuid; v_user uuid:=(p_input->>'userId')::uuid;
  v_points integer:=coalesce((p_input->>'pointsSpent')::integer,0); v_result jsonb; v_quote jsonb; v_order uuid;
  v_existing public.orders%rowtype; v_lot public.loyalty_earn_lot%rowtype; v_left numeric; v_take numeric;
  v_reward public.reward_voucher%rowtype; v_voucher public.voucher%rowtype; v_base numeric; v_merchandise_discount numeric;
begin
  if auth.role() <> 'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if v_actor is not null then
    perform public.velura_loyalty_require_member(v_actor);
    if v_actor<>v_user or coalesce((p_input->>'isGuest')::boolean,false) then raise sqlstate 'PT403' using message='LOYALTY_ACTOR_MISMATCH'; end if;
  elsif v_points<>0 then raise sqlstate 'PT403' using message='LOYALTY_MEMBER_REQUIRED'; end if;
  if nullif(p_input->>'idempotencyKey','') is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||left(p_input->>'idempotencyKey',128),0));
    select * into v_existing from public.orders where user_id=v_user and checkout_request_key=left(p_input->>'idempotencyKey',128);
    if found then return jsonb_build_object('order',to_jsonb(v_existing),'items',(select coalesce(jsonb_agg(to_jsonb(oi)),'[]') from public.order_item oi where order_id=v_existing.order_id)); end if;
  end if;
  v_merchandise_discount:=case when exists(select 1 from public.voucher where voucher_id=nullif(p_input->>'voucherId','')::uuid and discount_type::text='free_shipping') then 0 else (p_input->>'discountAmount')::numeric end;
  v_quote:=public.velura_loyalty_quote(v_actor,(p_input->>'subtotal')::numeric,(p_input->>'shippingFee')::numeric,v_merchandise_discount,v_points);
  select * into v_reward from public.reward_voucher where voucher_id=nullif(p_input->>'voucherId','')::uuid for update;
  if found then
    select * into v_voucher from public.voucher where voucher_id=v_reward.voucher_id for update;
    if v_actor is null or v_reward.member_id<>v_actor or v_reward.state<>'issued' or not v_voucher.is_active
      or now()<v_voucher.start_date or now()>=v_voucher.end_date or (p_input->>'subtotal')::numeric<1000000
      or (p_input->>'discountAmount')::numeric<>least(500000,round((p_input->>'subtotal')::numeric*0.2)) then
      raise sqlstate 'PT409' using message='REWARD_VOUCHER_CHANGED';
    end if;
  end if;
  v_base:=greatest(0,(p_input->>'subtotal')::numeric+(p_input->>'shippingFee')::numeric-(p_input->>'discountAmount')::numeric);
  if (p_input->>'totalAmount')::numeric<>v_base-v_points*1000 then raise sqlstate 'PT422' using message='ORDER_TOTAL_MISMATCH'; end if;
  v_result:=public.velura_create_checkout_order_commerce(jsonb_set(p_input,'{totalAmount}',to_jsonb(v_base)));
  v_order:=(v_result#>>'{order,order_id}')::uuid;
  update public.orders set points_spent=v_points,points_discount_amount=v_points*1000,total_amount=v_base-v_points*1000 where order_id=v_order;
  if v_points>0 then
    insert into public.loyalty_reservation(order_id,member_id,points,state) values(v_order,v_actor,v_points,
      case when p_input->>'paymentMethod'='COD' then 'consumed' else 'reserved' end);
    v_left:=v_points;
    for v_lot in select * from public.loyalty_earn_lot where member_id=v_actor and expires_at>now() and remaining_points>0 order by expires_at,lot_id for update loop
      v_take:=least(v_left,v_lot.remaining_points);
      insert into public.loyalty_reservation_lot(order_id,lot_id,points) values(v_order,v_lot.lot_id,v_take);
      update public.loyalty_earn_lot set remaining_points=remaining_points-v_take where lot_id=v_lot.lot_id;
      v_left:=v_left-v_take; exit when v_left=0;
    end loop;
    if v_left<>0 then raise sqlstate 'PT409' using message='POINTS_CHANGED'; end if;
    perform public.velura_loyalty_post(v_actor,'reserve:'||v_order,'reserved',-v_points,v_order);
    if p_input->>'paymentMethod'='COD' then perform public.velura_loyalty_post(v_actor,'consume:'||v_order,'consumed',0,v_order); end if;
  end if;
  if v_reward.voucher_id is not null then
    update public.reward_voucher set state='used',used_order_id=v_order where voucher_id=v_reward.voucher_id;
    insert into public.reward_voucher_history(voucher_id,event_key,action,order_id) values(v_reward.voucher_id,'reward-use:'||v_order,'used',v_order);
    insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
      values('reward-use:'||v_order,'reward.used',v_actor,v_order,jsonb_build_object('voucher_id',v_reward.voucher_id,'value_vnd',(p_input->>'discountAmount')::numeric));
  end if;
  return jsonb_set(v_result,'{order}',(select to_jsonb(o) from public.orders o where order_id=v_order));
end; $$;

create function public.velura_issue_referral_voucher(p_attribution_id uuid,p_member_id uuid,p_kind text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_id uuid; v_code text;
begin
  select voucher_id into v_id from public.reward_voucher where attribution_id=p_attribution_id and reward_kind=p_kind;
  if found then return v_id; end if;
  v_code:='REF'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,24));
  insert into public.voucher(code,name,discount_type,discount_value,max_discount_amount,min_order_value,usage_limit_total,
    usage_limit_per_user,applicable_user_group,start_date,end_date,is_active,created_by,reward_member_id)
    values(v_code,'Ưu đãi giới thiệu thành viên','percentage',20,500000,1000000,1,1,'all_users',now(),now()+interval '60 days',true,p_member_id,p_member_id) returning voucher_id into v_id;
  insert into public.reward_voucher(voucher_id,member_id,attribution_id,reward_kind) values(v_id,p_member_id,p_attribution_id,p_kind);
  insert into public.reward_voucher_history(voucher_id,event_key,action,metadata)
    values(v_id,'reward-issue:'||v_id,'issued',jsonb_build_object('attribution_id',p_attribution_id,'reward_kind',p_kind));
  insert into public.loyalty_event_outbox(event_key,event_type,member_id,payload)
    values('reward-issue:'||v_id,'reward.issued',p_member_id,jsonb_build_object('voucher_id',v_id,'attribution_id',p_attribution_id,'reward_kind',p_kind));
  return v_id;
end; $$;

-- Signup + optional referral succeeds or rolls back as one transaction.
create function public.velura_register_member(p_input jsonb,p_referral_code text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_user public.users%rowtype; v_referrer public.users%rowtype; v_attr uuid; v_code text:=upper(nullif(btrim(p_referral_code),''));
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  if v_code is not null then
    select u.* into v_referrer from public.loyalty_wallet w join public.users u on u.user_id=w.member_id
      where w.referral_code=v_code and u.role::text='member' and u.is_active;
    if not found then raise sqlstate 'PT422' using message='INVALID_REFERRAL_CODE'; end if;
    if (nullif(lower(p_input->>'email'),'') is not null and lower(v_referrer.email)=lower(p_input->>'email'))
      or (nullif(p_input->>'phone','') is not null and v_referrer.phone=p_input->>'phone') then
      raise sqlstate 'PT422' using message='SELF_REFERRAL_FORBIDDEN'; end if;
  end if;
  insert into public.users(email,phone,password_hash,full_name,is_active,otp_code,otp_expires_at,role)
    values(nullif(p_input->>'email',''),nullif(p_input->>'phone',''),p_input->>'password_hash',p_input->>'full_name',false,
      p_input->>'otp_code',(p_input->>'otp_expires_at')::timestamp,'member') returning * into v_user;
  insert into public.loyalty_wallet(member_id) values(v_user.user_id);
  if v_code is not null then
    insert into public.referral_attribution(referred_member_id,referrer_member_id,referral_code)
      values(v_user.user_id,v_referrer.user_id,v_code) returning attribution_id into v_attr;
    perform public.velura_issue_referral_voucher(v_attr,v_user.user_id,'referred_registration');
    insert into public.loyalty_event_outbox(event_key,event_type,member_id,payload)
      values('referral-attribution:'||v_attr,'referral.attributed',v_user.user_id,jsonb_build_object('attribution_id',v_attr));
  end if;
  return to_jsonb(v_user);
end; $$;

create function public.velura_loyalty_release(p_order_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_res public.loyalty_reservation%rowtype; v_alloc record; v_restore numeric:=0; v_take numeric; v_reward public.reward_voucher%rowtype;
begin
  select * into v_res from public.loyalty_reservation where order_id=p_order_id for update;
  if found and v_res.state<>'released' then
    perform 1 from public.loyalty_wallet where member_id=v_res.member_id for update;
    for v_alloc in select a.points,l.* from public.loyalty_reservation_lot a join public.loyalty_earn_lot l using(lot_id)
      where a.order_id=p_order_id order by l.expires_at,l.lot_id for update of l loop
      if v_alloc.expires_at>now() then
        v_restore:=v_restore+v_alloc.points;
        -- Reversed earning becomes debt; releasing redemption still offsets that debt.
        v_take:=least(v_alloc.points,greatest(0,v_alloc.earned_points-v_alloc.reversed_points-v_alloc.remaining_points));
        update public.loyalty_earn_lot set remaining_points=remaining_points+v_take where lot_id=v_alloc.lot_id;
      end if;
    end loop;
    update public.loyalty_reservation set state='released',updated_at=now() where order_id=p_order_id;
    perform public.velura_loyalty_post(v_res.member_id,'release:'||p_order_id,'released',v_restore,p_order_id,null,
      jsonb_build_object('expired_reserved_points',v_res.points-v_restore));
  end if;
  select * into v_reward from public.reward_voucher where used_order_id=p_order_id for update;
  if found and v_reward.state='used' then
    if exists(select 1 from public.referral_attribution where attribution_id=v_reward.attribution_id and state='reversed') then
      update public.reward_voucher set state='revoked',revoked_at=now() where voucher_id=v_reward.voucher_id;
      update public.voucher set is_active=false where voucher_id=v_reward.voucher_id;
    else
      update public.reward_voucher set state='issued',used_order_id=null where voucher_id=v_reward.voucher_id;
    end if;
    insert into public.reward_voucher_history(voucher_id,event_key,action,order_id)
      values(v_reward.voucher_id,'reward-release:'||p_order_id,'checkout_released',p_order_id) on conflict(event_key) do nothing;
  end if;
end; $$;

-- Captured money, not order totals alone, anchors the delivered award. Exchanges
-- retain original paid goods; their zero-total replacement orders earn nothing.
create function public.velura_loyalty_reconcile_order(p_order_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_order public.orders%rowtype; v_paid numeric; v_goods numeric; v_retained numeric; v_points numeric;
  v_award public.loyalty_order_award%rowtype; v_delta numeric; v_expiry timestamptz; v_balance numeric;
  v_lot public.loyalty_earn_lot%rowtype; v_attr public.referral_attribution%rowtype; v_reward public.reward_voucher%rowtype;
begin
  select * into v_order from public.orders where order_id=p_order_id for update;
  if not found then return; end if;
  if v_order.status::text='cancelled' then perform public.velura_loyalty_release(p_order_id); return; end if;
  if v_order.is_guest is distinct from false or v_order.status::text<>'delivered'
    or not exists(select 1 from public.users where user_id=v_order.user_id and role::text='member' and is_active) then return; end if;
  insert into public.loyalty_wallet(member_id) values(v_order.user_id) on conflict(member_id) do nothing;
  perform 1 from public.loyalty_wallet where member_id=v_order.user_id for update;
  perform public.velura_loyalty_expire(v_order.user_id);
  select coalesce(sum(amount),0) into v_paid from public.payment where order_id=p_order_id
    and payment_status::text in ('paid','refund_pending','refunded');
  -- Shipping is excluded even when payment capture exceeds the order total.
  v_goods:=greatest(0,least(v_order.total_amount,v_paid)-greatest(0,v_order.shipping_fee-
    case when exists(select 1 from public.voucher where voucher_id=v_order.voucher_id and discount_type::text='free_shipping') then v_order.discount_amount else 0 end));
  if v_goods<=0 then return; end if;
  select coalesce(sum(oi.unit_price*greatest(0,oi.quantity-coalesce(r.quantity,0))),0) into v_retained
    from public.order_item oi left join lateral (
      select sum(ri.quantity) as quantity from public.return_item ri join public.return_exchange re using(return_id)
      where ri.order_item_id=oi.item_id and re.return_type::text='refund' and re.status::text in ('REFUNDED','COMPLETED')
    ) r on true where oi.order_id=p_order_id;
  v_retained:=least(v_order.subtotal,v_retained);
  select * into v_award from public.loyalty_order_award where order_id=p_order_id for update;
  if not found then
    v_points:=v_goods/20000;
    v_expiry:=(coalesce(v_order.delivered_at,now() at time zone 'UTC') at time zone 'UTC')+interval '6 months';
    insert into public.loyalty_order_award(order_id,member_id,original_paid_merchandise,earned_points,retained_merchandise)
      values(p_order_id,v_order.user_id,v_goods,v_points,v_order.subtotal) returning * into v_award;
    perform public.velura_loyalty_post(v_order.user_id,'earn:'||p_order_id,'earned',v_points,p_order_id,v_expiry);
    select balance into v_balance from public.loyalty_wallet where member_id=v_order.user_id;
    insert into public.loyalty_earn_lot(member_id,order_id,earned_points,remaining_points,expires_at)
      values(v_order.user_id,p_order_id,v_points,least(v_points,greatest(0,v_balance)),v_expiry);
  end if;
  v_points:=round(case when v_order.subtotal>0 then v_award.earned_points*v_retained/v_order.subtotal else 0 end,12);
  v_delta:=greatest(0,v_award.earned_points-v_points-v_award.reversed_points);
  if v_delta>0 then
    select * into v_lot from public.loyalty_earn_lot where order_id=p_order_id for update;
    -- Previously expired, unspent points must not be removed twice.
    if v_lot.expired_at is not null then
      v_delta:=least(v_delta,greatest(0,v_lot.earned_points-v_lot.reversed_points-
        coalesce((select -points from public.loyalty_ledger where event_key='expire:'||v_lot.lot_id),0)));
    end if;
    perform public.velura_loyalty_post(v_order.user_id,'reverse:'||p_order_id||':'||v_retained,'reversed',-v_delta,p_order_id,null,
      jsonb_build_object('retained_merchandise',v_retained));
    update public.loyalty_order_award set reversed_points=earned_points-v_points,retained_merchandise=v_retained where order_id=p_order_id;
    update public.loyalty_earn_lot set remaining_points=greatest(0,remaining_points-v_delta),
      reversed_points=earned_points-v_points where order_id=p_order_id;
  end if;
  select * into v_attr from public.referral_attribution where referred_member_id=v_order.user_id for update;
  if not found then return; end if;
  if v_attr.state='pending' and v_retained>0 then
    update public.referral_attribution set state='qualified',anchor_order_id=p_order_id,qualified_at=now()
      where attribution_id=v_attr.attribution_id;
    perform public.velura_issue_referral_voucher(v_attr.attribution_id,v_attr.referrer_member_id,'referrer_delivery');
    insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
      values('referral-qualified:'||v_attr.attribution_id,'referral.qualified',v_attr.referrer_member_id,p_order_id,jsonb_build_object('attribution_id',v_attr.attribution_id));
  elsif v_attr.state='qualified' and v_attr.anchor_order_id=p_order_id and v_retained=0 then
    update public.referral_attribution set state='reversed',reversed_at=now() where attribution_id=v_attr.attribution_id;
    for v_reward in select * from public.reward_voucher where attribution_id=v_attr.attribution_id
      and reward_kind='referrer_delivery' order by voucher_id for update loop
      if v_reward.state='issued' then
        update public.reward_voucher set state='revoked',revoked_at=now() where voucher_id=v_reward.voucher_id;
        update public.voucher set is_active=false where voucher_id=v_reward.voucher_id;
        insert into public.reward_voucher_history(voucher_id,event_key,action,order_id)
          values(v_reward.voucher_id,'reward-revoke:'||v_reward.voucher_id,'revoked',p_order_id);
        insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
          values('reward-revoke:'||v_reward.voucher_id,'reward.revoked',v_reward.member_id,p_order_id,jsonb_build_object('voucher_id',v_reward.voucher_id));
      elsif v_reward.state='used' then
        insert into public.loyalty_policy_review(attribution_id,voucher_id,reason)
          values(v_attr.attribution_id,v_reward.voucher_id,'USED_REWARD_VOUCHER_REVERSAL_OPEN') on conflict do nothing;
        insert into public.reward_voucher_history(voucher_id,event_key,action,order_id)
          values(v_reward.voucher_id,'reward-review:'||v_reward.voucher_id,'reversal_policy_review',p_order_id) on conflict do nothing;
        insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
          values('reward-review:'||v_reward.voucher_id,'reward.reversal_review',v_reward.member_id,p_order_id,jsonb_build_object('voucher_id',v_reward.voucher_id)) on conflict do nothing;
      end if;
    end loop;
    insert into public.loyalty_event_outbox(event_key,event_type,member_id,order_id,payload)
      values('referral-reversed:'||v_attr.attribution_id,'referral.reversed',v_attr.referrer_member_id,p_order_id,jsonb_build_object('attribution_id',v_attr.attribution_id));
  end if;
end; $$;

create function public.velura_loyalty_commerce_trigger() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_order_id uuid; v_res public.loyalty_reservation%rowtype;
begin
  v_order_id:=new.order_id;
  if tg_table_name='payment' and to_jsonb(new)->>'payment_status'='failed' then
    -- Failed points-bearing checkout is closed; retry must quote/reserve again.
    if exists(select 1 from public.loyalty_reservation where order_id=v_order_id and state='reserved')
      and exists(select 1 from public.orders where order_id=v_order_id and status::text='waiting_payment')
      and not exists(select 1 from public.payment where order_id=v_order_id and payment_status::text in ('paid','refund_pending','refunded'))
      and not exists(select 1 from public.payment where order_id=v_order_id and payment_status::text='pending') then
      perform public.velura_order_apply_action(v_order_id,'customer_cancel','customer',
        (select user_id from public.orders where order_id=v_order_id),'member','Payment failed; rewards released',
        jsonb_build_object('cancel_reason','Payment failed; rewards released'),null,null);
    end if;
  end if;
  if tg_table_name='payment' and to_jsonb(new)->>'payment_status'='paid' then
    select * into v_res from public.loyalty_reservation where order_id=v_order_id and state='reserved' for update;
    if found then
      update public.loyalty_reservation set state='consumed',updated_at=now() where order_id=v_order_id;
      perform public.velura_loyalty_post(v_res.member_id,'consume:'||v_order_id,'consumed',0,v_order_id);
    end if;
  end if;
  perform public.velura_loyalty_reconcile_order(v_order_id);
  return new;
end; $$;
create trigger loyalty_order_transaction after update of status on public.orders for each row execute function public.velura_loyalty_commerce_trigger();
create trigger loyalty_payment_transaction after insert or update of payment_status on public.payment for each row execute function public.velura_loyalty_commerce_trigger();
create trigger loyalty_return_transaction after update of status on public.return_exchange for each row execute function public.velura_loyalty_commerce_trigger();

create function public.velura_loyalty_snapshot(p_actor_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_wallet public.loyalty_wallet%rowtype; v_policy public.loyalty_policy%rowtype;
begin
  perform public.velura_loyalty_require_member(p_actor_id);
  perform public.velura_loyalty_expire(p_actor_id);
  select * into v_wallet from public.loyalty_wallet where member_id=p_actor_id;
  select * into v_policy from public.loyalty_policy;
  return jsonb_build_object('member_id',p_actor_id,'referral_code',v_wallet.referral_code,'balance_points',v_wallet.balance,
    'available_points',greatest(0,floor(least(v_wallet.balance,(select coalesce(sum(remaining_points),0) from public.loyalty_earn_lot where member_id=p_actor_id and expires_at>now())))),
    'amount_vnd',v_wallet.balance*1000,'policy',to_jsonb(v_policy),
    'expiries',(select coalesce(jsonb_agg(jsonb_build_object('points',remaining_points,'expires_at',expires_at) order by expires_at),'[]') from public.loyalty_earn_lot where member_id=p_actor_id and remaining_points>0 and expires_at>now()),
    'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.entry_id desc),'[]') from (select * from public.loyalty_ledger where member_id=p_actor_id and (p_before is null or (created_at,entry_id)<(select created_at,entry_id from public.loyalty_ledger where entry_id=p_before and member_id=p_actor_id)) order by created_at desc,entry_id desc limit 50) h),
    'referrals',(select coalesce(jsonb_agg(jsonb_build_object('attribution_id',attribution_id,'state',state,'anchor_order_id',anchor_order_id,'created_at',created_at)),'[]') from public.referral_attribution where referrer_member_id=p_actor_id or referred_member_id=p_actor_id),
    'reward_vouchers',(select coalesce(jsonb_agg(jsonb_build_object('voucher_id',r.voucher_id,'code',v.code,'state',r.state,'reward_kind',r.reward_kind,'expires_at',v.end_date,'used_order_id',r.used_order_id,'history',(select coalesce(jsonb_agg(to_jsonb(h) order by created_at),'[]') from public.reward_voucher_history h where h.voucher_id=r.voucher_id))),'[]') from public.reward_voucher r join public.voucher v using(voucher_id) where r.member_id=p_actor_id));
end; $$;

-- No browser can mutate rewards, call event handlers, or choose another actor.
do $$ declare v_table text; v_function record; begin
  foreach v_table in array array['loyalty_policy','loyalty_wallet','loyalty_event_outbox','loyalty_ledger','loyalty_earn_lot','loyalty_order_award','loyalty_reservation','loyalty_reservation_lot','referral_attribution','reward_voucher','reward_voucher_history','loyalty_policy_review'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated',v_table);
    execute format('grant all on public.%I to service_role',v_table);
  end loop;
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'velura_loyalty_%' or p.proname in ('velura_register_member','velura_issue_referral_voucher','velura_referral_identity_guard','velura_create_checkout_order')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
  end loop;
end; $$;
grant execute on function public.velura_register_member(jsonb,text), public.velura_create_checkout_order(jsonb),
  public.velura_loyalty_snapshot(uuid,uuid), public.velura_loyalty_quote(uuid,numeric,numeric,numeric,integer) to service_role;

-- Failure opening a provider session closes the discounted order before releasing its points.
create function public.velura_close_failed_loyalty_checkout(p_order_id uuid,p_actor_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,auth as $$
declare v_order public.orders%rowtype;
begin
  if auth.role()<>'service_role' then raise sqlstate 'PT403' using message='LOYALTY_SERVER_ONLY'; end if;
  perform public.velura_loyalty_require_member(p_actor_id);
  select * into v_order from public.orders where order_id=p_order_id and user_id=p_actor_id for update;
  if not found then raise sqlstate 'PT404' using message='ORDER_NOT_FOUND'; end if;
  if v_order.status::text='cancelled' then return; end if;
  if v_order.status::text<>'waiting_payment' or exists(select 1 from public.payment where order_id=p_order_id and payment_status::text in ('paid','refund_pending','refunded')) then
    raise sqlstate 'PT409' using message='PAYMENT_ALREADY_PAID'; end if;
  perform public.velura_order_apply_action(p_order_id,'customer_cancel','customer',p_actor_id,'member',
    'Provider session failed; rewards released',jsonb_build_object('cancel_reason','Provider session failed; rewards released'),null,null);
end; $$;
revoke all on function public.velura_close_failed_loyalty_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.velura_close_failed_loyalty_checkout(uuid,uuid) to service_role;

-- Retain the established floor-per-line refund rule, now subtracting points paid
-- instead of refunding a points-funded discount as captured cash.
create or replace function public.velura_return_refundable_amount(p_return_id uuid)
returns numeric language sql stable security invoker set search_path=pg_catalog,public,auth as $$
  select coalesce((select amount from public.payment_refund where return_id=p_return_id),
    (select greatest(0,least(
      coalesce(sum(floor(oi.unit_price*ri.quantity*case when o.subtotal>0 then
        greatest(0,o.subtotal-case when v.discount_type::text='free_shipping' then 0 else o.discount_amount end-o.points_discount_amount)/o.subtotal else 0 end)),0),
      coalesce((select sum(greatest(0,p.amount-p.refunded_amount)) from public.payment p
        where p.order_id=o.order_id and p.payment_status::text in ('paid','refund_pending','refunded')),0)))
    from public.return_exchange r join public.orders o on o.order_id=r.order_id left join public.voucher v on v.voucher_id=o.voucher_id
      join public.return_item ri on ri.return_id=r.return_id join public.order_item oi on oi.item_id=ri.order_item_id
    where r.return_id=p_return_id group by o.order_id),0);
$$;
