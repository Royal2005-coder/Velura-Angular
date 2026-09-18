-- ADM-PRD: product mutations must go through security-definer RPCs (no direct table INSERT/UPDATE under RLS).
-- Restores authenticated EXECUTE on catalog RPCs and adds admin_create_variant for stock variants.

begin;

create or replace function public.admin_create_variant(
  p_product_id uuid,
  p_color text,
  p_color_hex text default null,
  p_size text default 'F',
  p_size_measurements jsonb default null,
  p_stock_quantity integer default 0,
  p_low_stock_threshold integer default 5,
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
  v_variant public.variant%rowtype;
  v_new_id uuid;
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

  if p_product_id is null then
    raise sqlstate 'PT422' using message = 'PRODUCT_REQUIRED';
  end if;
  if p_color is null or length(btrim(p_color)) = 0 then
    raise sqlstate 'PT422' using message = 'COLOR_REQUIRED';
  end if;
  if p_size is null or length(btrim(p_size)) = 0 then
    raise sqlstate 'PT422' using message = 'SIZE_REQUIRED';
  end if;
  if p_stock_quantity is null or p_stock_quantity < 0 then
    raise sqlstate 'PT422' using message = 'STOCK_INVALID';
  end if;
  if p_low_stock_threshold is null or p_low_stock_threshold < 0 then
    raise sqlstate 'PT422' using message = 'THRESHOLD_INVALID';
  end if;

  select * into v_product
  from public.product
  where product_id = p_product_id
  for update;

  if v_product.product_id is null then
    raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND';
  end if;

  v_new_id := gen_random_uuid();

  insert into public.variant (
    variant_id, product_id, color, color_hex, size, size_measurements,
    stock_quantity, reserved_quantity, low_stock_threshold, version, updated_at
  ) values (
    v_new_id, p_product_id, btrim(p_color), nullif(btrim(coalesce(p_color_hex, '')), ''),
    btrim(p_size), p_size_measurements, p_stock_quantity, 0, p_low_stock_threshold, 1, now()
  ) returning * into v_variant;

  perform public.velura_append_module_audit(
    'products',
    v_actor.user_id,
    v_actor.admin_role::text,
    'create',
    v_variant.variant_id,
    null,
    jsonb_build_object(
      'product_id', p_product_id,
      'color', v_variant.color,
      'size', v_variant.size,
      'stock_quantity', v_variant.stock_quantity
    ),
    p_ip_address
  );

  return to_jsonb(v_variant);
end;
$$;

revoke all on function public.admin_create_variant(uuid, text, text, text, jsonb, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_variant(uuid, text, text, text, jsonb, integer, integer, text)
  to authenticated;

-- Re-grant catalog mutation RPCs in case earlier hardening revoked a wrong overload.
grant execute on function public.admin_create_product(text, text, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text)
  to authenticated;
grant execute on function public.admin_update_product(uuid, text, text, uuid, text, numeric, numeric, text[], text[], text, text[], text[], text, boolean, boolean, text, text, text, integer, text)
  to authenticated;
grant execute on function public.admin_change_product_status(uuid, text, text, integer, text)
  to authenticated;
grant execute on function public.admin_update_stock(uuid, uuid, integer, text, integer, text)
  to authenticated;
grant execute on function public.admin_list_low_stock(integer)
  to authenticated;

commit;
