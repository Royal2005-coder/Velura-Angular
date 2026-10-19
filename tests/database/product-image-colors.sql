-- Disposable/local database only, after migration 063. All fixtures roll back.
\set ON_ERROR_STOP on
begin;
insert into public.users(user_id,email,full_name,role,admin_role,is_active) values
('61000000-0000-4000-8000-000000000001','image-colors@example.invalid','Image colors','admin','admin_operator_sanpham',true);
insert into public.category(category_id,name,slug) values
('61000000-0000-4000-8000-000000000010','Image colors','image-colors-test');
select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

create function pg_temp.save_colors(p_id uuid,p_version integer,p_images text[] default null,p_colors jsonb default null)
returns jsonb language sql as $$
select public.admin_update_product(p_id,null,null,null,null,null,null,p_images,null,null,null,null,null,null,null,null,null,null,p_version,'127.0.0.1',p_colors);
$$;

do $$
declare
  v_actor uuid := '61000000-0000-4000-8000-000000000001';
  v_approval uuid := '61000000-0000-4000-8000-000000000020';
  v_url text := 'https://storage.example/storage/v1/object/public/product-images/ai-reviewed/61000000-0000-4000-8000-000000000020.png';
  v_product jsonb;
  v_id uuid;
  v_message text;
begin
  perform public.velura_stage_image_approval(v_approval,v_actor,null,0,'61000000-0000-4000-8000-000000000030',
    'original',v_url,repeat('a',64),repeat('a',64),'cpu-quality-v2',
    '{"valid":true,"metrics":{"brightness":120,"sharpness":40,"background_score":0.8}}',now()+interval '1 hour','127.0.0.1');
  begin
    perform public.admin_create_product('VL-COLOR01','Image colors','image-colors',null,
      '61000000-0000-4000-8000-000000000010',null,100,100,array[v_url],'{}',null,'{}','{}',
      'hidden',false,false,null,null,null,0,'127.0.0.1',jsonb_build_object(v_url,'Missing'),
      '[{"color":"Đen","size":"M","stockQuantity":4}]');
    raise exception 'Unknown variant color was accepted';
  exception when sqlstate 'PT422' then null;
  end;
  if exists(select 1 from public.product where sku='VL-COLOR01') then raise exception 'Failed atomic create left a product'; end if;
  if (select consumed_at from public.product_image_approval where approval_id=v_approval) is not null then raise exception 'Failed mapping consumed approval'; end if;
  v_product := public.admin_create_product('VL-COLOR01','Image colors','image-colors',null,
    '61000000-0000-4000-8000-000000000010',null,100,100,array[v_url],'{}','Warm','{}',array['Hourglass'],
    'hidden',false,false,null,null,null,0,'127.0.0.1',jsonb_build_object(v_url,'Đen'),
    '[{"color":"Đen","size":"M","stockQuantity":4}]');
  v_id := (v_product->>'product_id')::uuid;
  if v_product->'image_colors' is distinct from jsonb_build_object(v_url,'Đen') then raise exception 'Association did not round trip'; end if;
  if not exists(select 1 from public.variant where product_id=v_id and color='Đen' and stock_quantity=4) then raise exception 'Atomic variants missing'; end if;
  perform pg_temp.save_colors(v_id,1);
  if (select image_colors from public.product where product_id=v_id) is distinct from jsonb_build_object(v_url,'Đen') then raise exception 'Metadata save lost associations'; end if;
  if (select color_tone::text from public.product where product_id=v_id) is distinct from 'Warm'
    or (select suitable_body_shapes::text[] from public.product where product_id=v_id) is distinct from array['Hourglass'] then
    raise exception 'Create/metadata save changed typed catalog fields';
  end if;
  begin
    perform pg_temp.save_colors(v_id,2,null,jsonb_build_object('https://missing.test/image.jpg','Đen'));
    raise exception 'Orphan image association was accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform pg_temp.save_colors(v_id,2,null,jsonb_build_object(v_url,''));
    raise exception 'Empty color association was accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform pg_temp.save_colors(v_id,2,array_fill(v_url,array[21]));
    raise exception 'Image limit was not enforced';
  exception when sqlstate 'PT422' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'IMAGE_LIMIT_EXCEEDED' then raise exception 'Wrong limit error: %',v_message; end if;
  end;
  begin
    delete from public.variant where product_id=v_id;
    raise exception 'Last associated color could be removed';
  exception when sqlstate 'PT422' then null;
  end;
  perform pg_temp.save_colors(v_id,2,'{}');
  if (select image_colors from public.product where product_id=v_id) <> '{}'::jsonb then raise exception 'Image removal retained stale associations'; end if;
  begin
    perform public.admin_change_product_status(v_id,'on_sale','Publish product after review',3,'127.0.0.1');
    raise exception 'Image-less product could be published';
  exception when sqlstate 'PT422' then null;
  end;
end;
$$;
rollback;
