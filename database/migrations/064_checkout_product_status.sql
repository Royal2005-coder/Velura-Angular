-- A visibility change never changes inventory, and positive stock alone cannot authorize checkout.
-- Keep the loyalty wrapper from 050; replace only its private commerce transaction from 041.
begin;

create or replace function public.velura_create_checkout_order_commerce(p_input jsonb)
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
    -- Serialize with status updates, including an admin hiding a product after the price quote.
    perform 1 from public.product where product_id = v_variant.product_id and status::text = 'on_sale' for share;
    if not found then raise sqlstate 'PT409' using message = 'PRODUCT_UNAVAILABLE'; end if;
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
      if not found or not v_promo.is_active or now() < v_promo.start_date or now() > v_promo.end_date then
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

revoke all on function public.velura_create_checkout_order_commerce(jsonb) from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
