-- KAN-105 UAT 3.1.10: product audit log filters + reason, and a durable retry record for low-stock alerts.
--  * admin_change_product_status / admin_update_stock now store the operator reason in the audit new_value,
--    so the audit detail view can show it (status changes still never touch variants, SKUs or prices).
--  * admin_list_product_audit_logs filters server-side by date range, product, action type and user.
--  * low_stock_alert_retry keeps a retry record when queueing the low-stock email fails; the on-screen alert
--    is derived from variant stock and never depends on this table.
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

  v_after := jsonb_populate_record(null::public.product, jsonb_build_object('status', p_new_status));
  update public.product
  set status = v_after.status,
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
    to_jsonb(v_after) || jsonb_build_object('reason', btrim(p_reason)),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_change_product_status(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.admin_change_product_status(uuid, text, text, integer, text) to authenticated;

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

  -- Only a negative result is rejected: dropping below low_stock_threshold is a normal, alerting adjustment.
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
    to_jsonb(v_after) || jsonb_build_object('reason', btrim(p_reason)),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.admin_update_stock(uuid, uuid, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.admin_update_stock(uuid, uuid, integer, text, integer, text) to authenticated;

-- Server-side filtering for the catalog audit screen. The audit_action enum only holds create/update,
-- so status and stock edits are classified from the old/new payloads (CREATE, UPDATE_STATUS, UPDATE_STOCK, UPDATE).
create or replace function public.admin_list_product_audit_logs(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_product text default null,
  p_action_type text default null,
  p_user text default null,
  p_target_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  audit_id uuid,
  actor_id uuid,
  actor_role text,
  action text,
  module text,
  target_id uuid,
  old_value jsonb,
  new_value jsonb,
  ip_address text,
  "timestamp" timestamptz,
  action_type text,
  actor_name text,
  actor_email text,
  product_id uuid,
  product_sku text,
  product_name text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_type text := nullif(upper(btrim(p_action_type)), '');
  v_product text := nullif(btrim(p_product), '');
  v_user text := nullif(btrim(p_user), '');
  v_product_pattern text;
  v_user_pattern text;
begin
  if not public.velura_is_active_admin() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if v_type is not null and v_type not in ('CREATE', 'UPDATE', 'UPDATE_STATUS', 'UPDATE_STOCK') then
    raise sqlstate 'PT422' using message = 'INVALID_AUDIT_ACTION';
  end if;
  if v_product is not null then
    v_product_pattern := '%' || replace(replace(replace(v_product, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;
  if v_user is not null then
    v_user_pattern := '%' || replace(replace(replace(v_user, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  return query
  with classified as (
    select
      a.audit_id as c_audit_id,
      a.actor_id as c_actor_id,
      a.actor_role::text as c_actor_role,
      a.action::text as c_action,
      a.module::text as c_module,
      a.target_id as c_target_id,
      a.old_value as c_old_value,
      a.new_value as c_new_value,
      a.ip_address::text as c_ip_address,
      a."timestamp"::timestamptz as c_ts,
      case
        when a.action::text = 'create' then 'CREATE'
        when (a.old_value->>'status') is not null and (a.new_value->>'status') is not null
          and (a.old_value->>'status') is distinct from (a.new_value->>'status') then 'UPDATE_STATUS'
        when (a.old_value->>'stock_quantity') is not null and (a.new_value->>'stock_quantity') is not null
          and (a.old_value->>'stock_quantity') is distinct from (a.new_value->>'stock_quantity') then 'UPDATE_STOCK'
        else upper(a.action::text)
      end as c_type
    from public.audit_log a
    where a.module::text = 'products'
      and (p_target_id is null or a.target_id = p_target_id)
      and (p_from is null or a."timestamp"::timestamptz >= p_from)
      and (p_to is null or a."timestamp"::timestamptz <= p_to)
  ),
  enriched as (
    select
      c.*,
      u.full_name::text as e_actor_name,
      u.email::text as e_actor_email,
      coalesce(p.product_id, pv.product_id) as e_product_id,
      coalesce(p.sku, pv.sku)::text as e_product_sku,
      coalesce(p.name, pv.name)::text as e_product_name
    from classified c
    left join public.users u on u.user_id = c.c_actor_id
    left join public.product p on p.product_id = c.c_target_id
    left join public.variant v on v.variant_id = c.c_target_id
    left join public.product pv on pv.product_id = v.product_id
  )
  select
    e.c_audit_id, e.c_actor_id, e.c_actor_role, e.c_action, e.c_module, e.c_target_id,
    e.c_old_value, e.c_new_value, e.c_ip_address, e.c_ts, e.c_type,
    e.e_actor_name, e.e_actor_email, e.e_product_id, e.e_product_sku, e.e_product_name,
    count(*) over ()
  from enriched e
  where (v_type is null or e.c_type = v_type)
    and (v_product_pattern is null
      or e.e_product_name ilike v_product_pattern
      or e.e_product_sku ilike v_product_pattern
      or (e.c_new_value->>'name') ilike v_product_pattern
      or (e.c_old_value->>'name') ilike v_product_pattern)
    and (v_user_pattern is null
      or e.e_actor_name ilike v_user_pattern
      or e.e_actor_email ilike v_user_pattern
      or e.c_actor_id::text = v_user)
  order by e.c_ts desc, e.c_audit_id
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_list_product_audit_logs(timestamptz, timestamptz, text, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.admin_list_product_audit_logs(timestamptz, timestamptz, text, text, text, uuid, integer, integer) to authenticated;

-- Retry record for low-stock alert emails that could not be queued. One pending row per variant;
-- the API retries it later and the on-screen low-stock alert never depends on it.
create table if not exists public.low_stock_alert_retry (
  retry_id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product(product_id) on delete cascade,
  variant_id uuid not null references public.variant(variant_id) on delete cascade,
  stock_quantity integer not null check (stock_quantity >= 0),
  low_stock_threshold integer not null check (low_stock_threshold >= 0),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 0 and 5),
  last_error text,
  next_attempt_at timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_low_stock_alert_retry_pending_variant
  on public.low_stock_alert_retry(variant_id) where status = 'pending';
create index if not exists idx_low_stock_alert_retry_due
  on public.low_stock_alert_retry(next_attempt_at) where status = 'pending';

drop trigger if exists trg_low_stock_alert_retry_touch_updated_at on public.low_stock_alert_retry;
create trigger trg_low_stock_alert_retry_touch_updated_at
before update on public.low_stock_alert_retry
for each row execute function public.velura_touch_updated_at();

alter table public.low_stock_alert_retry enable row level security;
revoke all on table public.low_stock_alert_retry from public, anon, authenticated;
grant select, insert, update on table public.low_stock_alert_retry to service_role;

commit;
