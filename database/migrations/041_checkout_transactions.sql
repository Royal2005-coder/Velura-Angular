-- KAN-58: one checkout commits its order, stock reservation and voucher usage together.
alter table public.orders
  add column if not exists is_guest boolean,
  add column if not exists shipping_email text,
  add column if not exists checkout_request_key text,
  add column if not exists stock_reserved_at timestamptz,
  add column if not exists stock_reservation_released_at timestamptz;
alter table public.payment add column if not exists refunded_amount numeric not null default 0, add column if not exists gateway_session_id text;

update public.orders o set is_guest = (o.user_id is null or exists (
  select 1 from public.users u where u.user_id = o.user_id
    and (u.is_active is false or u.role::text = 'guest' or u.email like '%@guest.%')
)) where o.is_guest is null;
create unique index if not exists orders_checkout_request_uq
  on public.orders(user_id, checkout_request_key) where checkout_request_key is not null;
update public.payment set refunded_amount = coalesce(refund_amount, amount)
  where payment_status::text = 'refunded' and refunded_amount = 0;

create or replace function public.velura_create_checkout_order(p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_order public.orders%rowtype;
  v_variant public.variant%rowtype;
  v_voucher public.voucher%rowtype;
  v_promo public.promotion%rowtype;
  v_item jsonb;
  v_items jsonb;
  v_id uuid;
  v_key text := nullif(left(p_input->>'idempotencyKey', 128), '');
  v_method text := p_input->>'paymentMethod';
  v_qty integer;
begin
  if v_method not in ('COD', 'ONLINE_PAYMENT') then raise sqlstate 'PT422' using message = 'INVALID_PAYMENT_METHOD'; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended((p_input->>'userId') || ':' || v_key, 0));
    select * into v_order from public.orders where user_id = (p_input->>'userId')::uuid and checkout_request_key = v_key;
    if found then
      select coalesce(jsonb_agg(to_jsonb(oi)), '[]'::jsonb) into v_items from public.order_item oi where order_id = v_order.order_id;
      return jsonb_build_object('order', to_jsonb(v_order), 'items', v_items);
    end if;
  end if;
  if jsonb_typeof(p_input->'items') <> 'array' or jsonb_array_length(p_input->'items') < 1 then
    raise sqlstate 'PT422' using message = 'ORDER_ITEMS_REQUIRED';
  end if;
  if (select count(*) <> count(distinct x->>'variantId') from jsonb_array_elements(p_input->'items') x) then
    raise sqlstate 'PT422' using message = 'DUPLICATE_VARIANT';
  end if;
  for v_item in select x from jsonb_array_elements(p_input->'items') x order by x->>'variantId' loop
    if coalesce(v_item->>'quantity', '') !~ '^[1-9][0-9]*$' then raise sqlstate 'PT422' using message = 'INVALID_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    select * into v_variant from public.variant where variant_id = (v_item->>'variantId')::uuid for update;
    if not found then raise sqlstate 'PT404' using message = 'VARIANT_NOT_FOUND'; end if;
    if v_variant.stock_quantity - coalesce(v_variant.reserved_quantity, 0) < v_qty then
      raise sqlstate 'PT409' using message = 'INSUFFICIENT_STOCK';
    end if;
  end loop;
  if (p_input->>'totalAmount')::numeric <> greatest(0,
       (p_input->>'subtotal')::numeric + (p_input->>'shippingFee')::numeric - (p_input->>'discountAmount')::numeric) then
    raise sqlstate 'PT422' using message = 'ORDER_TOTAL_MISMATCH';
  end if;
  if nullif(p_input->>'voucherId', '') is not null then
    select * into v_voucher from public.voucher where voucher_id = (p_input->>'voucherId')::uuid for update;
    if not found or not v_voucher.is_active or
       (v_voucher.usage_limit_total is not null and v_voucher.used_count >= v_voucher.usage_limit_total) then
      raise sqlstate 'PT409' using message = 'VOUCHER_CHANGED';
    end if;
    if v_voucher.usage_limit_per_user is not null and (
      select count(*) from public.orders where user_id = (p_input->>'userId')::uuid
        and voucher_id = v_voucher.voucher_id and status::text <> 'cancelled'
    ) >= v_voucher.usage_limit_per_user then raise sqlstate 'PT409' using message = 'VOUCHER_CHANGED'; end if;
    if v_voucher.promo_id is not null then
      select * into v_promo from public.promotion where promo_id = v_voucher.promo_id for update;
      if not found or not v_promo.is_active or (coalesce(v_promo.budget_limit, 0) > 0 and
        coalesce(v_promo.total_discount_issued, 0) + (p_input->>'discountAmount')::numeric > v_promo.budget_limit) then
        raise sqlstate 'PT409' using message = 'VOUCHER_CHANGED';
      end if;
    end if;
  end if;
  insert into public.orders(user_id, is_guest, checkout_request_key, status, shipping_name, shipping_phone, shipping_email,
    shipping_address, shipping_fee, voucher_id, discount_amount, subtotal, total_amount, payment_method,
    order_code, internal_note, stock_committed_at, stock_reserved_at, created_at, updated_at)
  values ((p_input->>'userId')::uuid, coalesce((p_input->>'isGuest')::boolean, false), v_key,
    (case when v_method = 'COD' then 'pending' else 'waiting_payment' end)::public.order_status,
    p_input#>>'{contact,fullName}', p_input#>>'{contact,phone}', p_input#>>'{contact,email}', p_input->>'shippingAddress',
    (p_input->>'shippingFee')::numeric, nullif(p_input->>'voucherId', '')::uuid,
    (p_input->>'discountAmount')::numeric, (p_input->>'subtotal')::numeric, (p_input->>'totalAmount')::numeric,
    v_method::public.payment_method, p_input->>'orderCode', p_input->>'internalNote',
    case when v_method = 'COD' then now() end, case when v_method <> 'COD' then now() end, now(), now())
  returning * into v_order;
  for v_item in select x from jsonb_array_elements(p_input->'items') x order by x->>'variantId' loop
    v_id := (v_item->>'variantId')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    insert into public.order_item(order_id, variant_id, product_name, product_image, quantity, unit_price, subtotal_item)
    values (v_order.order_id, v_id, v_item->>'productName', nullif(v_item->>'productImage', ''), v_qty,
      (v_item->>'unitPrice')::numeric, (v_item->>'subtotal')::numeric);
    update public.variant set stock_quantity = stock_quantity - case when v_method = 'COD' then v_qty else 0 end,
      reserved_quantity = coalesce(reserved_quantity, 0) + case when v_method <> 'COD' then v_qty else 0 end,
      version = version + 1, updated_at = now() where variant_id = v_id;
  end loop;
  if v_voucher.voucher_id is not null then
    perform public.velura_record_voucher_redemption(v_voucher.voucher_id, (p_input->>'discountAmount')::numeric);
  end if;
  select coalesce(jsonb_agg(to_jsonb(oi)), '[]'::jsonb) into v_items from public.order_item oi where order_id = v_order.order_id;
  return jsonb_build_object('order', to_jsonb(v_order), 'items', v_items);
