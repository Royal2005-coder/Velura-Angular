-- Explicit variant-color associations. images remains ordered; images[1] is the sole primary image.
-- Keep migration 051's approval trigger: creation, variants and associations commit atomically.
begin;

alter table public.product add column if not exists image_colors jsonb not null default '{}'::jsonb;
comment on column public.product.image_colors is 'Image URL to exact product variant color; omitted URLs are common images. images[1] is primary.';

create function public.velura_validate_product_images() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_url text; v_color jsonb;
begin
  if tg_op = 'INSERT' or new.images is distinct from old.images then
    if coalesce(cardinality(new.images), 0) > 20 then
      raise sqlstate 'PT422' using message = 'IMAGE_LIMIT_EXCEEDED';
    end if;
    if exists (select 1 from unnest(new.images) image where image is null or btrim(image) = '')
      or (select count(*) from unnest(new.images)) <> (select count(distinct image) from unnest(new.images) image) then
      raise sqlstate 'PT422' using message = 'INVALID_PRODUCT_IMAGES';
    end if;
  end if;
  if new.status::text = 'on_sale' and coalesce(cardinality(new.images), 0) = 0 then
    if tg_op = 'INSERT' or new.images is distinct from old.images or new.status is distinct from old.status then
      raise sqlstate 'PT422' using message = 'PRIMARY_IMAGE_REQUIRED';
    end if;
  end if;
  if jsonb_typeof(new.image_colors) is distinct from 'object' then
    raise sqlstate 'PT422' using message = 'INVALID_IMAGE_COLORS';
  end if;
  if tg_op = 'UPDATE' and new.images is distinct from old.images and new.image_colors = old.image_colors then
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into new.image_colors
    from jsonb_each(new.image_colors) where key = any(coalesce(new.images, '{}'));
  end if;
  for v_url, v_color in select key, value from jsonb_each(new.image_colors) loop
    if not (v_url = any(coalesce(new.images, '{}')))
      or jsonb_typeof(v_color) <> 'string' or btrim(v_color #>> '{}') = ''
      or not exists (select 1 from public.variant where product_id = new.product_id and color = v_color #>> '{}') then
      raise sqlstate 'PT422' using message = 'INVALID_IMAGE_COLOR_ASSOCIATION';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.velura_validate_product_images() from public, anon, authenticated;
create trigger product_images_validate_before_save before insert or update of images, image_colors, status on public.product
for each row execute function public.velura_validate_product_images();


-- A color cannot disappear while catalog images still claim that color.
create function public.velura_guard_image_variant_color() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_mapping jsonb;
begin
  select image_colors into v_mapping from public.product where product_id = old.product_id for update;
  if exists (select 1 from jsonb_each_text(coalesce(v_mapping, '{}'::jsonb)) where value = old.color)
    and not exists (select 1 from public.variant where product_id = old.product_id and color = old.color) then
    raise sqlstate 'PT422' using message = 'IMAGE_COLOR_VARIANT_REQUIRED';
  end if;
  return null;
end;
$$;
revoke all on function public.velura_guard_image_variant_color() from public, anon, authenticated;
create trigger variant_image_color_after_change after delete or update of color, product_id on public.variant
for each row execute function public.velura_guard_image_variant_color();
-- Remove the old RPC signatures, rather than leaving a PostgREST overload or a bypass.
drop function public.admin_create_product(text,text,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text);
drop function public.admin_update_product(uuid,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text);

create function public.admin_create_product(
  p_sku text, p_name text, p_slug text, p_description text, p_category_id uuid,
  p_brand text, p_base_price numeric, p_sale_price numeric, p_images text[],
  p_style_tags text[], p_color_tone text, p_occasions text[], p_suitable_body_shapes text[],
  p_status text, p_is_featured boolean, p_is_combo boolean, p_collection text,
  p_seo_title text, p_seo_description text, p_expected_version integer default 0,
  p_ip_address text default null, p_image_colors jsonb default '{}'::jsonb,
  p_variants jsonb default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype;
  v_product public.product%rowtype;
  v_variant jsonb;
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
  if not exists (select 1 from public.category where category_id = p_category_id) then raise sqlstate 'PT422' using message = 'INVALID_CATEGORY'; end if;
  if p_base_price < 0 or p_sale_price < 0 then raise sqlstate 'PT422' using message = 'PRICE_INVALID'; end if;
  if p_slug is not null and p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise sqlstate 'PT422' using message = 'SLUG_INVALID'; end if;
  if coalesce(p_status, 'on_sale') not in ('on_sale', 'hidden') then raise sqlstate 'PT422' using message = 'INVALID_INITIAL_STATUS'; end if;
  if p_expected_version is distinct from 0 then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if exists (select 1 from public.product where sku = btrim(p_sku)) then raise sqlstate 'PT409' using message = 'SKU_DUPLICATE'; end if;
  if p_slug is not null and exists (select 1 from public.product where slug = p_slug) then raise sqlstate 'PT409' using message = 'SLUG_DUPLICATE'; end if;
  if jsonb_typeof(v_variants) is distinct from 'array' or v_variants = '[]'::jsonb then raise sqlstate 'PT422' using message = 'VARIANTS_REQUIRED'; end if;
  -- Resolve enum-backed and text-backed catalog schemas through the actual product row type.
  v_product := jsonb_populate_record(null::public.product, jsonb_build_object(
    'color_tone', p_color_tone, 'suitable_body_shapes', coalesce(p_suitable_body_shapes, '{}'),
    'status', coalesce(p_status, 'on_sale')));

  insert into public.product (
    product_id, sku, is_combo, name, slug, description, category_id, brand, base_price, sale_price,
    images, style_tags, color_tone, occasions, suitable_body_shapes, status, is_featured,
    collection, seo_title, seo_description, version, created_at, updated_at
  ) values (
    gen_random_uuid(), btrim(p_sku), coalesce(p_is_combo, false), btrim(p_name), p_slug,
    p_description, p_category_id, p_brand, p_base_price, p_sale_price, coalesce(p_images, '{}'),
    coalesce(p_style_tags, '{}'), v_product.color_tone, coalesce(p_occasions, '{}'), v_product.suitable_body_shapes,
    v_product.status, coalesce(p_is_featured, false), p_collection, p_seo_title, p_seo_description, 1, now(), now()
  ) returning * into v_product;

  for v_variant in select value from jsonb_array_elements(v_variants) loop
    perform public.admin_create_variant(v_product.product_id, v_variant->>'color', v_variant->>'colorHex',
      coalesce(v_variant->>'size', 'F'), nullif(v_variant->'sizeMeasurements', 'null'::jsonb),
      coalesce((v_variant->>'stockQuantity')::integer, 0), coalesce((v_variant->>'lowStockThreshold')::integer, 5), p_ip_address);
  end loop;
  update public.product set image_colors = coalesce(p_image_colors, '{}'::jsonb)
  where product_id = v_product.product_id returning * into v_product;
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'create',
    v_product.product_id, null, to_jsonb(v_product), p_ip_address);
  return to_jsonb(v_product);
end;
$$;

create function public.admin_update_product(
  p_product_id uuid, p_name text, p_description text, p_category_id uuid, p_brand text,
  p_base_price numeric, p_sale_price numeric, p_images text[], p_style_tags text[], p_color_tone text,
  p_occasions text[], p_suitable_body_shapes text[], p_status text, p_is_featured boolean, p_is_combo boolean,
  p_collection text, p_seo_title text, p_seo_description text, p_expected_version integer,
  p_ip_address text default null, p_image_colors jsonb default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  v_actor public.users%rowtype;
  v_before public.product%rowtype;
  v_after public.product%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  select * into v_before from public.product where product_id = p_product_id for update;
  if v_before.product_id is null then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
  if v_before.version is distinct from p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if p_category_id is not null and not exists (select 1 from public.category where category_id = p_category_id) then raise sqlstate 'PT422' using message = 'INVALID_CATEGORY'; end if;
  if p_base_price < 0 or p_sale_price < 0 then raise sqlstate 'PT422' using message = 'PRICE_INVALID'; end if;
  if p_status is not null and p_status <> v_before.status::text then raise sqlstate 'PT422' using message = 'STATUS_ACTION_REQUIRED'; end if;
  v_after := jsonb_populate_record(null::public.product, jsonb_build_object(
    'color_tone', p_color_tone, 'suitable_body_shapes', p_suitable_body_shapes));

  update public.product set name = coalesce(p_name, name), description = coalesce(p_description, description),
    category_id = coalesce(p_category_id, category_id), brand = coalesce(p_brand, brand),
    base_price = coalesce(p_base_price, base_price), sale_price = coalesce(p_sale_price, sale_price),
    images = coalesce(p_images, images), image_colors = coalesce(p_image_colors, image_colors),
    style_tags = coalesce(p_style_tags, style_tags), color_tone = coalesce(v_after.color_tone, color_tone),
    occasions = coalesce(p_occasions, occasions), suitable_body_shapes = coalesce(v_after.suitable_body_shapes, suitable_body_shapes),
    is_featured = coalesce(p_is_featured, is_featured), is_combo = coalesce(p_is_combo, is_combo),
    collection = coalesce(p_collection, collection), seo_title = coalesce(p_seo_title, seo_title),
    seo_description = coalesce(p_seo_description, seo_description), version = version + 1, updated_at = now()
  where product_id = p_product_id and version = p_expected_version returning * into v_after;
  if v_after.product_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  perform public.velura_append_module_audit('products', v_actor.user_id, v_actor.admin_role::text, 'update',
    p_product_id, to_jsonb(v_before), to_jsonb(v_after), p_ip_address);
  return to_jsonb(v_after);
end;
$$;

-- Preserve migration 062's status transitions while assigning the database's actual status type.
create or replace function public.admin_change_product_status(
  p_product_id uuid, p_new_status text, p_reason text, p_expected_version integer, p_ip_address text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare v_actor public.users%rowtype; v_before public.product%rowtype; v_after public.product%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null or v_actor.role::text <> 'admin' or v_actor.is_active is not true
    or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_new_status not in ('on_sale','hidden','out_of_stock','discontinued') then raise sqlstate 'PT422' using message = 'INVALID_STATUS'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then raise sqlstate 'PT422' using message = 'STATUS_REASON_REQUIRED'; end if;
  select * into v_before from public.product where product_id = p_product_id for update;
  if v_before.product_id is null then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
  if v_before.version is distinct from p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = p_new_status then raise sqlstate 'PT422' using message = 'STATUS_UNCHANGED'; end if;
  if v_before.status::text not in ('on_sale','hidden','out_of_stock','discontinued') then
    raise sqlstate 'PT422' using message = 'INVALID_STATUS_TRANSITION';
  end if;
  v_after := jsonb_populate_record(null::public.product, jsonb_build_object('status', p_new_status));
  update public.product set status = v_after.status, version = version + 1, updated_at = now()
  where product_id = p_product_id and version = p_expected_version returning * into v_after;
  if v_after.product_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  perform public.velura_append_module_audit('products',v_actor.user_id,v_actor.admin_role::text,'update',
    p_product_id,to_jsonb(v_before),to_jsonb(v_after),p_ip_address);
  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_create_product(text,text,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.admin_update_product(uuid,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.admin_create_product(text,text,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text,jsonb,jsonb) to authenticated;
grant execute on function public.admin_update_product(uuid,text,text,uuid,text,numeric,numeric,text[],text[],text,text[],text[],text,boolean,boolean,text,text,text,integer,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
