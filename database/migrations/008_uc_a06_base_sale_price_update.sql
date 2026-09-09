-- UC-A06: allow pricing admins to update both display base price and sale price.
-- The previous RPC accepted only p_new_sale_price, so price_history could not
-- record a real new_base_price when the original/display price changed.

alter table public.price_history enable row level security;

drop policy if exists price_history_admin_select on public.price_history;
create policy price_history_admin_select on public.price_history
for select to authenticated
using ((select public.velura_has_admin_role(array['super_admin','admin_operator_gia_km'])));

revoke all on public.price_history from anon, authenticated;
grant select on public.price_history to authenticated;

drop function if exists public.admin_change_product_price(uuid, numeric, text, integer, text);

create or replace function public.admin_change_product_price(
  p_product_id uuid,
  p_new_base_price numeric,
  p_new_sale_price numeric,
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
  v_reason text;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null then
    raise sqlstate 'PT401' using message = 'AUTH_REQUIRED';
  end if;
  if v_actor.admin_role::text not in ('super_admin', 'admin_operator_gia_km') then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;
  if length(v_reason) > 500 then
    raise sqlstate 'PT422' using message = 'REASON_MAX_500_CHARS';
  end if;
  if p_new_base_price is null or p_new_sale_price is null then
    raise sqlstate 'PT422' using message = 'PRICE_REQUIRED';
  end if;
  if p_new_base_price < 0 or p_new_sale_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_NON_NEGATIVE';
  end if;
  if p_new_sale_price > p_new_base_price then
    raise sqlstate 'PT422' using message = 'SALE_PRICE_ABOVE_BASE_PRICE';
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

  insert into public.price_history (
    price_history_id,
    product_id,
    variant_id,
    old_base_price,
    new_base_price,
    old_sale_price,
    new_sale_price,
    changed_by,
    changed_at,
    reason
  )
  values (
    gen_random_uuid(),
    p_product_id,
    null,
    v_before.base_price,
    p_new_base_price,
    v_before.sale_price,
    p_new_sale_price,
    v_actor.user_id,
    now(),
    v_reason
  );

  update public.product
  set base_price = p_new_base_price,
      sale_price = p_new_sale_price,
      version = version + 1,
      updated_at = now()
  where product_id = p_product_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.product_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_module_audit(
    'pricing',
    v_actor.user_id,
    v_actor.admin_role::text,
    'update',
    p_product_id,
    jsonb_build_object(
      'base_price', v_before.base_price,
      'sale_price', v_before.sale_price,
      'version', v_before.version
    ),
    jsonb_build_object(
      'base_price', v_after.base_price,
      'sale_price', v_after.sale_price,
      'version', v_after.version
    ),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_change_product_price(uuid, numeric, numeric, text, integer, text)
from public, anon, authenticated;
grant execute on function public.admin_change_product_price(uuid, numeric, numeric, text, integer, text)
to authenticated;
