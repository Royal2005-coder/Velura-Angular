-- KAN-105 3.1.12 (AD_LIMIT_02, AD_RECEIVE_03): a request that CSKH rejects, stops forwarding or the customer
-- cancels must release its per-item return hold, must never count as a success, and the customer must be able
-- to tell "bi tu choi" (admin) from "da huy" (customer). Builds on 045 (workflow guard) and 046 (create RPC).
begin;

alter table public.return_exchange add column if not exists cancelled_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'return_exchange_cancelled_by_check') then
    alter table public.return_exchange add constraint return_exchange_cancelled_by_check
      check (cancelled_by is null or cancelled_by in ('customer', 'admin', 'system'));
  end if;
end $$;

-- Rows cancelled before this column existed: the two customer self-cancel texts are known, every other
-- cancellation (including the legacy 'rejected' status mapped by 045) was a CSKH decision.
update public.return_exchange
  set cancelled_by = case when coalesce(rejection_reason, '') in ('Đã hủy bởi khách hàng', 'Customer cancelled')
      then 'customer' else 'admin' end
  where status::text = 'CANCELLED' and cancelled_by is null;

-- One definition of "how much of an order line is held by return requests". Cancelled requests hold nothing,
-- open requests (not COMPLETED/REFUNDED/CANCELLED) block a new request, succeeded requests keep consuming a
-- turn and their quantity.
create or replace function public.velura_return_item_holds(p_order_item_id uuid)
returns table(attempts integer, held_quantity integer, succeeded_quantity integer, open_requests integer, open_code text)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select count(distinct r.return_id)::integer,
    coalesce(sum(ri.quantity), 0)::integer,
    coalesce(sum(ri.quantity) filter (where r.status::text in ('REFUNDED', 'COMPLETED')), 0)::integer,
    (count(distinct r.return_id) filter (where r.status::text not in ('REFUNDED', 'COMPLETED')))::integer,
    (array_agg(r.tracking_return_code order by r.created_at desc)
      filter (where r.status::text not in ('REFUNDED', 'COMPLETED')))[1]
  from public.return_item ri join public.return_exchange r on r.return_id = ri.return_id
  where ri.order_item_id = p_order_item_id and r.status::text <> 'CANCELLED';
$$;
revoke all on function public.velura_return_item_holds(uuid) from public, anon, authenticated;
grant execute on function public.velura_return_item_holds(uuid) to service_role;

create or replace function public.velura_create_return_request(p_payload jsonb, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_order public.orders%rowtype; v_return public.return_exchange%rowtype;
  v_item jsonb; v_order_item public.order_item%rowtype; v_qty integer; v_holds record;
begin
  select * into v_order from public.orders where order_id = (p_payload->>'order_id')::uuid for update;
  if not found or v_order.user_id::text is distinct from p_payload->>'user_id' then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status::text <> 'delivered' or coalesce(v_order.delivered_at, v_order.updated_at, v_order.created_at) < now() - interval '30 days' then
    raise sqlstate 'PT422' using message = 'RETURN_WINDOW_CLOSED'; end if;
  if p_payload->>'return_type' not in ('refund', 'exchange') or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) = 0 then raise sqlstate 'PT422' using message = 'INVALID_RETURN_ITEMS'; end if;
  if (select count(distinct value->>'order_item_id') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then
    raise sqlstate 'PT422' using message = 'DUPLICATE_RETURN_ITEM'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if (v_item->>'quantity')::numeric <= 0 or (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric) then
      raise sqlstate 'PT422' using message = 'INVALID_RETURN_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    select * into v_order_item from public.order_item where item_id = (v_item->>'order_item_id')::uuid and order_id = v_order.order_id;
    if not found then raise sqlstate 'PT422' using message = 'ORDER_ITEM_MISMATCH'; end if;
    select * into v_holds from public.velura_return_item_holds(v_order_item.item_id);
    if v_holds.open_requests > 0 then raise sqlstate 'PT422' using message = 'ITEM_RETURN_IN_PROGRESS'; end if;
    if v_holds.attempts >= 2 then raise sqlstate 'PT422' using message = 'RETURN_LIMIT_REACHED'; end if;
    if v_holds.held_quantity + v_qty > v_order_item.quantity then raise sqlstate 'PT422' using message = 'RETURN_QUANTITY_EXCEEDED'; end if;
    if nullif(v_item->>'replacement_variant_id', '') is not null and not exists(
      select 1 from public.variant replacement join public.variant original on original.variant_id = v_order_item.variant_id
      where replacement.variant_id = (v_item->>'replacement_variant_id')::uuid and replacement.product_id = original.product_id
    ) then raise sqlstate 'PT422' using message = 'EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
  end loop;
  insert into public.return_exchange(order_id, user_id, return_type, status, description, evidence_images, tracking_return_code)
    values(v_order.order_id, v_order.user_id, (p_payload->>'return_type')::public.return_type, 'REQUESTED',
      p_payload->>'description', array(select jsonb_array_elements_text(coalesce(p_payload->'evidence_images', '[]'::jsonb))),
      'RET' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))) returning * into v_return;
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.return_item(return_id, order_item_id, quantity, replacement_variant_id)
      values(v_return.return_id, (v_item->>'order_item_id')::uuid, (v_item->>'quantity')::integer,
        nullif(v_item->>'replacement_variant_id', '')::uuid);
  end loop;
  insert into public.return_event(return_id, new_status, actor_id, actor_type, note)
    values(v_return.return_id, 'REQUESTED', v_order.user_id, 'customer', v_return.description);
  return to_jsonb(v_return) || jsonb_build_object('items', (select jsonb_agg(to_jsonb(ri)) from public.return_item ri where ri.return_id = v_return.return_id));
end; $$;
revoke all on function public.velura_create_return_request(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.velura_create_return_request(jsonb, jsonb) to service_role;

-- 045 guard plus: NEEDS_SUPPORT may be closed (CSKH stops forwarding a request the warehouse could not accept),
-- and every cancellation carries a reason, an owner and no leftover approved refund amount.
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

commit;
