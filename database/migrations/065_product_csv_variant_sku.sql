-- Persist variant identities and import CSV atomically. Product CSV never changes existing prices.
begin;

alter table public.variant add column sku text;
with identities as (
  select v.variant_id, p.sku as product_sku, count(*) over (partition by v.product_id) as variants
  from public.variant v join public.product p using (product_id)
)
update public.variant v set sku = upper(btrim(i.product_sku)) || case when i.variants = 1 then ''
  else '-' || upper(substr(replace(v.variant_id::text, '-', ''), 1, 8)) || '-' || upper(substr(replace(v.variant_id::text, '-', ''), 9, 8))
    || '-' || upper(substr(replace(v.variant_id::text, '-', ''), 17, 8)) || '-' || upper(substr(replace(v.variant_id::text, '-', ''), 25, 8)) end
from identities i where i.variant_id = v.variant_id;
alter table public.variant alter column sku set not null;
create unique index variant_sku_normalized_unique on public.variant (upper(btrim(sku)));

create function public.velura_assign_variant_sku() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare v_parent text;
begin
  select upper(btrim(sku)) into v_parent from public.product where product_id = new.product_id;
  if nullif(btrim(new.sku), '') is null then
    if not exists (select 1 from public.variant where product_id = new.product_id) then
      new.sku := v_parent;
    else
      new.sku := v_parent || '-' || upper(substr(replace(new.variant_id::text, '-', ''), 1, 8)) || '-'
        || upper(substr(replace(new.variant_id::text, '-', ''), 9, 8)) || '-'
        || upper(substr(replace(new.variant_id::text, '-', ''), 17, 8)) || '-'
        || upper(substr(replace(new.variant_id::text, '-', ''), 25, 8));
    end if;
  end if;
  new.sku := upper(btrim(new.sku));
  if exists(select 1 from public.product where upper(btrim(sku)) = new.sku and product_id <> new.product_id) then
    raise sqlstate 'PT409' using message = 'SKU_DUPLICATE';
  end if;
  return new;
end; $$;
create trigger variant_assign_sku before insert or update of sku on public.variant
for each row execute function public.velura_assign_variant_sku();

-- Replace the old signature: every caller can optionally supply a persisted SKU.
drop function public.admin_create_variant(uuid, text, text, text, jsonb, integer, integer, text);
create function public.admin_create_variant(
  p_product_id uuid, p_color text, p_color_hex text default null, p_size text default 'F',
  p_size_measurements jsonb default null, p_stock_quantity integer default 0,
  p_low_stock_threshold integer default 5, p_ip_address text default null, p_sku text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_actor public.users%rowtype; v_variant public.variant%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  perform 1 from public.product where product_id = p_product_id for update;
  if not found then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
  if nullif(btrim(p_color), '') is null then raise sqlstate 'PT422' using message = 'COLOR_REQUIRED'; end if;
  if nullif(btrim(p_size), '') is null then raise sqlstate 'PT422' using message = 'SIZE_REQUIRED'; end if;
  if p_stock_quantity is null or p_stock_quantity < 0 then raise sqlstate 'PT422' using message = 'STOCK_INVALID'; end if;
  if p_low_stock_threshold is null or p_low_stock_threshold < 0 then raise sqlstate 'PT422' using message = 'THRESHOLD_INVALID'; end if;
  insert into public.variant(variant_id, product_id, sku, color, color_hex, size, size_measurements,
    stock_quantity, reserved_quantity, low_stock_threshold, version, updated_at)
  values(gen_random_uuid(), p_product_id, p_sku, btrim(p_color), p_color_hex, btrim(p_size), p_size_measurements,
    p_stock_quantity, 0, p_low_stock_threshold, 1, now()) returning * into v_variant;
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'create',
    v_variant.variant_id, null, to_jsonb(v_variant), p_ip_address);
  return to_jsonb(v_variant);
end; $$;
revoke all on function public.admin_create_variant(uuid, text, text, text, jsonb, integer, integer, text, text) from public, anon;
grant execute on function public.admin_create_variant(uuid, text, text, text, jsonb, integer, integer, text, text) to authenticated;

