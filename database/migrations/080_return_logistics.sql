-- KAN-106: return logistics end-to-end.
-- A return has its own immutable slip code (QR), an inbound shipment created by the shop,
-- carrier pickup evidence, customer packing evidence, warehouse QA evidence, and a linked
-- replacement (sub) order. Loyalty is clawed back only when money is refunded, never on an
-- even exchange.
begin;

-- ---------------------------------------------------------------------------
-- 1. Return slip code and package-level QA facts
-- ---------------------------------------------------------------------------
alter table public.return_exchange
  add column if not exists return_code text,
  add column if not exists package_match boolean,
  add column if not exists seal_intact boolean,
  add column if not exists qa_note text;

update public.return_exchange
set return_code = coalesce(nullif(return_code, ''), 'RET' || upper(substr(replace(return_id::text, '-', ''), 1, 12)))
where return_code is null or return_code = '';

alter table public.return_exchange
  alter column return_code set default ('RET' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  alter column return_code set not null;

-- Warehouse disposition is per returned line. Only `restock` changes sellable stock.
alter table public.return_item
  add column if not exists disposition text,
  add column if not exists disposition_note text,
  add column if not exists restocked_at timestamptz,
  add column if not exists stock_restored_quantity integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'return_item_disposition_check') then
    alter table public.return_item
      add constraint return_item_disposition_check
      check (disposition is null or disposition in ('restock', 'repair', 'scrap', 'return_supplier'));
  end if;
end $$;

create unique index if not exists return_exchange_return_code_key
  on public.return_exchange (return_code);

-- ---------------------------------------------------------------------------
-- 2. Linked replacement order
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists parent_order_id uuid references public.orders(order_id),
  add column if not exists source_return_id uuid references public.return_exchange(return_id),
  add column if not exists order_kind text not null default 'sale';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_order_kind_check') then
    alter table public.orders
      add constraint orders_order_kind_check check (order_kind in ('sale', 'exchange'));
  end if;
end $$;

update public.orders o
set order_kind = 'exchange',
    source_return_id = r.return_id,
    parent_order_id = r.order_id
from public.return_exchange r
where r.exchange_order_id = o.order_id
  and o.order_kind = 'sale';

