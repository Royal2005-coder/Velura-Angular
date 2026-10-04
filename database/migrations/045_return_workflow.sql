-- KAN-58: one persisted return workflow is shared by storefront and administrator.
alter table public.return_exchange
  add column if not exists legacy_status text,
  add column if not exists legacy_condition_check text,
  add column if not exists contact_due_at timestamptz,
  add column if not exists qa_item_receipts jsonb,
  add column if not exists warehouse_proof text,
  add column if not exists exchange_tracking_code text;
alter table public.return_item add column if not exists replacement_variant_id uuid references public.variant(variant_id);
update public.return_exchange set legacy_status = status::text,
  legacy_condition_check = condition_check_result::text,
  condition_check_result = (case condition_check_result::text when 'passed' then 'qa_pass'
    when 'minor_damage' then 'qa_fail' when 'major_damage' then 'qa_fail' else condition_check_result::text end)::public.condition_check,
  contact_due_at = created_at + interval '24 hours',
  status = (case status::text
    when 'pending' then 'REQUESTED' when 'approved' then 'WAITING_RETURN'
    when 'shipping_back' then 'RETURN_IN_TRANSIT' when 'received' then 'RECEIVED'
    when 'completed' then 'COMPLETED' when 'rejected' then 'CANCELLED'
    when 'cancelled' then 'CANCELLED' else status::text end)::public.return_status
where legacy_status is null;
alter table public.return_exchange alter column status set default 'REQUESTED'::public.return_status;

create table if not exists public.return_event (
  event_id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.return_exchange(return_id),
  old_status text, new_status text not null,
  actor_id uuid, actor_type text not null default 'system', note text,
  created_at timestamptz not null default now()
);
alter table public.return_event enable row level security;
revoke all on public.return_event from anon, authenticated;
grant select on public.return_event to authenticated;
grant all on public.return_event to service_role;
create policy return_event_owner_or_admin_read on public.return_event for select to authenticated using (
  exists(select 1 from public.return_exchange r where r.return_id = return_event.return_id)
);

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
    when 'NEEDS_SUPPORT' then array['CONTACTING'] else array[]::text[] end;
  if not (v_to = any(v_allowed)) then raise sqlstate 'PT422' using message = 'INVALID_RETURN_TRANSITION'; end if;
  if new.version <> old.version + 1 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_to = 'RECEIVED' then
    if new.condition_check_result <> 'qa_pass' or coalesce(new.warehouse_proof,'') = ''
      or jsonb_typeof(new.qa_item_receipts) is distinct from 'array'
      or jsonb_array_length(new.qa_item_receipts) <> (select count(*) from public.return_item where return_id = new.return_id)
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
  if v_to = 'RETURN_IN_TRANSIT' and coalesce(new.tracking_return_code,'') = '' then
    raise sqlstate 'PT422' using message = 'TRACKING_REQUIRED'; end if;
  if v_to = 'EXCHANGE_SHIPPING' and coalesce(new.exchange_tracking_code,'') = '' then
    raise sqlstate 'PT422' using message = 'EXCHANGE_TRACKING_REQUIRED'; end if;
  if v_to = 'COMPLETED' and new.return_type::text = 'exchange' and not exists(
    select 1 from public.orders where order_id = new.exchange_order_id and status::text = 'delivered') then
    raise sqlstate 'PT422' using message = 'EXCHANGE_DELIVERY_REQUIRED'; end if;
  return new;
end; $$;
create trigger return_workflow_guard before insert or update of status on public.return_exchange
  for each row execute function public.velura_return_workflow_guard();

create or replace function public.velura_log_return_transition()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, auth as $$
begin
  if new.status is distinct from old.status then
    insert into public.return_event(return_id,old_status,new_status,actor_id,actor_type,note)
      values(new.return_id,old.status::text,new.status::text,auth.uid(),
        coalesce(nullif(current_setting('app.return_actor_type',true),''),'system'),
        coalesce(new.rejection_reason,new.admin_note));
  end if;
  return new;
end; $$;
create trigger return_transition_event after update of status on public.return_exchange
  for each row execute function public.velura_log_return_transition();