end; $$;
revoke all on function public.velura_create_checkout_order(jsonb) from public, anon, authenticated;
grant execute on function public.velura_create_checkout_order(jsonb) to service_role;

-- Switching to COD does not trust a client payment result and must not overlap an open Stripe session.
create or replace function public.velura_switch_order_to_cod(p_order_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_order public.orders%rowtype; v_item record;
begin
  select * into v_order from public.orders where order_id = p_order_id for update;
  if not found then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_order.status::text <> 'waiting_payment' or v_order.payment_method::text <> 'ONLINE_PAYMENT' then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_ACTION';
  end if;
  if exists(select 1 from public.payment where order_id = p_order_id and payment_status::text in ('paid', 'refund_pending', 'refunded')) then
    raise sqlstate 'PT422' using message = 'PAYMENT_ALREADY_PAID';
  end if;
  if exists(select 1 from public.payment where order_id = p_order_id and payment_provider = 'stripe'
    and payment_status::text = 'pending' and created_at > now() - interval '31 minutes') then
    raise sqlstate 'PT409' using message = 'PAYMENT_SESSION_OPEN';
  end if;
  for v_item in select oi.variant_id, sum(oi.quantity)::integer as quantity from public.order_item oi
    where oi.order_id = p_order_id group by oi.variant_id order by oi.variant_id loop
    perform 1 from public.variant where variant_id = v_item.variant_id for update;
    if exists(select 1 from public.variant where variant_id = v_item.variant_id and stock_quantity < v_item.quantity) then
      raise sqlstate 'PT409' using message = 'INSUFFICIENT_STOCK';
    end if;
    update public.variant set stock_quantity = stock_quantity - v_item.quantity,
      reserved_quantity = greatest(0, reserved_quantity - case when v_order.stock_reserved_at is not null then v_item.quantity else 0 end),
      version = version + 1, updated_at = now() where variant_id = v_item.variant_id;
  end loop;
  update public.orders set status = 'pending', payment_method = 'COD', stock_committed_at = now(),
    stock_reservation_released_at = now(), version = version + 1, updated_at = now()
    where order_id = p_order_id returning * into v_order;
  update public.payment set payment_status = 'failed', gateway_response_code = 'SWITCHED_TO_COD',
    version = version + 1, updated_at = now() where order_id = p_order_id and payment_status::text = 'pending';
  insert into public.order_status_history(order_id, old_status, new_status, trigger_type, changed_by, changed_at, note)
    values(p_order_id, 'waiting_payment', 'pending', 'system', v_order.user_id, now(), 'Customer switched unpaid order to COD');
  return to_jsonb(v_order);
end; $$;
revoke all on function public.velura_switch_order_to_cod(uuid, integer) from public, anon, authenticated;
grant execute on function public.velura_switch_order_to_cod(uuid, integer) to service_role;

-- Stable customer classification and reservation release extend the established state machine.
create or replace function public.velura_order_apply_action(
  p_order_id uuid,
  p_action text,
  p_actor_type text,
  p_actor_id uuid,
  p_actor_role text,
  p_note text,
  p_payload jsonb,
  p_expected_version integer,
  p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  v_rule jsonb;
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_payment public.payment%rowtype;
  v_to text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_item record;
  v_refund_required boolean := false;
  v_restock boolean := false;
  v_event_id uuid;
begin
  select r into v_rule from jsonb_array_elements(public.velura_order_action_rules()) r
  where r->>'code' = p_action;
  if v_rule is null then raise sqlstate 'PT422' using message = 'UNKNOWN_ORDER_ACTION'; end if;
  if (v_rule->>'actor' = 'order_admin' and p_actor_type <> 'manual')
     or (v_rule->>'actor' <> 'order_admin' and p_actor_type = 'manual') then
    raise sqlstate 'PT403' using message = 'ACTION_NOT_ALLOWED_FOR_ACTOR';
  end if;
  if (v_rule->>'requiresNote')::boolean and (v_note is null or length(v_note) < 5) then
    raise sqlstate 'PT422' using message = 'NOTE_REQUIRED';
  end if;

  -- AC-19: kiểm theo trạng thái mới nhất trong cơ sở dữ liệu, không theo màn hình.
  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if p_expected_version is not null and v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if not (v_rule->'from') ? v_before.status::text then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_ACTION';
  end if;

  select * into v_payment from public.payment
  where order_id = p_order_id order by created_at desc limit 1 for update;

  -- Guard, cùng mã lỗi với `actionGuard` phía API.
  if p_action in ('confirm_cod', 'auto_confirm_cod') and v_before.payment_method::text <> 'COD' then
    raise sqlstate 'PT422' using message = 'COD_ONLY';
  end if;

  -- Quy trình 3.1.11 (AD_ORDER_04, AD_ORDER_05): Khách vãng lai COD >= 1.000.000đ
  -- bắt buộc phải gọi điện xác nhận và có kết quả "reached" trước khi được phép duyệt đơn.
  if p_action = 'confirm_cod' and v_before.total_amount >= 1000000 then
    if not exists (
      select 1 from public.order_event oe
      where oe.order_id = p_order_id
        and oe.action = 'call_confirm'
        and coalesce(oe.payload->>'call_result', '') = 'reached'
    ) then
      raise sqlstate 'PT422' using message = 'CALL_CONFIRMATION_REQUIRED';
    end if;
  end if;

  if p_action = 'auto_confirm_cod' and (
       v_before.total_amount >= 1000000
       or v_before.created_at > (now() at time zone 'utc') - interval '24 hours') then
    raise sqlstate 'PT422' using message = 'AUTO_CONFIRM_NOT_DUE';
  end if;
  if p_action in ('to_waiting_payment', 'payment_succeeded', 'payment_expired')
     and v_before.payment_method::text <> 'ONLINE_PAYMENT' then
    raise sqlstate 'PT422' using message = 'ONLINE_ONLY';
  end if;
  if p_action = 'payment_expired' and v_before.created_at > (now() at time zone 'utc') - interval '24 hours' then
    raise sqlstate 'PT422' using message = 'PAYMENT_NOT_EXPIRED';
  end if;
  if p_action = 'payment_expired' and exists (
    select 1 from public.payment p where p.order_id = p_order_id and p.payment_status::text = 'paid'
  ) then
    raise sqlstate 'PT422' using message = 'PAYMENT_ALREADY_PAID';
  end if;
  if p_action = 'confirm_handover' then
    if nullif(btrim(coalesce(v_before.tracking_code, '')), '') is null then
      raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
    end if;
    if v_before.shipment_voided_at is not null then raise sqlstate 'PT422' using message = 'SHIPMENT_VOIDED'; end if;
  end if;
  if p_action in ('cancel', 'customer_cancel') and v_before.handed_over_at is not null then
    raise sqlstate 'PT422' using message = 'ORDER_ALREADY_HANDED_OVER';
  end if;
  if p_action = 'confirm_return_to_stock' and v_before.returned_to_stock_at is not null then
    raise sqlstate 'PT422' using message = 'ALREADY_RETURNED_TO_STOCK';
  end if;
  if p_action = 'retry_refund' and not (
       v_payment.payment_status::text = 'refund_pending' and v_payment.gateway_response_code = 'REFUND_FAILED') then
    raise sqlstate 'PT422' using message = 'REFUND_NOT_RETRYABLE';
  end if;
  if p_action = 'call_confirm'
     and coalesce(v_payload->>'call_result', '') not in ('reached', 'no_answer', 'customer_requests_cancel') then
    raise sqlstate 'PT422' using message = 'CALL_RESULT_REQUIRED';
  end if;
  if p_action = 'record_shortage' and nullif(btrim(coalesce(v_payload->>'shortage', '')), '') is null then
    raise sqlstate 'PT422' using message = 'SHORTAGE_REQUIRED';
  end if;
  if p_action in ('upsert_shipment', 'update_tracking')
     and nullif(btrim(coalesce(v_payload->>'tracking_code', '')), '') is null then
    raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
  end if;
  if p_action = 'cancel' and nullif(btrim(coalesce(v_payload->>'cancel_reason', '')), '') is null then
    raise sqlstate 'PT422' using message = 'CANCEL_REASON_REQUIRED';
  end if;

  v_to := coalesce(v_rule->>'to', v_before.status::text);
  if p_action in ('cancel', 'customer_cancel', 'payment_expired') and v_before.stock_committed_at is null
     and v_before.stock_reserved_at is not null and v_before.stock_reservation_released_at is null then
    for v_item in select oi.variant_id, sum(oi.quantity)::integer as quantity from public.order_item oi
      where oi.order_id = p_order_id group by oi.variant_id order by oi.variant_id loop
      update public.variant set reserved_quantity = greatest(0, reserved_quantity - v_item.quantity),
        version = version + 1, updated_at = now() where variant_id = v_item.variant_id;
    end loop;
  end if;

  -- Trả kho: huỷ đơn và xác nhận hoàn kho. Chỉ khi kho đã trừ và chưa trả.
  v_restock := p_action in ('cancel', 'customer_cancel', 'payment_expired', 'confirm_return_to_stock')
               and v_before.stock_committed_at is not null and v_before.stock_returned_at is null;
  if v_restock then
    perform 1 from public.variant v
    where v.variant_id in (select oi.variant_id from public.order_item oi where oi.order_id = p_order_id)
    order by v.variant_id for update;
    for v_item in
      select oi.variant_id, sum(oi.quantity)::integer as quantity
      from public.order_item oi where oi.order_id = p_order_id group by oi.variant_id
    loop
      update public.variant
      set stock_quantity = stock_quantity + v_item.quantity,
          reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0),
          version = version + 1, updated_at = now()
      where variant_id = v_item.variant_id;
    end loop;
  end if;

  -- Trừ kho khi tiền về, trong cùng giao dịch. Trước đây API trừ từng dòng một sau khi
  -- đổi payment, không khoá dòng biến thể.
  if p_action = 'payment_succeeded' and v_before.stock_committed_at is null then
    perform 1 from public.variant v
    where v.variant_id in (select oi.variant_id from public.order_item oi where oi.order_id = p_order_id)
    order by v.variant_id for update;
    for v_item in
      select oi.variant_id, sum(oi.quantity)::integer as quantity
      from public.order_item oi where oi.order_id = p_order_id group by oi.variant_id
    loop
      if exists(select 1 from public.variant where variant_id = v_item.variant_id and stock_quantity < v_item.quantity) then
        raise sqlstate 'PT409' using message = 'INSUFFICIENT_STOCK';
      end if;
      update public.variant
      set stock_quantity = stock_quantity - v_item.quantity,
          reserved_quantity = greatest(0, reserved_quantity - case when v_before.stock_reserved_at is not null and v_before.stock_reservation_released_at is null then v_item.quantity else 0 end),
          version = version + 1, updated_at = now()
      where variant_id = v_item.variant_id;
    end loop;
  end if;

  update public.orders set
    status = v_to::public.order_status,
    stock_reservation_released_at = case when p_action in ('payment_succeeded', 'cancel', 'customer_cancel', 'payment_expired')
      and stock_reserved_at is not null then coalesce(stock_reservation_released_at, now()) else stock_reservation_released_at end,
    cancelled_reason = case when v_to = 'cancelled'
      then coalesce(nullif(btrim(coalesce(v_payload->>'cancel_reason', '')), ''), v_note,
                    case when p_action = 'payment_expired' then 'Hết hạn thanh toán sau 24 giờ' end,
                    cancelled_reason)
      else cancelled_reason end,
    stock_committed_at = case when p_action = 'payment_succeeded' then coalesce(stock_committed_at, now()) else stock_committed_at end,
    stock_returned_at = case when v_restock then now() else stock_returned_at end,
    returned_to_stock_at = case when p_action = 'confirm_return_to_stock' then now() else returned_to_stock_at end,
    tracking_code = case when p_action in ('upsert_shipment', 'update_tracking') then btrim(v_payload->>'tracking_code') else tracking_code end,
    carrier = case when p_action in ('upsert_shipment', 'update_tracking') and nullif(btrim(coalesce(v_payload->>'carrier', '')), '') is not null
                   then btrim(v_payload->>'carrier') else carrier end,
    tracking_url = case when p_action in ('upsert_shipment', 'update_tracking')
                        then nullif(btrim(coalesce(v_payload->>'tracking_url', '')), '') else tracking_url end,
    shipment_created_at = case when p_action = 'upsert_shipment' then coalesce(shipment_created_at, now()) else shipment_created_at end,
    shipment_voided_at = case
      when p_action = 'upsert_shipment' then null
      when v_to = 'cancelled' and shipment_created_at is not null and handed_over_at is null then now()
      else shipment_voided_at end,
    handed_over_at = case when p_action = 'confirm_handover' then now() else handed_over_at end,
    delivered_at = case when p_action = 'carrier_delivered' then now() else delivered_at end,
    version = version + 1,
    updated_at = now()
  where order_id = p_order_id
  returning * into v_after;

  -- Huỷ đơn đã trả tiền: payment chờ hoàn, API gọi Stripe sau khi giao dịch chốt.
  if v_to = 'cancelled' and v_payment.payment_status::text = 'paid' then
    update public.payment
    set payment_status = 'refund_pending', refund_amount = amount,
        refund_reason = coalesce(v_after.cancelled_reason, v_note),
        gateway_response_code = 'REFUND_REQUESTED',
        version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
    v_refund_required := v_payment.payment_provider = 'stripe';
  end if;
  if p_action = 'retry_refund' then
    update public.payment
    set gateway_response_code = 'REFUND_REQUESTED', version = version + 1, updated_at = now()
    where payment_id = v_payment.payment_id;
    v_refund_required := true;
  end if;

  insert into public.order_event (
    order_id, action, actor_type, actor_id, actor_role, from_status, to_status, result, note, payload
  ) values (
    p_order_id, p_action,
    case when p_actor_type = 'manual' then 'manual'::public.trigger_type else 'system'::public.trigger_type end,
    p_actor_id, p_actor_role, v_before.status, v_after.status, 'success', v_note,
    v_payload || jsonb_build_object('actor', p_actor_type)
  ) returning event_id into v_event_id;
  update public.order_event set created_at = clock_timestamp() where event_id = v_event_id;

  if v_after.status <> v_before.status then
    insert into public.order_status_history (
      history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
    ) values (
      gen_random_uuid(), p_order_id, v_before.status, v_after.status,
      case when p_actor_type = 'manual' then 'manual'::public.trigger_type else 'system'::public.trigger_type end,
      p_actor_id, clock_timestamp() at time zone 'utc',
      coalesce(v_note, v_rule->>'code')
    );
  end if;

  if p_actor_type = 'manual' then
    perform public.velura_append_module_audit(
      'orders', p_actor_id, p_actor_role, 'update', p_order_id,
      jsonb_build_object('action', p_action, 'status', v_before.status, 'version', v_before.version),
      jsonb_build_object('action', p_action, 'status', v_after.status, 'version', v_after.version, 'note', v_note),
      p_ip_address
    );
  end if;

  if v_after.status <> v_before.status then
    perform public.velura_enqueue_order_email(
      (select email from public.users where user_id = v_after.user_id),
      case when v_after.status::text = 'cancelled' then 'order_cancelled' else 'order_status_changed' end,
      'Cap nhat don hang',
      format('Don hang %s da chuyen sang trang thai %s.', p_order_id, v_after.status::text),
      v_after.user_id,
      jsonb_build_object('order_id', p_order_id, 'status', v_after.status::text)
    );
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_after),
    'event_id', v_event_id,
    'refund_required', v_refund_required,
    'payment_id', v_payment.payment_id
  );
end; $$;

revoke all on function public.velura_order_apply_action(uuid, text, text, uuid, text, text, jsonb, integer, text)
  from public, anon, authenticated;
