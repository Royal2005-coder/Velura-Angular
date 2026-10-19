-- Run against an isolated migrated database. All fixtures and writes are rolled back.
begin;
insert into public.users(user_id, email, password_hash, full_name, role, admin_role, is_active)
values('63000000-0000-4000-8000-000000000001', 'csv-regression@velura.test', 'not-a-login', 'CSV regression', 'admin', 'admin_operator_sanpham', true);
select set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-000000000001', true);
insert into public.category(category_id, name, slug) values('63000000-0000-4000-8000-000000000002', 'CSV regression', 'csv-regression');
insert into public.product_image_approval(approval_id, reviewer_id, product_id, expected_version, job_id, selection,
  asset_url, source_revision, image_revision, processing_version, quality_gate, expires_at, ip_address)
values('63000000-0000-4000-8000-000000000003', '63000000-0000-4000-8000-000000000001', null, 0,
  '63000000-0000-4000-8000-000000000004', 'original', '/assets/csv-regression.jpg', repeat('a', 64), repeat('b', 64), 'regression', '{}', now() + interval '1 hour', '127.0.0.1');

do $$
declare
  p public.product%rowtype; v public.variant%rowtype; initial_v jsonb;
  row_existing jsonb; row_new jsonb; result jsonb; before_state jsonb; after_state jsonb; error_detail text;
begin
  result := public.admin_create_product('VL-CSV01', 'CSV garment', 'csv-regression-garment', null,
    '63000000-0000-4000-8000-000000000002', null, 250000, 250000, array['/assets/csv-regression.jpg'],
    '{}', null, '{}', '{}', 'on_sale', false, false, null, null, null, 0, '127.0.0.1', '{}',
    '[{"sku":"VL-CSV01-BL-S","color":"Đen","size":"S","stockQuantity":12}]');
  select * into p from public.product where product_id = (result->>'product_id')::uuid;
  select * into v from public.variant where product_id = p.product_id;
  if v.sku <> 'VL-CSV01-BL-S' then raise exception 'Explicit creation SKU was discarded'; end if;
  update public.variant set reserved_quantity = 4 where variant_id = v.variant_id returning * into v;
  initial_v := to_jsonb(v);
  row_existing := jsonb_build_object('row', 2, 'sku', v.sku, 'name', 'Renamed CSV garment', 'base_price', 250000,
    'sale_price', null, 'category_id', p.category_id, 'product_id', p.product_id, 'expected_version', p.version,
    'variant_id', v.variant_id, 'variant_version', v.version, 'operation', 'updated');
  row_new := jsonb_build_object('row', 3, 'sku', 'VL-CSV01-BL-M', 'product_sku', p.sku, 'name', 'Renamed CSV garment',
    'base_price', 250000, 'category_id', p.category_id, 'product_id', p.product_id, 'expected_version', p.version,
    'color', 'Đen', 'size', 'M', 'stock_quantity', 8, 'operation', 'created');
  result := public.admin_import_product_csv(jsonb_build_array(row_existing, row_new), '127.0.0.1');
  if result->>'updated' <> '1' or result->>'created' <> '1' then raise exception 'Mixed SKU upsert counts incorrect: %', result; end if;
  if (select count(*) from public.variant where product_id = p.product_id) <> 2 then raise exception 'Variant was duplicated or deleted'; end if;
  if (select to_jsonb(x) from public.variant x where variant_id = v.variant_id) <> initial_v then raise exception 'Metadata-only CSV mutated original variant'; end if;
  if not exists(select 1 from public.variant where sku = 'VL-CSV01-BL-M' and stock_quantity = 8 and reserved_quantity = 0) then raise exception 'New variant association/stock incorrect'; end if;
  select * into p from public.product where product_id = p.product_id;
  if p.base_price <> 250000 or p.sale_price <> 250000 or p.status::text <> 'on_sale' then raise exception 'Metadata CSV mutated price or defaulted status'; end if;
  row_existing := row_existing || jsonb_build_object('expected_version', p.version);
  row_new := row_new || jsonb_build_object('expected_version', p.version);
  select jsonb_build_object('product', to_jsonb(x), 'variants', (select jsonb_agg(to_jsonb(y) order by y.variant_id) from public.variant y where y.product_id = x.product_id))
    into before_state from public.product x where x.product_id = p.product_id;
  begin
    perform public.admin_import_product_csv(jsonb_build_array(row_existing, row_existing || jsonb_build_object('row', 3, 'sku', ' vl-csv01-bl-s ', 'name', '')), '127.0.0.1');
    raise exception 'Duplicate normalized SKU accepted';
  exception when sqlstate 'PT422' then null;
  end;
  begin
    perform public.admin_import_product_csv(jsonb_build_array(row_existing, row_existing || jsonb_build_object('row', 3, 'sku', 'VL-CSV01-NEW', 'variant_id', null, 'variant_version', null, 'product_sku', p.sku, 'color', 'Đen', 'size', 'L', 'base_price', 100000, 'status', 'hidden')), '127.0.0.1');
    raise exception 'Active price reduction accepted';
  exception when sqlstate 'PT422' then
    get stacked diagnostics error_detail = pg_exception_detail;
    if error_detail::jsonb->'errors'->0->>'field' <> 'base_price' then raise exception 'Raced price failure lacks row/field errors: %', error_detail; end if;
  end;
  -- Force a second-row constraint error after a valid first-row write, proving transaction rollback.
  begin
    perform public.admin_import_product_csv(jsonb_build_array(row_existing || jsonb_build_object('name', 'MUST ROLLBACK'),
      row_new || jsonb_build_object('sku', 'VL-CSV01-COLLISION', 'size', 'S')), '127.0.0.1');
    raise exception 'Duplicate color/size accepted';
  exception when sqlstate 'PT422' then null;
  end;
  select jsonb_build_object('product', to_jsonb(x), 'variants', (select jsonb_agg(to_jsonb(y) order by y.variant_id) from public.variant y where y.product_id = x.product_id))
    into after_state from public.product x where x.product_id = p.product_id;
  if after_state <> before_state then raise exception 'Failed CSV wrote product or variants'; end if;
  begin
    perform public.admin_import_product_csv(jsonb_build_array(row_existing || jsonb_build_object('stock_quantity', 3)), '127.0.0.1');
    raise exception 'CSV stock dropped below reservations';
  exception when sqlstate 'PT422' then null;
  end;
  -- New product-level CSV still creates one initial variant with the supplied identity and stock.
  result := public.admin_import_product_csv(jsonb_build_array(jsonb_build_object(
    'row', 2, 'sku', 'VL-CSV02', 'name', 'New CSV garment', 'base_price', 100000,
    'category_id', p.category_id, 'status', 'hidden', 'color', 'Trắng', 'size', 'L',
    'stock_quantity', 50, 'operation', 'created')), '127.0.0.1');
  if result->>'created' <> '1' then raise exception 'New product CSV count incorrect'; end if;
  if not exists(select 1 from public.variant x join public.product y using(product_id)
    where y.sku = 'VL-CSV02' and x.sku = 'VL-CSV02' and x.color = 'Trắng' and x.size = 'L'
      and x.stock_quantity = 50 and y.status::text = 'hidden') then
    raise exception 'New product CSV discarded explicit variant fields';
  end if;
  begin
    perform public.admin_create_variant((result->'results'->0->>'product_id')::uuid, 'Đỏ', null, 'M', null, 1, 5, '127.0.0.1', p.sku);
    raise exception 'Explicit variant SKU collided with another parent product';
  exception when sqlstate 'PT409' then null;
  end;
end; $$;
rollback;
