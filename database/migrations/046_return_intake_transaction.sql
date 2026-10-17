-- KAN-58: item quotas and request creation serialize on the original order.
create or replace function public.velura_create_return_request(p_payload jsonb,p_items jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public,auth as $$
declare v_order public.orders%rowtype; v_return public.return_exchange%rowtype;
  v_item jsonb; v_order_item public.order_item%rowtype; v_qty integer; v_attempts integer; v_existing integer;
begin
  select * into v_order from public.orders where order_id = (p_payload->>'order_id')::uuid for update;
  if not found or v_order.user_id::text is distinct from p_payload->>'user_id' then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.status::text <> 'delivered' or coalesce(v_order.delivered_at,v_order.updated_at,v_order.created_at) < now()-interval '30 days' then
    raise sqlstate 'PT422' using message = 'RETURN_WINDOW_CLOSED'; end if;
  if p_payload->>'return_type' not in ('refund','exchange') or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items)=0 then raise sqlstate 'PT422' using message = 'INVALID_RETURN_ITEMS'; end if;
  if (select count(distinct value->>'order_item_id') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then
    raise sqlstate 'PT422' using message = 'DUPLICATE_RETURN_ITEM'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if (v_item->>'quantity')::numeric <= 0 or (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric) then
      raise sqlstate 'PT422' using message = 'INVALID_RETURN_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    select * into v_order_item from public.order_item where item_id=(v_item->>'order_item_id')::uuid and order_id=v_order.order_id;
    if not found then raise sqlstate 'PT422' using message='ORDER_ITEM_MISMATCH'; end if;
    select count(distinct r.return_id),coalesce(sum(ri.quantity),0) into v_attempts,v_existing
      from public.return_item ri join public.return_exchange r on r.return_id=ri.return_id
      where ri.order_item_id=v_order_item.item_id and r.status::text <> 'CANCELLED';
    if v_attempts>=2 then raise sqlstate 'PT422' using message='RETURN_LIMIT_REACHED'; end if;
    if v_existing+v_qty>v_order_item.quantity then raise sqlstate 'PT422' using message='RETURN_QUANTITY_EXCEEDED'; end if;
    if nullif(v_item->>'replacement_variant_id','') is not null and not exists(
      select 1 from public.variant replacement join public.variant original on original.variant_id=v_order_item.variant_id
      where replacement.variant_id=(v_item->>'replacement_variant_id')::uuid and replacement.product_id=original.product_id
    ) then raise sqlstate 'PT422' using message='EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
  end loop;
  insert into public.return_exchange(order_id,user_id,return_type,status,description,evidence_images,tracking_return_code)
    values(v_order.order_id,v_order.user_id,(p_payload->>'return_type')::public.return_type,'REQUESTED',
      p_payload->>'description',array(select jsonb_array_elements_text(coalesce(p_payload->'evidence_images','[]'::jsonb))),
      'RET'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))) returning * into v_return;
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.return_item(return_id,order_item_id,quantity,replacement_variant_id)
      values(v_return.return_id,(v_item->>'order_item_id')::uuid,(v_item->>'quantity')::integer,
        nullif(v_item->>'replacement_variant_id','')::uuid);
  end loop;
  insert into public.return_event(return_id,new_status,actor_id,actor_type,note)
    values(v_return.return_id,'REQUESTED',v_order.user_id,'customer',v_return.description);
  return to_jsonb(v_return)||jsonb_build_object('items',(select jsonb_agg(to_jsonb(ri)) from public.return_item ri where ri.return_id=v_return.return_id));
end; $$;
revoke all on function public.velura_create_return_request(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.velura_create_return_request(jsonb,jsonb) to service_role;