-- Approval never creates an order. The replacement is committed after every receipt line passes QA.
create or replace function public.velura_prepare_exchange(p_return_id uuid,p_expected_version integer,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_original public.orders%rowtype;
  v_order public.orders%rowtype; v_item record; v_variant public.variant%rowtype;
  v_product public.product%rowtype; v_target uuid; v_subtotal numeric := 0; v_code text;
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
    subtotal,discount_amount,total_amount,shipping_fee,payment_method,is_guest,stock_committed_at,internal_note)
    values(v_original.user_id,v_code,'confirmed',v_original.shipping_name,v_original.shipping_phone,v_original.shipping_email,
      v_original.shipping_address,v_subtotal,v_subtotal,0,0,'COD',v_original.is_guest,now(),
      'Replacement funded by original returned merchandise: ' || p_return_id::text) returning * into v_order;
  for v_item in select ri.*,oi.variant_id,oi.unit_price,oi.product_name,oi.product_image from public.return_item ri
    join public.order_item oi on oi.item_id = ri.order_item_id where ri.return_id = p_return_id loop
    v_target := coalesce(v_item.replacement_variant_id,v_item.variant_id);
    update public.variant set stock_quantity = stock_quantity - v_item.quantity,version = version + 1,updated_at = now() where variant_id = v_target;
    insert into public.order_item(order_id,variant_id,product_name,product_image,quantity,unit_price,subtotal_item)
      values(v_order.order_id,v_target,v_item.product_name,v_item.product_image,v_item.quantity,v_item.unit_price,v_item.quantity*v_item.unit_price);
  end loop;
  perform set_config('app.return_actor_type','admin',true);
  update public.return_exchange set status = 'EXCHANGE_PREPARING',exchange_order_id = v_order.order_id,
    version = version+1,updated_at = now() where return_id = p_return_id returning * into v_return;
  insert into public.audit_log(actor_id,actor_role,action,module,target_id,new_value,timestamp)
    values(p_actor_id,'admin_operator_cskh_dt','update','returns',p_return_id,to_jsonb(v_return),now());
  return to_jsonb(v_return);
