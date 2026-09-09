begin;

-- UC-A02: Products & Inventory
-- Adds product management RPC functions, RLS policies, and inventory tracking.

do $$
begin
  if to_regclass('public.product') is null then
    raise exception 'UC-A02 requires canonical table public.product';
  end if;
  if to_regclass('public.variant') is null then
    raise exception 'UC-A02 requires canonical table public.variant';
  end if;
  if to_regclass('public.category') is null then
    raise exception 'UC-A02 requires canonical table public.category';
  end if;
end $$;

-- Add version column for optimistic locking if missing.
alter table public.product add column if not exists version integer not null default 1 check (version > 0);
alter table public.product add column if not exists updated_at timestamptz not null default now();

alter table public.variant add column if not exists version integer not null default 1 check (version > 0);
alter table public.variant add column if not exists updated_at timestamptz not null default now();

-- Indexes for admin product queries.
create index if not exists idx_product_status_updated on public.product(status, updated_at desc);
create index if not exists idx_product_category on public.product(category_id);
create index if not exists idx_product_sku on public.product(sku);
create index if not exists idx_variant_product on public.variant(product_id);
create index if not exists idx_variant_stock on public.variant(stock_quantity, low_stock_threshold);

-- Touch updated_at triggers.
drop trigger if exists trg_product_touch_updated_at on public.product;
create trigger trg_product_touch_updated_at
before update on public.product
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_variant_touch_updated_at on public.variant;
create trigger trg_variant_touch_updated_at
before update on public.variant
for each row execute function public.velura_touch_updated_at();

