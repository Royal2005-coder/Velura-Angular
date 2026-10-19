-- KAN-UATFIX-3.1.10.1: Allow transitioning product status from discontinued back to on_sale/hidden/out_of_stock.
begin;

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
    or (v_before.status::text = 'discontinued' and p_new_status in ('on_sale', 'hidden', 'out_of_stock'))
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

revoke all on function public.admin_change_product_status(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.admin_change_product_status(uuid, text, text, integer, text) to authenticated;

commit;