end; $$;
revoke all on function public.velura_prepare_exchange(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.velura_prepare_exchange(uuid,integer,uuid) to service_role;

-- Non-Stripe transfers share the same captured-money ledger and never simulate a gateway callback.
create or replace function public.velura_record_manual_return_refund(
  p_return_id uuid,p_expected_version integer,p_reference text,p_proof text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_return public.return_exchange%rowtype; v_payment public.payment%rowtype; v_operation jsonb;
begin
  if length(btrim(p_reference)) < 6 or (p_proof not like 'https://%' and p_proof not like 'data:image/%') then
    raise sqlstate 'PT422' using message = 'TRANSFER_PROOF_REQUIRED'; end if;
  select * into v_return from public.return_exchange where return_id = p_return_id;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  select * into v_payment from public.payment where order_id = v_return.order_id
    and payment_status::text in ('paid','refund_pending') order by created_at desc limit 1;
  if not found or v_payment.payment_provider = 'stripe' then raise sqlstate 'PT422' using message = 'CAPTURED_NON_STRIPE_REQUIRED'; end if;
  perform set_config('app.return_actor_type','admin',true);
  v_operation := public.velura_prepare_return_refund(p_return_id,v_return.order_id,p_expected_version);
  perform public.velura_complete_return_refund(p_return_id,'manual:' || p_reference);
  insert into public.audit_log(actor_id,actor_role,action,module,target_id,new_value,timestamp)
    values(p_actor_id,'admin_operator_cskh_dt','update','returns',p_return_id,
      jsonb_build_object('transfer_reference',p_reference,'transfer_proof',p_proof,'refund',v_operation),now());
  select * into v_return from public.return_exchange where return_id = p_return_id;
  return to_jsonb(v_return);
end; $$;
revoke all on function public.velura_record_manual_return_refund(uuid,integer,text,text,uuid) from public,anon,authenticated;
grant execute on function public.velura_record_manual_return_refund(uuid,integer,text,text,uuid) to service_role;

create or replace function public.velura_prepare_return_refund(p_return_id uuid, p_order_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_ret public.return_exchange%rowtype; v_payment public.payment%rowtype;
  v_refund public.payment_refund%rowtype; v_amount numeric; v_reserved numeric;
begin
  perform 1 from public.orders where order_id = p_order_id for update;
  select * into v_ret from public.return_exchange where return_id = p_return_id and order_id = p_order_id for update;
  if not found then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  select * into v_refund from public.payment_refund where return_id = p_return_id;
  if found and v_refund.status = 'succeeded' then return to_jsonb(v_refund); end if;
  if p_expected_version is null or v_ret.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_ret.status::text not in ('RECEIVED','REFUND_PROCESSING') or v_ret.condition_check_result <> 'qa_pass' or v_ret.return_type::text <> 'refund' then
    raise sqlstate 'PT422' using message = 'QA_REQUIRED';
  end if;
  if v_refund.refund_id is not null then return to_jsonb(v_refund); end if;
  select * into v_payment from public.payment where order_id = p_order_id
    and payment_status::text in ('paid', 'refund_pending') order by created_at desc limit 1 for update;
  if not found then raise sqlstate 'PT422' using message = 'CAPTURED_PAYMENT_REQUIRED'; end if;
  v_amount := public.velura_return_refundable_amount(p_return_id);
  select coalesce(sum(amount), 0) into v_reserved from public.payment_refund
    where payment_id = v_payment.payment_id and status in ('requested', 'pending', 'failed');
  v_amount := least(v_amount, v_payment.amount - v_payment.refunded_amount - v_reserved);
  if v_amount <= 0 then raise sqlstate 'PT422' using message = 'REFUND_BALANCE_EXHAUSTED'; end if;
  insert into public.payment_refund(return_id, payment_id, amount) values(p_return_id, v_payment.payment_id, v_amount)
    returning * into v_refund;
  update public.payment set payment_status = 'refund_pending', refund_amount = v_amount,
    gateway_response_code = 'REFUND_REQUESTED', version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
  update public.return_exchange set status = 'REFUND_PROCESSING',version = version + 1,updated_at = now() where return_id = p_return_id and status::text = 'RECEIVED';
  return to_jsonb(v_refund);
end; $$;
revoke all on function public.velura_prepare_return_refund(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.velura_prepare_return_refund(uuid, uuid, integer) to service_role;

create or replace function public.velura_complete_return_refund(p_return_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_refund public.payment_refund%rowtype; v_order_id uuid; v_sum numeric; v_pending numeric;
begin
  select order_id into v_order_id from public.return_exchange where return_id = p_return_id;
  perform 1 from public.orders where order_id = v_order_id for update;
  select * into v_refund from public.payment_refund where return_id = p_return_id for update;
  if not found then raise sqlstate 'PT404' using message = 'REFUND_NOT_FOUND'; end if;
  if v_refund.status = 'succeeded' then return to_jsonb(v_refund); end if;
  update public.payment_refund set status = 'succeeded', provider_ref = p_provider_ref, updated_at = now()
    where refund_id = v_refund.refund_id returning * into v_refund;
  select coalesce(sum(amount) filter(where status = 'succeeded'), 0),
    coalesce(sum(amount) filter(where status in ('requested', 'pending', 'failed')), 0)
    into v_sum, v_pending from public.payment_refund where payment_id = v_refund.payment_id;
  update public.payment set refunded_amount = refunded_amount + v_refund.amount,
    refund_amount = v_sum + v_pending, refund_at = now(),
    payment_status = (case when refunded_amount + v_refund.amount >= amount then 'refunded' when v_pending > 0 then 'refund_pending' else 'paid' end)::public.payment_status,
    gateway_response_code = 'REFUNDED', version = version + 1, updated_at = now() where payment_id = v_refund.payment_id;
  update public.return_exchange set status = 'REFUNDED', refund_amount = v_refund.amount, resolved_at = now(),
    version = version + 1, updated_at = now() where return_id = p_return_id and status::text = 'REFUND_PROCESSING';
  insert into public.order_event(order_id, action, actor_type, result, note, payload)
    values(v_order_id, 'stripe_refund_succeeded', 'system', 'success', 'Stripe confirmed returned item refund',
      jsonb_build_object('return_id', p_return_id, 'amount', v_refund.amount, 'provider_ref', p_provider_ref));
  return to_jsonb(v_refund);
end; $$;
revoke all on function public.velura_complete_return_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.velura_complete_return_refund(uuid, text) to service_role;

create or replace function public.velura_guard_refunding_return()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.status::text = 'CANCELLED' and exists(select 1 from public.payment_refund where return_id = new.return_id) then
    raise sqlstate 'PT409' using message = 'REFUND_ALREADY_REQUESTED';
  end if;
  return new;
end; $$;
drop trigger if exists return_refund_state_guard on public.return_exchange;
create trigger return_refund_state_guard before update of status on public.return_exchange
  for each row execute function public.velura_guard_refunding_return();
