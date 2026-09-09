-- Migration 009: Fix database RPC errors

-- 1. Fix admin_create_voucher: Change public.voucher_user_group to public.applicable_user_group and 'all' to 'all_users'
create or replace function public.admin_create_voucher(
  p_code varchar,
  p_name varchar,
  p_discount_type varchar,
  p_discount_value numeric,
  p_start_date timestamp,
  p_end_date timestamp,
  p_promo_id uuid default null,
  p_max_discount_amount numeric default null,
  p_min_order_value numeric default 0,
  p_usage_limit_total integer default null,
  p_usage_limit_per_user integer default 1,
  p_applicable_categories jsonb default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_disc_type public.voucher.discount_type%type;
  v_new public.voucher%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if v_actor.user_id is null then raise sqlstate 'PT401' using message = 'UNAUTHORIZED'; end if;
  if v_actor.role <> 'admin' or v_actor.admin_role is null then
    raise sqlstate 'PT403' using message = 'FORBIDDEN';
  end if;

  if p_code is null or length(btrim(p_code)) = 0 then
    raise sqlstate 'PT422' using message = 'CODE_REQUIRED';
  end if;
  if exists (select 1 from public.voucher where code = btrim(p_code)) then
    raise sqlstate 'PT409' using message = 'VOUCHER_CODE_EXISTS';
  end if;

  select x.discount_type into v_disc_type
  from jsonb_populate_record(null::public.voucher, jsonb_build_object('discount_type', p_discount_type)) x;

  insert into public.voucher (
    voucher_id, promo_id, code, name, discount_type, discount_value,
    max_discount_amount, min_order_value, usage_limit_total, usage_limit_per_user,
    used_count, applicable_categories, applicable_user_group,
    start_date, end_date, is_active, created_by
  ) values (
    gen_random_uuid(), p_promo_id, btrim(p_code), btrim(p_name), v_disc_type, p_discount_value,
    p_max_discount_amount, p_min_order_value, p_usage_limit_total, p_usage_limit_per_user,
    0, p_applicable_categories, 'all_users'::public.applicable_user_group,
    p_start_date, p_end_date, true, v_actor.user_id
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'vouchers', v_actor.user_id, v_actor.admin_role::text, 'create', v_new.voucher_id,
    null, to_jsonb(v_new), p_ip_address
  );

  return to_jsonb(v_new);
end;
$$;


-- 2. Fix admin_approve_exchange: Remove invalid condition_check_result = 'approved' assignment
create or replace function public.admin_approve_exchange(
  p_return_id uuid,
  p_expected_version integer,
  p_admin_note text default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.return_exchange%rowtype;
  v_after public.return_exchange%rowtype;
  v_new_order_id uuid;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.return_exchange where return_id = p_return_id for update;
  if v_before.return_id is null then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text <> 'pending' then raise sqlstate 'PT422' using message = 'RETURN_NOT_PENDING'; end if;
  v_new_order_id := gen_random_uuid();
  update public.return_exchange set status = 'approved'::public.return_status,
    exchange_order_id = v_new_order_id, admin_note = btrim(p_admin_note), resolved_at = now(), version = version + 1, updated_at = now()
  where return_id = p_return_id and version = p_expected_version returning * into v_after;
  if v_after.return_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  perform public.velura_append_module_audit('returns', v_actor.user_id, v_actor.admin_role::text, 'approve', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'exchange_order_id', v_new_order_id), p_ip_address);
  return to_jsonb(v_after);
end; $$;