-- Preserve migration 063's image contract and pass initial variant SKUs through unchanged.
create or replace function public.admin_create_product(
  p_sku text, p_name text, p_slug text, p_description text, p_category_id uuid,
  p_brand text, p_base_price numeric, p_sale_price numeric, p_images text[],
  p_style_tags text[], p_color_tone text, p_occasions text[], p_suitable_body_shapes text[],
  p_status text, p_is_featured boolean, p_is_combo boolean, p_collection text,
  p_seo_title text, p_seo_description text, p_expected_version integer default 0,
  p_ip_address text default null, p_image_colors jsonb default '{}'::jsonb, p_variants jsonb default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype; v_product public.product%rowtype; v_variant jsonb;
  v_variants jsonb := coalesce(p_variants, '[{"color":"Mặc định","colorHex":"#FFFFFF","size":"F","stockQuantity":0,"lowStockThreshold":5}]'::jsonb);
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_sku is null or length(btrim(p_sku)) = 0 then raise sqlstate 'PT422' using message = 'SKU_REQUIRED'; end if;
  if p_name is null or length(btrim(p_name)) < 2 then raise sqlstate 'PT422' using message = 'NAME_REQUIRED'; end if;
  if p_category_id is null then raise sqlstate 'PT422' using message = 'CATEGORY_REQUIRED'; end if;
  if not exists(select 1 from public.category where category_id = p_category_id) then raise sqlstate 'PT422' using message = 'INVALID_CATEGORY'; end if;
  if p_base_price < 0 or p_sale_price < 0 then raise sqlstate 'PT422' using message = 'PRICE_INVALID'; end if;
  if p_slug is not null and p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise sqlstate 'PT422' using message = 'SLUG_INVALID'; end if;
  if coalesce(p_status, 'on_sale') not in ('on_sale', 'hidden') then raise sqlstate 'PT422' using message = 'INVALID_INITIAL_STATUS'; end if;
  if p_expected_version is distinct from 0 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if exists(select 1 from public.product where upper(btrim(sku)) = upper(btrim(p_sku))) then raise sqlstate 'PT409' using message = 'SKU_DUPLICATE'; end if;
  if exists(select 1 from public.variant where upper(btrim(sku)) = upper(btrim(p_sku))) then raise sqlstate 'PT409' using message = 'SKU_DUPLICATE'; end if;
  if p_slug is not null and exists(select 1 from public.product where slug = p_slug) then raise sqlstate 'PT409' using message = 'SLUG_DUPLICATE'; end if;
  if jsonb_typeof(v_variants) is distinct from 'array' or v_variants = '[]'::jsonb then raise sqlstate 'PT422' using message = 'VARIANTS_REQUIRED'; end if;
  v_product := jsonb_populate_record(null::public.product, jsonb_build_object('color_tone', p_color_tone,
    'suitable_body_shapes', coalesce(p_suitable_body_shapes, '{}'), 'status', coalesce(p_status, 'on_sale')));
  insert into public.product(product_id, sku, is_combo, name, slug, description, category_id, brand, base_price, sale_price,
    images, style_tags, color_tone, occasions, suitable_body_shapes, status, is_featured, collection,
    seo_title, seo_description, version, created_at, updated_at)
  values(gen_random_uuid(), upper(btrim(p_sku)), coalesce(p_is_combo, false), btrim(p_name), p_slug,
    p_description, p_category_id, p_brand, p_base_price, p_sale_price, coalesce(p_images, '{}'),
    coalesce(p_style_tags, '{}'), v_product.color_tone, coalesce(p_occasions, '{}'), v_product.suitable_body_shapes,
    v_product.status, coalesce(p_is_featured, false), p_collection, p_seo_title, p_seo_description, 1, now(), now()) returning * into v_product;
  for v_variant in select value from jsonb_array_elements(v_variants) loop
    perform public.admin_create_variant(v_product.product_id, v_variant->>'color', v_variant->>'colorHex',
      coalesce(v_variant->>'size', 'F'), nullif(v_variant->'sizeMeasurements', 'null'::jsonb),
      coalesce((v_variant->>'stockQuantity')::integer, 0), coalesce((v_variant->>'lowStockThreshold')::integer, 5), p_ip_address, v_variant->>'sku');
  end loop;
  update public.product set image_colors = coalesce(p_image_colors, '{}'::jsonb) where product_id = v_product.product_id returning * into v_product;
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'create', v_product.product_id, null, to_jsonb(v_product), p_ip_address);
  return to_jsonb(v_product);