-- A01's audit helper is intentionally scoped to accounts. Product mutations use
-- a module-aware helper so audit rows cannot be mislabeled.
create or replace function public.velura_append_module_audit(
  p_module text,
  p_actor_id uuid,
  p_actor_role text,
  p_action text,
  p_target_id uuid,
  p_old_value jsonb,
  p_new_value jsonb,
  p_ip_address text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role public.audit_log.actor_role%type;
  v_action public.audit_log.action%type;
  v_module public.audit_log.module%type;
  v_ip_address public.audit_log.ip_address%type;
begin
  select x.actor_role, x.action, x.module, x.ip_address
  into v_actor_role, v_action, v_module, v_ip_address
  from jsonb_populate_record(
    null::public.audit_log,
    jsonb_build_object(
      'actor_role', p_actor_role,
      'action', p_action,
      'module', p_module,
      'ip_address', coalesce(nullif(p_ip_address, ''), '0.0.0.0')
    )
  ) x;

  insert into public.audit_log (
    audit_id, actor_id, actor_role, action, module, target_id,
    old_value, new_value, ip_address, timestamp
  ) values (
    gen_random_uuid(), p_actor_id, v_actor_role, v_action, v_module, p_target_id,
    p_old_value, p_new_value, v_ip_address, now()
  );
end;
$$;

revoke all on function public.velura_append_module_audit(text, uuid, text, text, uuid, jsonb, jsonb, text)
from public, anon, authenticated;

-- Helper: sanitize search text for product queries.
create or replace function public.velura_sanitize_search(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when nullif(btrim(p_value), '') is null then ''
    else regexp_replace(btrim(p_value), '[,*()]', ' ', 'g')
  end
$$;

-- RPC: Create a new product (BR-A02-04, BR-A02-05).
create or replace function public.admin_create_product(
  p_sku text,
  p_name text,
  p_slug text,
  p_description text,
  p_category_id uuid,
  p_brand text,
  p_base_price numeric,
  p_sale_price numeric,
  p_images text[],
  p_style_tags text[],
  p_color_tone text,
  p_occasions text[],
  p_suitable_body_shapes text[],
  p_status text,
  p_is_featured boolean,
  p_is_combo boolean,
  p_collection text,
  p_seo_title text,
  p_seo_description text,
  p_expected_version integer default 0,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_product public.product%rowtype;
  v_new_id uuid;
begin
  -- RBAC check
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  -- Validate inputs
  if p_sku is null or length(btrim(p_sku)) = 0 then
    raise sqlstate 'PT422' using message = 'SKU_REQUIRED';
  end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise sqlstate 'PT422' using message = 'NAME_REQUIRED';
  end if;
  if p_category_id is null then
    raise sqlstate 'PT422' using message = 'CATEGORY_REQUIRED';
  end if;
  if not exists (select 1 from public.category where category_id = p_category_id) then
    raise sqlstate 'PT422' using message = 'INVALID_CATEGORY';
  end if;
  if p_base_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_INVALID';
  end if;
  if p_sale_price is not null and p_sale_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_INVALID';
  end if;
  if p_slug is not null and p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise sqlstate 'PT422' using message = 'SLUG_INVALID';
  end if;
  if coalesce(p_status, 'on_sale') not in ('on_sale', 'hidden') then
    raise sqlstate 'PT422' using message = 'INVALID_INITIAL_STATUS';
  end if;

  -- Check SKU uniqueness
  if exists (select 1 from public.product where sku = btrim(p_sku)) then
    raise sqlstate 'PT409' using message = 'SKU_DUPLICATE';
  end if;

  -- Check slug uniqueness
  if p_slug is not null and exists (select 1 from public.product where slug = p_slug) then
    raise sqlstate 'PT409' using message = 'SLUG_DUPLICATE';
  end if;

  v_new_id := gen_random_uuid();

  insert into public.product (
    product_id, sku, is_combo, name, slug, description, category_id, brand,
    base_price, sale_price, images, style_tags, color_tone, occasions,
    suitable_body_shapes, status, is_featured, collection, seo_title,
    seo_description, version, created_at, updated_at
  ) values (
    v_new_id, btrim(p_sku), coalesce(p_is_combo, false), btrim(p_name), p_slug,
    p_description, p_category_id, p_brand, p_base_price, p_sale_price,
    coalesce(p_images, '{}'), coalesce(p_style_tags, '{}'), p_color_tone,
    coalesce(p_occasions, '{}'), coalesce(p_suitable_body_shapes, '{}'),
    coalesce(p_status, 'on_sale'), coalesce(p_is_featured, false), p_collection,
    p_seo_title, p_seo_description, 1, now(), now()
  ) returning * into v_product;

  perform public.velura_append_module_audit(
    'products',
    v_actor.user_id,
    v_actor.admin_role::text,
    'create',
    v_product.product_id,
    null,
    jsonb_build_object('sku', v_product.sku, 'name', v_product.name),
    p_ip_address
  );

  return to_jsonb(v_product);
end;
$$;

-- RPC: Update an existing product (BR-A02-04, BR-A02-05, optimistic locking).
create or replace function public.admin_update_product(
  p_product_id uuid,
  p_name text,
  p_description text,
  p_category_id uuid,
  p_brand text,
  p_base_price numeric,
  p_sale_price numeric,
  p_images text[],
  p_style_tags text[],
  p_color_tone text,
  p_occasions text[],
  p_suitable_body_shapes text[],
  p_status text,
  p_is_featured boolean,
  p_is_combo boolean,
  p_collection text,
  p_seo_title text,
  p_seo_description text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.product%rowtype;
  v_after public.product%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  select * into v_before
  from public.product
  where product_id = p_product_id
  for update;

  if v_before.product_id is null then
    raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if p_category_id is not null
     and not exists (select 1 from public.category where category_id = p_category_id) then
    raise sqlstate 'PT422' using message = 'INVALID_CATEGORY';
  end if;
  if p_base_price is not null and p_base_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_INVALID';
  end if;
  if p_sale_price is not null and p_sale_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_INVALID';
  end if;
  if p_status is not null and p_status <> v_before.status::text then
    raise sqlstate 'PT422' using message = 'STATUS_ACTION_REQUIRED';
  end if;

  update public.product
  set name = coalesce(p_name, name),
      description = coalesce(p_description, description),
      category_id = coalesce(p_category_id, category_id),
      brand = coalesce(p_brand, brand),
      base_price = coalesce(p_base_price, base_price),
      sale_price = coalesce(p_sale_price, sale_price),
      images = coalesce(p_images, images),
      style_tags = coalesce(p_style_tags, style_tags),
      color_tone = coalesce(p_color_tone, color_tone),
      occasions = coalesce(p_occasions, occasions),
      suitable_body_shapes = coalesce(p_suitable_body_shapes, suitable_body_shapes),
      status = status,
      is_featured = coalesce(p_is_featured, is_featured),
      is_combo = coalesce(p_is_combo, is_combo),
      collection = coalesce(p_collection, collection),
      seo_title = coalesce(p_seo_title, seo_title),
      seo_description = coalesce(p_seo_description, seo_description),
      version = version + 1,
      updated_at = now()
  where product_id = p_product_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.product_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_module_audit(
    'products',
    v_actor.user_id,
    v_actor.admin_role::text,
    'update',
    v_after.product_id,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- RPC: Change product status (BR-A02-06, BR-A02-03: no physical delete).
create or replace function public.admin_change_product_status(
  p_product_id uuid,
  p_new_status text,
  p_reason text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.product%rowtype;
  v_after public.product%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_new_status not in ('on_sale', 'hidden', 'out_of_stock', 'discontinued') then
    raise sqlstate 'PT422' using message = 'INVALID_STATUS';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'STATUS_REASON_REQUIRED';
  end if;

  select * into v_before
  from public.product
  where product_id = p_product_id
  for update;

  if v_before.product_id is null then
    raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_before.status::text = p_new_status then
    raise sqlstate 'PT422' using message = 'STATUS_UNCHANGED';
  end if;
  if not (
    (v_before.status::text = 'on_sale' and p_new_status in ('hidden', 'out_of_stock', 'discontinued'))
    or (v_before.status::text = 'hidden' and p_new_status in ('on_sale', 'out_of_stock', 'discontinued'))
    or (v_before.status::text = 'out_of_stock' and p_new_status in ('on_sale', 'hidden', 'discontinued'))
    or (v_before.status::text = 'discontinued' and p_new_status = 'hidden')
  ) then
    raise sqlstate 'PT422' using message = 'INVALID_STATUS_TRANSITION';
  end if;

  update public.product
  set status = p_new_status,
      version = version + 1,
      updated_at = now()
  where product_id = p_product_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.product_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_module_audit(
    'products',
    v_actor.user_id,
    v_actor.admin_role::text,
    'update',
    v_after.product_id,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- RPC: Update stock quantity for a variant (BR-A02-10, BR-A02-11).
create or replace function public.admin_update_stock(
  p_product_id uuid,
  p_variant_id uuid,
  p_delta integer,
  p_reason text,
  p_expected_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.variant%rowtype;
  v_after public.variant%rowtype;
  v_new_stock integer;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_variant_id is null then
    raise sqlstate 'PT422' using message = 'VARIANT_REQUIRED';
  end if;
  if p_delta = 0 then
    raise sqlstate 'PT422' using message = 'STOCK_DELTA_REQUIRED';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'STOCK_REASON_REQUIRED';
  end if;

  select * into v_before
  from public.variant
  where variant_id = p_variant_id and product_id = p_product_id
  for update;

  if v_before.variant_id is null then
    raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  v_new_stock := v_before.stock_quantity + p_delta;
  if v_new_stock < 0 then
    raise sqlstate 'PT422' using message = 'STOCK_UNDERFLOW';
  end if;

  update public.variant
  set stock_quantity = v_new_stock,
      version = version + 1,
      updated_at = now()
  where variant_id = p_variant_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.variant_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_module_audit(
    'products',
    v_actor.user_id,
    v_actor.admin_role::text,
    'update',
    v_after.variant_id,
    to_jsonb(v_before),
    to_jsonb(v_after),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- Read-only low-stock query avoids loading the full variant table into the API.
create or replace function public.admin_list_low_stock(p_limit integer default 100)
returns table (
  variant_id uuid,
  product_id uuid,
  color text,
  size text,
  stock_quantity integer,
  reserved_quantity integer,
  low_stock_threshold integer,
  version integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or not v_actor.is_active
     or v_actor.admin_role::text not in ('super_admin', 'admin_operator_sanpham', 'admin_viewer') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  return query
  select
    v.variant_id,
    v.product_id,
    v.color::text,
    v.size::text,
    v.stock_quantity::integer,
    v.reserved_quantity::integer,
    v.low_stock_threshold::integer,
    v.version,
    v.updated_at
  from public.variant v
  where v.stock_quantity <= v.low_stock_threshold
  order by v.stock_quantity asc, v.updated_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- RLS policies for product tables.
alter table public.product enable row level security;
alter table public.variant enable row level security;
alter table public.category enable row level security;

drop policy if exists product_admin_select on public.product;
drop policy if exists product_admin_restriction on public.product;
drop policy if exists product_catalog_select on public.product;
create policy product_catalog_select
on public.product for select
to anon, authenticated
using (status::text = 'on_sale' or public.velura_is_active_admin());

drop policy if exists variant_admin_select on public.variant;
drop policy if exists variant_admin_restriction on public.variant;
drop policy if exists variant_catalog_select on public.variant;
create policy variant_catalog_select
on public.variant for select
to anon, authenticated
using (
  public.velura_is_active_admin()
  or exists (
    select 1 from public.product p
    where p.product_id = variant.product_id and p.status::text = 'on_sale'
  )
);

drop policy if exists category_admin_select on public.category;
drop policy if exists category_admin_restriction on public.category;
drop policy if exists category_catalog_select on public.category;
create policy category_catalog_select
on public.category for select
to anon, authenticated
using (true);

-- Revoke direct mutation on product/variant/category from anon/authenticated (admin uses RPC only).
revoke insert, update, delete, truncate on public.product from anon, authenticated;
revoke insert, update, delete, truncate on public.variant from anon, authenticated;

grant select on public.product, public.variant, public.category to anon, authenticated, service_role;

-- Revoke RPC functions from public/anonymous, grant to authenticated only.
revoke all on function public.velura_sanitize_search(text) from public, anon, authenticated;
revoke all on function public.admin_create_product(text, text, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_update_product(uuid, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_change_product_status(uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_update_stock(uuid, uuid, integer, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_list_low_stock(integer) from public, anon, authenticated;

grant execute on function public.velura_sanitize_search(text) to authenticated;
grant execute on function public.admin_create_product(text, text, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text) to authenticated;
grant execute on function public.admin_update_product(uuid, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text) to authenticated;
grant execute on function public.admin_change_product_status(uuid, text, text, integer, text) to authenticated;
grant execute on function public.admin_update_stock(uuid, uuid, integer, text, integer, text) to authenticated;
grant execute on function public.admin_list_low_stock(integer) to authenticated;

commit;
