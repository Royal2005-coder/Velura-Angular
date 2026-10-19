-- Disposable/local database only, after migrations 063 and 064. Every mutation rolls back.
\set ON_ERROR_STOP on
begin;
insert into public.users(user_id,email,full_name,role,admin_role,is_active) values
('62000000-0000-4000-8000-000000000001','product-status@example.invalid','Product status','admin','admin_operator_sanpham',true);
insert into public.category(category_id,name,slug) values
('62000000-0000-4000-8000-000000000010','Product status','product-status-test');
select set_config('request.jwt.claim.sub','62000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"62000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

do $$
declare
  v_actor uuid := '62000000-0000-4000-8000-000000000001';
  v_approval uuid := '62000000-0000-4000-8000-000000000020';
  v_url text := 'https://storage.example/storage/v1/object/public/product-images/ai-reviewed/62000000-0000-4000-8000-000000000020.png';
  v_product jsonb;
  v_original jsonb;
  v_variants jsonb;
  v_current_variants jsonb;
  v_input jsonb;
  v_id uuid;
  v_variant uuid;
  v_version integer;
  v_status text;
  v_message text;
  v_order_count bigint;
begin
  perform public.velura_stage_image_approval(v_approval,v_actor,null,0,'62000000-0000-4000-8000-000000000030',
    'original',v_url,repeat('a',64),repeat('a',64),'cpu-quality-v2',
    '{"valid":true,"metrics":{"brightness":120,"sharpness":40,"background_score":0.8}}',now()+interval '1 hour','127.0.0.1');
  v_product := public.admin_create_product('VL-STATUS01','Status garment','product-status-garment',null,
    '62000000-0000-4000-8000-000000000010',null,500000,450000,array[v_url],'{}',null,'{}','{}',
    'on_sale',false,false,null,null,null,0,'127.0.0.1','{}',
    '[{"sku":"VL-STATUS01-M","color":"Black","size":"M","stockQuantity":50,"lowStockThreshold":5},
      {"sku":"VL-STATUS01-L","color":"Black","size":"L","stockQuantity":30,"lowStockThreshold":7}]');
  v_id := (v_product->>'product_id')::uuid;
  v_original := v_product - array['status','version','updated_at'];
  select jsonb_agg(to_jsonb(v) order by v.variant_id) into v_variants from public.variant v where product_id=v_id;
  if jsonb_array_length(v_variants) <> 2 then raise exception 'Expected two distinct variants'; end if;
  select variant_id into v_variant from public.variant where product_id=v_id and size='M';
  select count(*) into v_order_count from public.orders;
  v_input := jsonb_build_object('userId',v_actor,'paymentMethod','COD','items',
    jsonb_build_array(jsonb_build_object('variantId',v_variant,'quantity',1)));
  v_version := (v_product->>'version')::integer;
  foreach v_status in array array['hidden','discontinued','on_sale'] loop
    v_product := public.admin_change_product_status(v_id,v_status,'Operator status cycle regression',v_version,'127.0.0.1');
    v_version := v_version + 1;
    if (v_product->>'version')::integer <> v_version or v_product->>'status' <> v_status then
      raise exception 'Status must change in one versioned transaction';
    end if;
    if (v_product - array['status','version','updated_at']) is distinct from v_original then
      raise exception 'Status changed product identity, prices, images or other business fields';
    end if;
    if v_status in ('hidden','discontinued') then
      -- This private commerce RPC is the exact transaction invoked by the public loyalty checkout wrapper.
      -- The quote can have been valid before the admin changed visibility.
      begin
        perform public.velura_create_checkout_order_commerce(v_input);
        raise exception 'Unavailable product with positive stock was purchasable';
      exception when sqlstate 'PT409' then
        get stacked diagnostics v_message = message_text;
        if v_message <> 'PRODUCT_UNAVAILABLE' then raise exception 'Wrong checkout rejection: %',v_message; end if;
      end;
      if (select count(*) from public.orders) <> v_order_count then raise exception 'Rejected checkout persisted an order'; end if;
    end if;
    select jsonb_agg(to_jsonb(v) order by v.variant_id) into v_current_variants from public.variant v where product_id=v_id;
    if v_current_variants is distinct from v_variants then
      raise exception 'Status cycle or rejected checkout mutated complete variant records';
    end if;
  end loop;
  if (select stock_quantity from public.variant where product_id=v_id and size='M') <> 50
    or (select stock_quantity from public.variant where product_id=v_id and size='L') <> 30 then
    raise exception 'Stock 50/30 changed after status cycle';
  end if;
end;
$$;
rollback;