end; $$;

create function public.admin_import_product_csv(p_rows jsonb, p_ip_address text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype; r jsonb; p public.product%rowtype; v public.variant%rowtype;
  old_p public.product%rowtype; old_v public.variant%rowtype; result jsonb;
  results jsonb := '[]'::jsonb; created integer := 0; updated integer := 0;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x group by upper(btrim(x->>'sku')) having count(*) > 1) then
    raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED';
  end if;
  -- Serialize imports; row locks/version checks still protect against all other editor/pricing workflows.
  perform pg_advisory_xact_lock(63015);
  for r in select value from jsonb_array_elements(p_rows) order by value->>'product_id', value->>'sku' loop
    if nullif(btrim(r->>'sku'), '') is null or length(btrim(r->>'name')) < 2
      or (r->>'base_price') is null or (r->>'base_price')::numeric < 0
      or (r->>'sale_price')::numeric < 0 or (r->>'stock_quantity')::integer < 0
      or (r->>'low_stock_threshold')::integer < 0 then
      raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED';
    end if;
    select * into v from public.variant where upper(btrim(sku)) = upper(btrim(r->>'sku')) for update;
    if v.variant_id is distinct from (r->>'variant_id')::uuid then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    if v.variant_id is not null and v.version is distinct from (r->>'variant_version')::integer then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    select * into p from public.product where product_id = coalesce(v.product_id, (r->>'product_id')::uuid) for update;
    if p.product_id is distinct from (r->>'product_id')::uuid then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
    if p.product_id is not null then
      if p.version is distinct from (r->>'expected_version')::integer then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
      if (r->>'base_price')::numeric is distinct from p.base_price or
        ((r->>'sale_price') is not null and (r->>'sale_price')::numeric is distinct from p.sale_price) then
        raise sqlstate 'PT422' using message = 'CSV_PRICE_CHANGE_FORBIDDEN';
      end if;
      if nullif(r->>'product_sku', '') is not null and upper(btrim(p.sku)) <> upper(btrim(r->>'product_sku')) then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
      if v.variant_id is null and nullif(r->>'product_sku', '') is null and upper(btrim(p.sku)) <> upper(btrim(r->>'sku')) then raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED'; end if;
      if exists(select 1 from public.product where upper(btrim(sku)) = upper(btrim(r->>'sku')) and product_id <> p.product_id) then
        raise sqlstate 'PT422' using message = 'CSV_SKU_AMBIGUOUS';
      end if;
    elsif exists(select 1 from public.product where upper(btrim(sku)) = upper(btrim(r->>'sku'))) then
      raise sqlstate 'PT409' using message = 'SKU_DUPLICATE';
    end if;
    if nullif(r->>'image_url', '') is not null and (p.product_id is null or not (r->>'image_url' = any(p.images))) then
      raise sqlstate 'PT422' using message = 'CSV_IMAGE_REVIEW_REQUIRED';
    end if;
  end loop;
  for r in select value from jsonb_array_elements(p_rows) loop
    select * into p from public.product where product_id = (r->>'product_id')::uuid;
    if p.product_id is null then
      result := public.admin_create_product(
        p_sku => upper(btrim(r->>'sku')), p_name => r->>'name', p_slug => lower(r->>'sku'),
        p_description => r->>'description', p_category_id => (r->>'category_id')::uuid, p_brand => null,
        p_base_price => (r->>'base_price')::numeric, p_sale_price => coalesce((r->>'sale_price')::numeric, (r->>'base_price')::numeric),
        p_images => '{}'::text[], p_style_tags => '{}'::text[], p_color_tone => null, p_occasions => '{}'::text[], p_suitable_body_shapes => '{}'::text[],
        p_status => coalesce(r->>'status', 'hidden'), p_is_featured => coalesce((r->>'is_featured')::boolean, false), p_is_combo => false,
        p_collection => null, p_seo_title => null, p_seo_description => null, p_expected_version => 0, p_ip_address => p_ip_address,
        p_variants => jsonb_build_array(jsonb_build_object('sku', r->>'sku', 'color', coalesce(r->>'color', 'Mặc định'),
          'colorHex', r->>'color_hex', 'size', coalesce(r->>'size', 'F'), 'stockQuantity', coalesce((r->>'stock_quantity')::integer, 0),
          'lowStockThreshold', coalesce((r->>'low_stock_threshold')::integer, 5))));
      select * into p from public.product where product_id = (result->>'product_id')::uuid;
      select * into v from public.variant where product_id = p.product_id;
    else
      old_p := p;
      -- No existing price columns appear in this UPDATE, regardless of status or supplied/default CSV values.
      update public.product set name = r->>'name', category_id = (r->>'category_id')::uuid,
        description = coalesce(r->>'description', description), is_featured = coalesce((r->>'is_featured')::boolean, is_featured),
        version = version + 1, updated_at = now() where product_id = p.product_id returning * into p;
      perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'update', p.product_id, to_jsonb(old_p), to_jsonb(p), p_ip_address);
      select * into v from public.variant where variant_id = (r->>'variant_id')::uuid;
      if v.variant_id is null and nullif(r->>'product_sku', '') is not null then
        result := public.admin_create_variant(p.product_id, r->>'color', r->>'color_hex', r->>'size', null,
          coalesce((r->>'stock_quantity')::integer, 0), coalesce((r->>'low_stock_threshold')::integer, 5), p_ip_address, r->>'sku');
        select * into v from public.variant where variant_id = (result->>'variant_id')::uuid;
      elsif v.variant_id is not null and (r->>'color' is not null or r->>'size' is not null or r->>'color_hex' is not null
        or r->>'stock_quantity' is not null or r->>'low_stock_threshold' is not null) then
        old_v := v;
        if coalesce((r->>'stock_quantity')::integer, v.stock_quantity) < v.reserved_quantity then raise sqlstate 'PT422' using message = 'STOCK_UNDERFLOW'; end if;
        update public.variant set color = coalesce(r->>'color', color), size = coalesce(r->>'size', size),
          color_hex = coalesce(r->>'color_hex', color_hex), stock_quantity = coalesce((r->>'stock_quantity')::integer, stock_quantity),
          low_stock_threshold = coalesce((r->>'low_stock_threshold')::integer, low_stock_threshold), version = version + 1, updated_at = now()
        where variant_id = v.variant_id returning * into v;
        perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'update', v.variant_id, to_jsonb(old_v), to_jsonb(v), p_ip_address);
      end if;
      if r->>'status' is not null and r->>'status' <> p.status::text then
        perform public.admin_change_product_status(p.product_id, r->>'status', 'Cập nhật trạng thái qua CSV', p.version, p_ip_address);
      end if;
    end if;
    if r->>'operation' = 'created' then created := created + 1; else updated := updated + 1; end if;
    results := results || jsonb_build_array(jsonb_build_object('sku', r->>'sku', 'status', r->>'operation', 'product_id', p.product_id, 'variant_id', v.variant_id));
  end loop;
  return jsonb_build_object('created', created, 'updated', updated, 'failed', 0, 'total', jsonb_array_length(p_rows), 'results', results);
exception when others then
  if sqlstate in ('PT422', 'PT409', '23505', '23514', '23503', '22P02', '22003') then
    raise sqlstate 'PT422' using message = 'CSV_VALIDATION_FAILED',
      detail = jsonb_build_object('errors', jsonb_build_array(jsonb_build_object(
        'row', coalesce((r->>'row')::integer, 0),
        'field', case when sqlerrm = 'CSV_PRICE_CHANGE_FORBIDDEN' then 'base_price' else 'csv' end,
        'message', case when sqlerrm = 'CSV_PRICE_CHANGE_FORBIDDEN'
          then 'Giá hiện có đã thay đổi; CSV không được đổi giá. Tải lại bản xem trước.'
          else 'Dữ liệu catalog đã đổi hoặc dòng CSV không hợp lệ; chưa ghi dòng nào. Tải lại bản xem trước.' end,
        'code', sqlerrm)))::text;
  end if;
  raise;
end; $$;
revoke all on function public.admin_import_product_csv(jsonb, text) from public, anon;
grant execute on function public.admin_import_product_csv(jsonb, text) to authenticated;

commit;
