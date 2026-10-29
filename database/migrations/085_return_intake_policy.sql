-- KAN-106: one private-evidence intake and original-unit quota for members and verified guests.
begin;

create table if not exists public.return_intake_upload (
  storage_ref text primary key,
  order_id uuid not null references public.orders(order_id),
  storage_bucket text not null check (storage_bucket = 'return-evidence-private'),
  storage_path text not null,
  mime_type text not null,
  kind text not null check (kind in ('request_photo','request_video')),
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  claimed_return_id uuid references public.return_exchange(return_id),
  unique(storage_bucket,storage_path)
);
alter table public.return_intake_upload enable row level security;
revoke all on public.return_intake_upload from public,anon,authenticated;
grant all on public.return_intake_upload to service_role;
alter table public.return_exchange add column if not exists evidence_videos text[] not null default '{}';

create or replace function public.velura_create_return_request(p_payload jsonb,p_items jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public,auth as $$
declare
  v_order public.orders%rowtype; v_return public.return_exchange%rowtype;
  v_item jsonb; v_original public.order_item%rowtype; v_part uuid; v_qty integer;
  v_upload public.return_intake_upload%rowtype; v_ref text; v_kind text; v_reason text;
  v_replacement uuid; v_bank text; v_account text; v_holder text;
begin
  select * into v_order from public.orders where order_id=(p_payload->>'order_id')::uuid for update;
  if not found or v_order.user_id::text is distinct from p_payload->>'user_id' then
    raise sqlstate 'PT404' using message='ORDER_NOT_FOUND'; end if;
  if v_order.status::text <> 'delivered' or v_order.delivered_at is null
    or not isfinite(v_order.delivered_at) or v_order.delivered_at > now()
    or v_order.delivered_at < now()-interval '7 days' then
    raise sqlstate 'PT422' using message='RETURN_WINDOW_CLOSED'; end if;
  if v_order.order_kind='exchange' then raise sqlstate 'PT422' using message='EXCHANGE_REPLACEMENT_NOT_RETURNABLE'; end if;
  if p_payload->>'return_type' is null or p_payload->>'return_type' not in ('refund','exchange')
    or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)=0 then
    raise sqlstate 'PT422' using message='INVALID_RETURN_ITEMS'; end if;
  v_reason := btrim(coalesce(p_payload->>'reason',p_payload->>'description',''));
  if v_reason='' then raise sqlstate 'PT422' using message='RETURN_REASON_REQUIRED'; end if;
  if jsonb_typeof(p_payload->'evidence_images') is distinct from 'array'
    or jsonb_typeof(p_payload->'evidence_videos') is distinct from 'array' then
    raise sqlstate 'PT422' using message='INITIAL_EVIDENCE_REQUIRED'; end if;
  if jsonb_array_length(p_payload->'evidence_images') not between 1 and 5
    or jsonb_array_length(p_payload->'evidence_videos') not between 1 and 3 then
    raise sqlstate 'PT422' using message='INITIAL_EVIDENCE_REQUIRED'; end if;
  if (select count(distinct value->>'order_item_id') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then
    raise sqlstate 'PT422' using message='DUPLICATE_RETURN_ITEM'; end if;

  -- Lock replacement stock in a deterministic order and sum demand across the request.
  perform v.variant_id from public.variant v where v.variant_id in
    (select nullif(value->>'replacement_variant_id','')::uuid from jsonb_array_elements(p_items))
    order by v.variant_id for update;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(v_item->>'quantity','') !~ '^[1-9][0-9]*$' then
      raise sqlstate 'PT422' using message='INVALID_RETURN_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    select * into v_original from public.order_item where item_id=(v_item->>'order_item_id')::uuid and order_id=v_order.order_id for update;
    if not found or v_qty>v_original.quantity then raise sqlstate 'PT422' using message='ORDER_ITEM_MISMATCH'; end if;
    v_replacement := nullif(v_item->>'replacement_variant_id','')::uuid;
    if p_payload->>'return_type'='exchange' and v_replacement is null then
      raise sqlstate 'PT422' using message='REPLACEMENT_REQUIRED'; end if;
    if v_replacement is not null then
      if not exists(select 1 from public.variant replacement join public.variant original on original.variant_id=v_original.variant_id
        where replacement.variant_id=v_replacement and replacement.product_id=original.product_id) then
        raise sqlstate 'PT422' using message='EXCHANGE_SAME_PRODUCT_REQUIRED'; end if;
      if (select greatest(0,coalesce(stock_quantity,0)-coalesce(reserved_quantity,0)) from public.variant where variant_id=v_replacement) <
        (select sum((value->>'quantity')::integer) from jsonb_array_elements(p_items) where value->>'replacement_variant_id'=v_replacement::text) then
        raise sqlstate 'PT422' using message='EXCHANGE_OUT_OF_STOCK'; end if;
    end if;
  end loop;
  v_bank:=btrim(coalesce(p_payload->>'refund_bank_name',''));
  v_account:=regexp_replace(coalesce(p_payload->>'refund_bank_account',''),'[\s-]','','g');
  v_holder:=btrim(coalesce(p_payload->>'refund_bank_holder',''));
  if (v_bank<>'' or v_account<>'' or v_holder<>'') and
    (upper(v_order.payment_method::text)<>'COD' or not public.velura_refund_receiver_valid(v_bank,v_account,v_holder)) then
    raise sqlstate 'PT422' using message='REFUND_RECEIVER_INVALID'; end if;

  insert into public.return_exchange(order_id,user_id,return_type,status,description,evidence_images,evidence_videos,tracking_return_code)
  values(v_order.order_id,v_order.user_id,(p_payload->>'return_type')::public.return_type,'REQUESTED',v_reason,
    array(select jsonb_array_elements_text(p_payload->'evidence_images')),
    array(select jsonb_array_elements_text(p_payload->'evidence_videos')),
    'RET'||upper(replace(gen_random_uuid()::text,'-',''))) returning * into v_return;
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.return_item(return_id,order_item_id,quantity,replacement_variant_id,resolution_type,reason)
      values(v_return.return_id,(v_item->>'order_item_id')::uuid,(v_item->>'quantity')::integer,
        nullif(v_item->>'replacement_variant_id','')::uuid,p_payload->>'return_type',v_reason) returning return_item_id into v_part;
    perform public.velura_reserve_return_units(v_part);
  end loop;
  for v_ref,v_kind in
    select value,'request_photo' from jsonb_array_elements_text(p_payload->'evidence_images')
    union all select value,'request_video' from jsonb_array_elements_text(p_payload->'evidence_videos')
  loop
    select * into v_upload from public.return_intake_upload where storage_ref=v_ref for update;
    if not found or v_upload.order_id<>v_order.order_id or v_upload.claimed_return_id is not null
      or v_upload.kind<>v_kind or v_upload.created_at<now()-interval '24 hours'
      or (v_kind='request_photo' and v_upload.mime_type not in ('image/jpeg','image/png','image/webp','image/gif'))
      or (v_kind='request_video' and v_upload.mime_type not in ('video/mp4','video/webm')) then
      raise sqlstate 'PT422' using message='RETURN_EVIDENCE_OWNERSHIP_REQUIRED'; end if;
    update public.return_intake_upload set claimed_return_id=v_return.return_id where storage_ref=v_ref;
    insert into public.return_evidence(return_id,kind,storage_bucket,storage_path,mime_type,uploaded_by_role,uploaded_by)
      values(v_return.return_id,v_kind,v_upload.storage_bucket,v_upload.storage_path,v_upload.mime_type,'customer',v_upload.uploaded_by);
  end loop;
  if v_bank<>'' then
    insert into public.return_refund_receiver(return_id,bank_name,account_number,account_holder,submitted_at)
      values(v_return.return_id,v_bank,v_account,v_holder,now());
  end if;
  insert into public.return_event(return_id,new_status,actor_id,actor_type,note)
    values(v_return.return_id,'REQUESTED',v_order.user_id,'customer',v_reason);
  return to_jsonb(v_return)||jsonb_build_object('items',(select jsonb_agg(to_jsonb(ri)) from public.return_item ri where return_id=v_return.return_id));
end; $$;
revoke all on function public.velura_create_return_request(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.velura_create_return_request(jsonb,jsonb) to service_role;

create or replace function public.velura_return_unit_availability(p_order_item_id uuid)
returns table(
  order_item_id uuid,
  unit_number integer,
  success_count integer,
  refunded boolean,
  active_return_item_id uuid,
  refundable_amount numeric
) language sql stable security definer set search_path = pg_catalog, public as $$
  select
    u.order_item_id,
    u.unit_number,
    u.success_count,
    u.refunded,
    u.active_return_item_id,
    coalesce(public.velura_original_unit_refundable_amount(u.order_item_id, u.unit_number), 0) as refundable_amount
  from public.return_unit u
  where u.order_item_id = p_order_item_id
  order by u.unit_number;
$$;
revoke all on function public.velura_return_unit_availability(uuid) from public, anon, authenticated;
grant execute on function public.velura_return_unit_availability(uuid) to service_role;

create or replace function public.velura_cancel_customer_return(
  p_return_id uuid,
  p_expected_version integer,
  p_owner_user_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_return public.return_exchange%rowtype;
  v_new public.return_exchange%rowtype;
begin
  select * into v_return from public.return_exchange where return_id = p_return_id for update;
  if not found or (p_owner_user_id is not null and v_return.user_id is distinct from p_owner_user_id) then
    raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND';
  end if;
  if v_return.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_return.status::text not in ('REQUESTED', 'CONTACTING', 'WAITING_RETURN') then
    raise sqlstate 'PT422' using message = 'INVALID_TRANSITION';
  end if;
  perform set_config('app.return_actor_type', 'customer', true);
  update public.return_exchange
    set status = 'CANCELLED',
        rejection_reason = 'Đã hủy bởi khách hàng',
        version = version + 1
    where return_id = p_return_id
    returning * into v_new;
  perform set_config('app.return_actor_type', '', true);
  return to_jsonb(v_new);
end; $$;
revoke all on function public.velura_cancel_customer_return(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.velura_cancel_customer_return(uuid, integer, uuid) to service_role;
commit;