-- ---------------------------------------------------------------------------
-- 3. Return shipments (inbound: customer -> warehouse, outbound: warehouse -> customer)
-- ---------------------------------------------------------------------------
create table if not exists public.return_shipment (
  shipment_id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.return_exchange(return_id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  order_id uuid references public.orders(order_id) on delete set null,
  carrier text,
  tracking_code text,
  tracking_url text,
  label_url text,
  handover_code text,
  status text not null default 'pending'
    check (status in ('pending', 'label_ready', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled')),
  picked_up_at timestamptz,
  delivered_at timestamptz,
  package_video_url text,
  pickup_photo_urls text[] not null default '{}'::text[],
  package_photo_urls text[] not null default '{}'::text[],
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (return_id, direction)
);

create unique index if not exists return_shipment_tracking_key
  on public.return_shipment (carrier, tracking_code)
  where tracking_code is not null and tracking_code <> '';

create index if not exists return_shipment_return_idx
  on public.return_shipment (return_id, direction);

-- ---------------------------------------------------------------------------
-- 4. Evidence ledger (image/video URLs, immutable per upload, with roles)
-- ---------------------------------------------------------------------------
create table if not exists public.return_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.return_exchange(return_id) on delete cascade,
  shipment_id uuid references public.return_shipment(shipment_id) on delete set null,
  kind text not null check (kind in (
    'request_photo', 'packing_photo', 'packing_video',
    'pickup_photo', 'pickup_video', 'qa_photo', 'qa_video', 'refund_proof', 'other'
  )),
  url text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  uploaded_by_role text not null default 'system'
    check (uploaded_by_role in ('customer', 'carrier', 'admin', 'system')),
  uploaded_by uuid,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists return_evidence_return_idx
  on public.return_evidence (return_id, created_at);

-- One row per restocked return line; the unique key makes a double receipt impossible.
create table if not exists public.return_stock_movement (
  movement_id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.return_exchange(return_id) on delete cascade,
  return_item_id uuid not null references public.return_item(return_item_id) on delete cascade,
  variant_id uuid not null references public.variant(variant_id),
  order_id uuid references public.orders(order_id) on delete set null,
  disposition text not null,
  quantity integer not null check (quantity > 0),
  before_quantity integer not null,
  after_quantity integer not null,
  actor_id uuid,
  note text,
  created_at timestamptz not null default now(),
  unique (return_id, return_item_id)
);

create index if not exists return_stock_movement_variant_idx
  on public.return_stock_movement (variant_id, created_at desc);

-- Preserve the original customer photos in the same immutable ledger used by the new flow.
insert into public.return_evidence(return_id, kind, url, uploaded_by_role, created_at)
select r.return_id, 'request_photo', img, 'customer', r.created_at
from public.return_exchange r
cross join lateral unnest(coalesce(r.evidence_images, '{}'::text[])) as img
where img ~ '^https?://'
  and not exists (
    select 1 from public.return_evidence e
    where e.return_id = r.return_id and e.kind = 'request_photo' and e.url = img
  );

-- ---------------------------------------------------------------------------
-- 5. Return events can describe shipment/custody facts, not only status changes
-- ---------------------------------------------------------------------------
alter table public.return_event
  add column if not exists event_type text not null default 'status',
  add column if not exists payload jsonb not null default '{}'::jsonb;

-- The generic transition trigger from 045 writes one bare row per status change. The RPCs
-- below know more about the same transition (QA receipts, shipment, carrier payload), so they
-- raise `app.return_suppress_transition_event` and insert their own richer row instead.
create or replace function public.velura_log_return_transition()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, auth as $$
begin
  if new.status is distinct from old.status
    and coalesce(current_setting('app.return_suppress_transition_event', true), 'off') <> 'on' then
    insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,note)
      values(new.return_id,old.status::text,new.status::text,auth.uid(),
        coalesce(nullif(current_setting('app.return_actor_type',true),''),'system'),
        coalesce(new.rejection_reason,new.admin_note));
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Workflow guard: receipt requires intact seal and matching package
-- ---------------------------------------------------------------------------
create or replace function public.velura_return_workflow_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_from text; v_to text := new.status::text; v_allowed text[]; v_line record; v_receipt jsonb;
begin
  if tg_op = 'INSERT' then
    if v_to <> 'REQUESTED' then raise sqlstate 'PT422' using message = 'RETURN_INITIAL_STATE_REQUIRED'; end if;
    new.contact_due_at := coalesce(new.contact_due_at, now() + interval '24 hours');
    return new;
  end if;
  v_from := old.status::text;
  if v_from = v_to then return new; end if;
  v_allowed := case v_from
    when 'REQUESTED' then array['CONTACTING','CANCELLED']
    when 'CONTACTING' then array['WAITING_RETURN','CANCELLED','NEEDS_SUPPORT']
    when 'WAITING_RETURN' then array['RETURN_IN_TRANSIT','CANCELLED']
    when 'RETURN_IN_TRANSIT' then array['RECEIVED','NEEDS_SUPPORT']
    when 'RECEIVED' then array['REFUND_PROCESSING','EXCHANGE_PREPARING','NEEDS_SUPPORT']
    when 'REFUND_PROCESSING' then array['REFUNDED','NEEDS_SUPPORT']
    when 'REFUNDED' then array['COMPLETED']
    when 'EXCHANGE_PREPARING' then array['EXCHANGE_SHIPPING','NEEDS_SUPPORT']
    when 'EXCHANGE_SHIPPING' then array['COMPLETED','NEEDS_SUPPORT']
    when 'NEEDS_SUPPORT' then array['CONTACTING','CANCELLED'] else array[]::text[] end;
  if not (v_to = any(v_allowed)) then raise sqlstate 'PT422' using message = 'INVALID_RETURN_TRANSITION'; end if;
  if new.version <> old.version + 1 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_to = 'CANCELLED' then
    if length(btrim(coalesce(new.rejection_reason, ''))) < 3 then raise sqlstate 'PT422' using message = 'CANCEL_REASON_REQUIRED'; end if;
    new.cancelled_by := coalesce(new.cancelled_by,
      case coalesce(nullif(current_setting('app.return_actor_type', true), ''), 'admin') when 'customer' then 'customer' else 'admin' end);
    new.refund_amount := null;
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if v_to = 'RECEIVED' then
    if new.condition_check_result <> 'qa_pass' or coalesce(new.warehouse_proof, '') = ''
      or new.package_match is false or new.seal_intact is false
      or jsonb_typeof(new.qa_item_receipts) is distinct from 'array'
      or jsonb_array_length(new.qa_item_receipts) <> (select count(*) from public.return_item where return_id = new.return_id)
      or exists(
        select 1 from jsonb_array_elements(new.qa_item_receipts) receipt
        where coalesce(receipt->>'disposition', '') not in ('restock', 'repair', 'scrap', 'return_supplier')
      )
    then raise sqlstate 'PT422' using message = 'WAREHOUSE_QA_REQUIRED'; end if;
    for v_line in select * from public.return_item where return_id = new.return_id loop
      select value into v_receipt from jsonb_array_elements(new.qa_item_receipts)
        where value->>'orderItemId' = v_line.order_item_id::text;
      if v_receipt is null or (v_receipt->>'matchesProduct')::boolean is distinct from true
        or (v_receipt->>'receivedQuantity')::numeric <> v_line.quantity then
        raise sqlstate 'PT422' using message = 'WAREHOUSE_LINE_MISMATCH';
      end if;
    end loop;
  end if;
  if v_to = 'REFUND_PROCESSING' and (new.return_type::text <> 'refund'
    or new.condition_check_result <> 'qa_pass'
    or not exists(select 1 from public.payment_refund where return_id = new.return_id)) then
    raise sqlstate 'PT422' using message = 'REFUND_OPERATION_REQUIRED'; end if;
  if v_to = 'REFUNDED' and not exists(select 1 from public.payment_refund where return_id = new.return_id and status = 'succeeded') then
    raise sqlstate 'PT422' using message = 'REFUND_CONFIRMATION_REQUIRED'; end if;
  if v_to = 'EXCHANGE_PREPARING' and (new.return_type::text <> 'exchange' or new.condition_check_result <> 'qa_pass' or new.exchange_order_id is null) then
    raise sqlstate 'PT422' using message = 'EXCHANGE_ORDER_REQUIRED'; end if;
  if v_to = 'RETURN_IN_TRANSIT' and coalesce(new.tracking_return_code, '') = '' then
    raise sqlstate 'PT422' using message = 'TRACKING_REQUIRED'; end if;
  if v_to = 'EXCHANGE_SHIPPING' and coalesce(new.exchange_tracking_code, '') = '' then
    raise sqlstate 'PT422' using message = 'EXCHANGE_TRACKING_REQUIRED'; end if;
  if v_to = 'COMPLETED' and new.return_type::text = 'exchange' and not exists(
    select 1 from public.orders where order_id = new.exchange_order_id and status::text = 'delivered') then
    raise sqlstate 'PT422' using message = 'EXCHANGE_DELIVERY_REQUIRED'; end if;
  return new;
end; $$;

-- Receipt is one transaction: validate every line/disposition, restock only eligible lines,
-- write the stock ledger, then move the return to RECEIVED.
create or replace function public.velura_receive_return(
  p_return_id uuid, p_expected_version integer, p_receipts jsonb,
  p_package_match boolean, p_seal_intact boolean, p_warehouse_proof text,
  p_qa_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_line record; v_receipt jsonb;
  v_disposition text; v_variant public.variant%rowtype; v_variant_id uuid;
  v_before integer; v_after integer; v_note text := nullif(btrim(coalesce(p_qa_note,'')),'');
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'RETURN_IN_TRANSIT' then raise sqlstate 'PT422' using message = 'RETURN_IN_TRANSIT_REQUIRED'; end if;
  if p_package_match is not true or p_seal_intact is not true then raise sqlstate 'PT422' using message = 'PACKAGE_CHAIN_REQUIRED'; end if;
  if coalesce(btrim(p_warehouse_proof),'') = '' then raise sqlstate 'PT422' using message = 'PROOF_REQUIRED'; end if;
  if jsonb_typeof(p_receipts) is distinct from 'array'
    or jsonb_array_length(p_receipts) <> (select count(*) from public.return_item where return_id = p_return_id) then
    raise sqlstate 'PT422' using message = 'WAREHOUSE_LINE_MISMATCH'; end if;
  for v_line in select * from public.return_item where return_id = p_return_id order by return_item_id loop
    select value into v_receipt from jsonb_array_elements(p_receipts)
      where value->>'orderItemId' = v_line.order_item_id::text;
    if v_receipt is null or (v_receipt->>'matchesProduct')::boolean is distinct from true
      or (v_receipt->>'receivedQuantity')::numeric <> v_line.quantity then
      raise sqlstate 'PT422' using message = 'WAREHOUSE_LINE_MISMATCH'; end if;
    v_disposition := coalesce(v_receipt->>'disposition','');
    if v_disposition not in ('restock','repair','scrap','return_supplier') then
      raise sqlstate 'PT422' using message = 'RETURN_DISPOSITION_REQUIRED'; end if;
    if v_disposition = 'restock' then
      select oi.variant_id into v_variant_id from public.order_item oi where oi.item_id = v_line.order_item_id;
      if v_variant_id is null then raise sqlstate 'PT422' using message = 'ORDER_ITEM_VARIANT_REQUIRED'; end if;
      select * into v_variant from public.variant where variant_id = v_variant_id for update;
      if not found then raise sqlstate 'PT422' using message = 'VARIANT_NOT_FOUND'; end if;
      v_before := v_variant.stock_quantity;
      v_after := v_before + v_line.quantity;
      update public.variant set stock_quantity = v_after, version = version + 1, updated_at = now()
        where variant_id = v_variant_id;
      insert into public.return_stock_movement(return_id, return_item_id, variant_id, order_id,
        disposition, quantity, before_quantity, after_quantity, actor_id, note)
        values(p_return_id, v_line.return_item_id, v_variant_id, v_return.order_id,
          v_disposition, v_line.quantity, v_before, v_after, p_actor_id,
          nullif(btrim(coalesce(v_receipt->>'dispositionNote','')),''));
      update public.return_item set disposition = v_disposition,
        disposition_note = nullif(btrim(coalesce(v_receipt->>'dispositionNote','')),''),
        restocked_at = now(), stock_restored_quantity = v_line.quantity
        where return_item_id = v_line.return_item_id;
    else
      update public.return_item set disposition = v_disposition,
        disposition_note = nullif(btrim(coalesce(v_receipt->>'dispositionNote','')),''),
        restocked_at = null, stock_restored_quantity = 0
        where return_item_id = v_line.return_item_id;
    end if;
  end loop;
  perform set_config('app.return_actor_type','admin',true);
  perform set_config('app.return_suppress_transition_event','on',true);
  update public.return_exchange set status = 'RECEIVED', condition_check_result = 'qa_pass',
    package_match = true, seal_intact = true, warehouse_proof = p_warehouse_proof,
    qa_note = v_note, qa_item_receipts = p_receipts, version = version + 1, updated_at = now()
    where return_id = p_return_id returning * into v_return;
  perform set_config('app.return_suppress_transition_event','off',true);
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,'RETURN_IN_TRANSIT','RECEIVED',p_actor_id,'admin','qa_disposition',
      jsonb_build_object('receipts',p_receipts,'package_match',true,'seal_intact',true),
      coalesce(v_note,'Kho đã nhận và kiểm hàng'));
  insert into public.audit_log(actor_id,actor_role,action,module,target_id,new_value,ip_address,timestamp)
    values(p_actor_id,'admin_operator_cskh_dt','update','returns',p_return_id,
      jsonb_build_object('status','RECEIVED','receipts',p_receipts,'package_match',true,'seal_intact',true),
      '127.0.0.1',now());
  return to_jsonb(v_return);
end; $$;
revoke all on function public.velura_receive_return(uuid,integer,jsonb,boolean,boolean,text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_receive_return(uuid,integer,jsonb,boolean,boolean,text,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Loyalty: refunds claw back, exchanges do not
-- ---------------------------------------------------------------------------
create or replace function public.velura_adjust_loyalty_for_return(p_return_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_return public.return_exchange%rowtype;
  v_order public.orders%rowtype;
  v_account public.loyalty_account%rowtype;
  v_refunded numeric;
  v_net_paid numeric;
  v_clawback bigint;
  v_taken bigint;
  v_short bigint;
  v_full boolean;
begin
  select * into v_return from public.return_exchange
  where return_id=p_return_id and status::text in ('completed','COMPLETED','refunded','REFUNDED') for update;
  if v_return.return_id is null or exists(select 1 from public.loyalty_ledger where return_id=p_return_id and kind='clawback') then return; end if;
  -- An exchange keeps the purchase value: the customer receives a replacement, no money is returned.
  if v_return.return_type::text <> 'refund' then return; end if;
  select * into v_order from public.orders where order_id=v_return.order_id for update;
  if v_order.points_earned_milli <= 0 then return; end if;
  -- Claw back in proportion to cash actually refunded, not the list value of returned goods.
  -- Points were earned on the net paid amount (after voucher and point discounts).
  select amount into v_refunded from public.payment_refund
    where return_id=p_return_id and status='succeeded' limit 1;
  if v_refunded is null or v_refunded <= 0 then
    v_refunded := public.velura_return_refundable_amount(p_return_id);
  end if;
  v_net_paid := greatest(coalesce(v_order.subtotal,0) - coalesce(v_order.discount_amount,0) - coalesce(v_order.points_discount_amount,0), 1);
  v_clawback := least(v_order.points_earned_milli, round(v_order.points_earned_milli * v_refunded / v_net_paid));
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

-- ---------------------------------------------------------------------------
-- 8. Replacement order carries its parent order + return link
-- ---------------------------------------------------------------------------
create or replace function public.velura_prepare_exchange(p_return_id uuid,p_expected_version integer,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_original public.orders%rowtype;
  v_order public.orders%rowtype; v_item record; v_variant public.variant%rowtype;
  v_target uuid; v_subtotal numeric := 0; v_code text;
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'RECEIVED' or v_return.return_type::text <> 'exchange'
    or v_return.condition_check_result <> 'qa_pass' then raise sqlstate 'PT422' using message = 'WAREHOUSE_QA_REQUIRED'; end if;
  select * into v_original from public.orders where order_id = v_return.order_id;
  for v_item in select ri.*,oi.variant_id,oi.unit_price from public.return_item ri
    join public.order_item oi on oi.item_id = ri.order_item_id where ri.return_id = p_return_id order by ri.order_item_id loop
    v_target := coalesce(v_item.replacement_variant_id,v_item.variant_id);
    select * into v_variant from public.variant where variant_id = v_target for update;
    if not found or v_variant.product_id <> (select product_id from public.variant where variant_id = v_item.variant_id) then
      raise sqlstate 'PT422' using message = 'EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
    if v_variant.stock_quantity - v_variant.reserved_quantity < v_item.quantity then raise sqlstate 'PT409' using message = 'INSUFFICIENT_STOCK'; end if;
    v_subtotal := v_subtotal + v_item.unit_price * v_item.quantity;
  end loop;
  if v_subtotal <= 0 then raise sqlstate 'PT422' using message = 'EXCHANGE_ITEMS_REQUIRED'; end if;
  v_code := 'EXC' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
  insert into public.orders(user_id,order_code,status,shipping_name,shipping_phone,shipping_email,shipping_address,
    subtotal,discount_amount,total_amount,shipping_fee,payment_method,is_guest,stock_committed_at,internal_note,
    order_kind,parent_order_id,source_return_id)
    values(v_original.user_id,v_code,'confirmed',v_original.shipping_name,v_original.shipping_phone,v_original.shipping_email,
      v_original.shipping_address,v_subtotal,v_subtotal,0,0,'COD',v_original.is_guest,now(),
      'Replacement funded by original returned merchandise: ' || p_return_id::text,
      'exchange',v_original.order_id,p_return_id) returning * into v_order;
  for v_item in select ri.*,oi.variant_id,oi.unit_price,oi.product_name,oi.product_image from public.return_item ri
    join public.order_item oi on oi.item_id = ri.order_item_id where ri.return_id = p_return_id loop
    v_target := coalesce(v_item.replacement_variant_id,v_item.variant_id);
    update public.variant set stock_quantity = stock_quantity - v_item.quantity,version = version + 1,updated_at = now() where variant_id = v_target;
    insert into public.order_item(order_id,variant_id,product_name,product_image,quantity,unit_price,subtotal_item)
      values(v_order.order_id,v_target,v_item.product_name,v_item.product_image,v_item.quantity,v_item.unit_price,v_item.quantity*v_item.unit_price);
  end loop;
  perform set_config('app.return_actor_type','admin',true);
  perform set_config('app.return_suppress_transition_event','on',true);
  update public.return_exchange set status = 'EXCHANGE_PREPARING',exchange_order_id = v_order.order_id,
    version = version+1,updated_at = now() where return_id = p_return_id returning * into v_return;
  perform set_config('app.return_suppress_transition_event','off',true);
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,'RECEIVED','EXCHANGE_PREPARING',p_actor_id,'admin','status',
      jsonb_build_object('exchange_order_id',v_order.order_id,'exchange_order_code',v_code),
      'Tạo đơn đổi ' || v_code);
  insert into public.order_event(order_id,action,actor_type,actor_id,actor_role,result,note,payload)
    values(v_order.order_id,'exchange_order_created','manual',p_actor_id,'admin_operator_cskh_dt','success',
      'Tạo đơn đổi từ phiếu ' || p_return_id::text,
      jsonb_build_object('return_id',p_return_id,'parent_order_id',v_original.order_id));
  insert into public.order_status_history(history_id,order_id,old_status,new_status,trigger_type,changed_by,changed_at,note)
    values(gen_random_uuid(),v_order.order_id,'pending','confirmed','manual',p_actor_id,now(),
      'Đơn đổi được tạo từ phiếu ' || p_return_id::text);
  insert into public.audit_log(actor_id,actor_role,action,module,target_id,new_value,ip_address,timestamp)
    values(p_actor_id,'admin_operator_cskh_dt','update','returns',p_return_id,to_jsonb(v_return),'127.0.0.1',now());
  return to_jsonb(v_return);
end; $$;
revoke all on function public.velura_prepare_exchange(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.velura_prepare_exchange(uuid,integer,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Inbound shipment: create label / confirm carrier pickup / status updates
-- ---------------------------------------------------------------------------
create or replace function public.velura_create_return_shipment(
  p_return_id uuid, p_expected_version integer, p_carrier text, p_tracking_code text,
  p_tracking_url text, p_label_url text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_shipment public.return_shipment%rowtype;
  v_carrier text := btrim(coalesce(p_carrier, '')); v_code text := btrim(coalesce(p_tracking_code, ''));
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'WAITING_RETURN' then raise sqlstate 'PT422' using message = 'WAITING_RETURN_REQUIRED'; end if;
  if length(v_carrier) < 2 then raise sqlstate 'PT422' using message = 'CARRIER_REQUIRED'; end if;
  if length(v_code) < 6 then raise sqlstate 'PT422' using message = 'TRACKING_REQUIRED'; end if;
  select * into v_shipment from public.return_shipment
    where return_id = p_return_id and direction = 'inbound' for update;
  if found and v_shipment.status in ('picked_up','in_transit','delivered') then
    raise sqlstate 'PT409' using message = 'SHIPMENT_LOCKED';
  end if;
  insert into public.return_shipment(return_id,direction,carrier,tracking_code,tracking_url,label_url,handover_code,status,created_by)
    values(p_return_id,'inbound',v_carrier,v_code,nullif(btrim(coalesce(p_tracking_url,'')),''),
      nullif(btrim(coalesce(p_label_url,'')),''),v_return.return_code,'label_ready',p_actor_id)
    on conflict (return_id,direction) do update set
      carrier = excluded.carrier, tracking_code = excluded.tracking_code,
      tracking_url = excluded.tracking_url, label_url = excluded.label_url,
      status = case when return_shipment.status = 'picked_up' then return_shipment.status else 'label_ready' end,
      updated_at = now(), version = return_shipment.version + 1
    returning * into v_shipment;
  update public.return_exchange set tracking_return_code = v_code, version = version + 1, updated_at = now()
    where return_id = p_return_id returning * into v_return;
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,v_return.status::text,v_return.status::text,p_actor_id,'admin','shipment',
      jsonb_build_object('shipment_id',v_shipment.shipment_id,'direction','inbound','carrier',v_carrier,
        'tracking_code',v_code,'tracking_url',v_shipment.tracking_url,'return_code',v_return.return_code),
      'Đã tạo vận đơn hoàn ' || v_carrier || ' · ' || v_code);
  return jsonb_build_object('return',to_jsonb(v_return),'shipment',to_jsonb(v_shipment));
end; $$;
revoke all on function public.velura_create_return_shipment(uuid,integer,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_create_return_shipment(uuid,integer,text,text,text,text,uuid) to service_role;

create or replace function public.velura_confirm_return_pickup(
  p_return_id uuid, p_expected_version integer, p_photo_urls text[], p_video_url text, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_shipment public.return_shipment%rowtype;
  v_photos text[] := coalesce(p_photo_urls, '{}'::text[]); v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'WAITING_RETURN' then raise sqlstate 'PT422' using message = 'WAITING_RETURN_REQUIRED'; end if;
  select * into v_shipment from public.return_shipment
    where return_id = p_return_id and direction = 'inbound' for update;
  if not found then raise sqlstate 'PT422' using message = 'RETURN_SHIPMENT_REQUIRED'; end if;
  if v_shipment.status = 'picked_up' then raise sqlstate 'PT409' using message = 'PICKUP_ALREADY_CONFIRMED'; end if;
  if coalesce(array_length(v_photos, 1), 0) < 1 then raise sqlstate 'PT422' using message = 'PICKUP_PHOTO_REQUIRED'; end if;
  update public.return_shipment set status = 'picked_up', picked_up_at = now(),
    pickup_photo_urls = v_photos, package_video_url = nullif(btrim(coalesce(p_video_url,'')),''),
    updated_at = now(), version = version + 1
    where shipment_id = v_shipment.shipment_id returning * into v_shipment;
  perform set_config('app.return_actor_type','admin',true);
  perform set_config('app.return_suppress_transition_event','on',true);
  update public.return_exchange set status = 'RETURN_IN_TRANSIT', version = version + 1, updated_at = now()
    where return_id = p_return_id returning * into v_return;
  perform set_config('app.return_suppress_transition_event','off',true);
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,'WAITING_RETURN','RETURN_IN_TRANSIT',p_actor_id,'admin','pickup',
      jsonb_build_object('shipment_id',v_shipment.shipment_id,'carrier',v_shipment.carrier,
        'tracking_code',v_shipment.tracking_code,'photos',v_photos,'video',v_shipment.package_video_url),
      coalesce(v_note,'ĐVVC đã lấy hàng hoàn; bằng chứng pickup đã lưu'));
  return jsonb_build_object('return',to_jsonb(v_return),'shipment',to_jsonb(v_shipment));
end; $$;
revoke all on function public.velura_confirm_return_pickup(uuid,integer,text[],text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_confirm_return_pickup(uuid,integer,text[],text,text,uuid) to service_role;

create or replace function public.velura_update_return_shipment_status(
  p_return_id uuid, p_status text, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_shipment public.return_shipment%rowtype;
  v_status text := btrim(coalesce(p_status,''));
  v_from text;
begin
  if v_status not in ('in_transit','delivered','failed') then
    raise sqlstate 'PT422' using message = 'INVALID_SHIPMENT_STATUS';
  end if;
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  v_from := v_return.status::text;
  select * into v_shipment from public.return_shipment
    where return_id = p_return_id and direction = 'inbound' for update;
  if not found then raise sqlstate 'PT422' using message = 'RETURN_SHIPMENT_REQUIRED'; end if;
  update public.return_shipment set status = v_status,
    delivered_at = case when v_status = 'delivered' then now() else delivered_at end,
    updated_at = now(), version = version + 1
    where shipment_id = v_shipment.shipment_id returning * into v_shipment;
  if v_status = 'failed' and v_return.status::text = 'RETURN_IN_TRANSIT' then
    perform set_config('app.return_actor_type','admin',true);
    perform set_config('app.return_suppress_transition_event','on',true);
    update public.return_exchange set status = 'NEEDS_SUPPORT', version = version + 1, updated_at = now()
      where return_id = p_return_id returning * into v_return;
    perform set_config('app.return_suppress_transition_event','off',true);
  end if;
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,v_from,v_return.status::text,p_actor_id,'admin','shipment',
      jsonb_build_object('shipment_id',v_shipment.shipment_id,'status',v_status),
      coalesce(nullif(btrim(coalesce(p_note,'')),''),'Cập nhật vận đơn hoàn: ' || v_status));
  return jsonb_build_object('return',to_jsonb(v_return),'shipment',to_jsonb(v_shipment));
end; $$;
revoke all on function public.velura_update_return_shipment_status(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_update_return_shipment_status(uuid,text,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Outbound exchange shipment: return + linked replacement order move together
-- ---------------------------------------------------------------------------
create or replace function public.velura_ship_exchange(
  p_return_id uuid, p_expected_version integer, p_carrier text, p_tracking_code text,
  p_tracking_url text, p_label_url text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_shipment public.return_shipment%rowtype;
  v_carrier text := btrim(coalesce(p_carrier,'')); v_code text := btrim(coalesce(p_tracking_code,''));
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'EXCHANGE_PREPARING' or v_return.exchange_order_id is null then
    raise sqlstate 'PT422' using message = 'EXCHANGE_PREPARING_REQUIRED'; end if;
  if length(v_carrier) < 2 then raise sqlstate 'PT422' using message = 'CARRIER_REQUIRED'; end if;
  if length(v_code) < 6 then raise sqlstate 'PT422' using message = 'TRACKING_REQUIRED'; end if;
  insert into public.return_shipment(return_id,direction,order_id,carrier,tracking_code,tracking_url,label_url,handover_code,status,created_by)
    values(p_return_id,'outbound',v_return.exchange_order_id,v_carrier,v_code,
      nullif(btrim(coalesce(p_tracking_url,'')),''),nullif(btrim(coalesce(p_label_url,'')),''),v_code,'picked_up',p_actor_id)
    on conflict (return_id,direction) do update set
      order_id = excluded.order_id, carrier = excluded.carrier, tracking_code = excluded.tracking_code,
      tracking_url = excluded.tracking_url, label_url = excluded.label_url, status = 'picked_up',
      picked_up_at = coalesce(return_shipment.picked_up_at, now()), updated_at = now(),
      version = return_shipment.version + 1
    returning * into v_shipment;
  update public.orders set carrier = v_carrier, tracking_code = v_code,
    tracking_url = nullif(btrim(coalesce(p_tracking_url,'')),''), status = 'shipping',
    shipment_created_at = coalesce(shipment_created_at, now()), handed_over_at = coalesce(handed_over_at, now()),
    updated_at = now()
    where order_id = v_return.exchange_order_id;
  perform set_config('app.return_actor_type','admin',true);
  perform set_config('app.return_suppress_transition_event','on',true);
  update public.return_exchange set status = 'EXCHANGE_SHIPPING', exchange_tracking_code = v_code,
    version = version + 1, updated_at = now() where return_id = p_return_id returning * into v_return;
  perform set_config('app.return_suppress_transition_event','off',true);
  insert into public.order_event(order_id,action,actor_type,actor_id,actor_role,result,note,payload)
    values(v_return.exchange_order_id,'exchange_shipped','manual',p_actor_id,'admin_operator_cskh_dt','success',
      'Đơn đổi đã bàn giao ĐVVC',
      jsonb_build_object('return_id',p_return_id,'carrier',v_carrier,'tracking_code',v_code,'tracking_url',p_tracking_url));
  insert into public.order_status_history(history_id,order_id,old_status,new_status,trigger_type,changed_by,changed_at,note)
    values(gen_random_uuid(),v_return.exchange_order_id,'confirmed','shipping','manual',p_actor_id,now(),
      'Đơn đổi bàn giao ' || v_carrier || ' · ' || v_code);
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,'EXCHANGE_PREPARING','EXCHANGE_SHIPPING',p_actor_id,'admin','shipment',
      jsonb_build_object('shipment_id',v_shipment.shipment_id,'direction','outbound','carrier',v_carrier,
        'tracking_code',v_code,'tracking_url',p_tracking_url,'exchange_order_id',v_return.exchange_order_id),
      'Đã giao hàng đổi ' || v_carrier || ' · ' || v_code);
  return jsonb_build_object('return',to_jsonb(v_return),'shipment',to_jsonb(v_shipment));
end; $$;
revoke all on function public.velura_ship_exchange(uuid,integer,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_ship_exchange(uuid,integer,text,text,text,text,uuid) to service_role;

-- Completing an exchange closes the return and marks the linked order delivered in one transaction.
create or replace function public.velura_complete_exchange(
  p_return_id uuid, p_expected_version integer, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_order public.orders%rowtype;
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_return.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_return.status::text <> 'EXCHANGE_SHIPPING' or v_return.exchange_order_id is null then
    raise sqlstate 'PT422' using message = 'EXCHANGE_SHIPPING_REQUIRED'; end if;
  select * into v_order from public.orders where order_id = v_return.exchange_order_id for update;
  -- A carrier webhook may already have moved the linked order to delivered; do not duplicate history.
  if v_order.status::text <> 'delivered' then
    update public.orders set status = 'delivered', delivered_at = coalesce(delivered_at, now()), updated_at = now()
      where order_id = v_return.exchange_order_id;
    insert into public.order_status_history(history_id,order_id,old_status,new_status,trigger_type,changed_by,changed_at,note)
      values(gen_random_uuid(),v_return.exchange_order_id,v_order.status,'delivered','manual',p_actor_id,now(),
        'Hoàn tất đổi hàng từ phiếu ' || p_return_id::text);
    insert into public.order_event(order_id,action,actor_type,actor_id,actor_role,result,note,payload)
      values(v_return.exchange_order_id,'exchange_delivered','manual',p_actor_id,'admin_operator_cskh_dt','success',
        'Đơn đổi đã giao thành công', jsonb_build_object('return_id',p_return_id));
  end if;
  update public.return_shipment set status = 'delivered', delivered_at = coalesce(delivered_at, now()),
    updated_at = now(), version = version + 1
    where return_id = p_return_id and direction = 'outbound';
  perform set_config('app.return_actor_type','admin',true);
  perform set_config('app.return_suppress_transition_event','on',true);
  update public.return_exchange set status = 'COMPLETED', resolved_at = now(), version = version + 1, updated_at = now()
    where return_id = p_return_id returning * into v_return;
  perform set_config('app.return_suppress_transition_event','off',true);
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(p_return_id,'EXCHANGE_SHIPPING','COMPLETED',p_actor_id,'admin','status',jsonb_build_object('exchange_order_id',v_return.exchange_order_id),
      'Hoàn tất đổi hàng');
  return to_jsonb(v_return);
end; $$;
revoke all on function public.velura_complete_exchange(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.velura_complete_exchange(uuid,integer,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10b. Carrier webhook for return shipments (AWB first, return_code cross-check)
-- ---------------------------------------------------------------------------
alter table public.carrier_delivery_event
  alter column order_code drop not null,
  add column if not exists return_code text,
  add column if not exists return_id uuid references public.return_exchange(return_id) on delete set null,
  add column if not exists return_shipment_id uuid references public.return_shipment(shipment_id) on delete set null,
  add column if not exists direction text;

create index if not exists carrier_delivery_event_return_idx
  on public.carrier_delivery_event (return_id, occurred_at desc);

create or replace function public.velura_apply_return_carrier_event(
  p_shipment_id uuid, p_status text, p_note text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_shipment public.return_shipment%rowtype; v_return public.return_exchange%rowtype;
  v_action text; v_shipment_status text; v_from text;
begin
  if p_status not in ('delivered','failed_retrying','failed_returned') then
    raise sqlstate 'PT422' using message = 'CARRIER_STATUS_UNSUPPORTED';
  end if;
  select * into v_shipment from public.return_shipment where shipment_id = p_shipment_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_SHIPMENT_NOT_FOUND'; end if;
  select * into v_return from public.return_exchange where return_id = v_shipment.return_id for update;
  v_from := v_return.status::text;
  v_shipment_status := case p_status
    when 'delivered' then 'delivered'
    when 'failed_retrying' then 'in_transit'
    else 'failed' end;
  update public.return_shipment set status = v_shipment_status,
    delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    updated_at = now(), version = version + 1
    where shipment_id = p_shipment_id returning * into v_shipment;
  if v_shipment.direction = 'outbound' and v_shipment.order_id is not null then
    v_action := case p_status
      when 'delivered' then 'carrier_delivered'
      when 'failed_retrying' then 'carrier_failed_retrying'
      else 'carrier_failed_returned' end;
    perform public.velura_order_service_action(
      v_shipment.order_id, v_action, null,
      coalesce(nullif(btrim(coalesce(p_note,'')),''), 'ĐVVC báo ' || p_status),
      coalesce(p_payload,'{}'::jsonb), null);
  end if;
  if p_status = 'failed_returned'
    and v_return.status::text in ('RETURN_IN_TRANSIT','EXCHANGE_SHIPPING') then
    perform set_config('app.return_actor_type','admin',true);
    perform set_config('app.return_suppress_transition_event','on',true);
    update public.return_exchange set status = 'NEEDS_SUPPORT', version = version + 1,
      admin_note = concat_ws(E'\n', nullif(admin_note,''),
        '[ĐVVC ' || coalesce(v_shipment.carrier,'') || '] Hoàn hàng thất bại: ' || coalesce(p_note,'không rõ lý do')),
      updated_at = now()
      where return_id = v_return.return_id returning * into v_return;
    perform set_config('app.return_suppress_transition_event','off',true);
  end if;
  insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,event_type,payload,note)
    values(v_return.return_id,v_from,v_return.status::text,null,'carrier','carrier',
      jsonb_build_object('shipment_id',v_shipment.shipment_id,'direction',v_shipment.direction,
        'carrier',v_shipment.carrier,'tracking_code',v_shipment.tracking_code,
        'status',v_shipment.status,'provider_status',p_status,'shipment_status',v_shipment.status,
        'occurred_at',coalesce(p_payload->>'occurred_at',now()::text)),
      coalesce(nullif(btrim(coalesce(p_note,'')),''),'ĐVVC cập nhật vận đơn hoàn: ' || p_status));
  return jsonb_build_object('return_id',v_return.return_id,'shipment',to_jsonb(v_shipment));
end; $$;
revoke all on function public.velura_apply_return_carrier_event(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.velura_apply_return_carrier_event(uuid,text,text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Private evidence bucket (images + packing/pickup videos)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'return-evidence-private', 'return-evidence-private', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 12. Grants / RLS
-- ---------------------------------------------------------------------------
alter table public.return_shipment enable row level security;
alter table public.return_evidence enable row level security;
alter table public.return_stock_movement enable row level security;
revoke all on public.return_shipment, public.return_evidence, public.return_stock_movement from public, anon, authenticated;
grant all on public.return_shipment, public.return_evidence, public.return_stock_movement to service_role;

comment on table public.return_shipment is
  'Vận đơn hoàn: inbound (khách gửi về kho) và outbound (kho gửi hàng đổi), kèm bằng chứng pickup.';
comment on table public.return_evidence is
  'Bằng chứng bất biến theo phiếu: khách đóng gói (video/ảnh), ĐVVC lấy hàng, kho QA.';
comment on function public.velura_adjust_loyalty_for_return(uuid) is
  'Chỉ thu hồi Point khi hoàn tiền; đổi hàng giữ nguyên giá trị mua nên không clawback.';

notify pgrst, 'reload schema';
commit;
