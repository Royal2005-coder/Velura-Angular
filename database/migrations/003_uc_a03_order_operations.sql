begin;

do $$
begin
  if to_regclass('public.orders') is null then raise exception 'UC-A03 requires public.orders'; end if;
  if to_regclass('public.order_item') is null then raise exception 'UC-A03 requires public.order_item'; end if;
  if to_regclass('public.order_status_history') is null then raise exception 'UC-A03 requires public.order_status_history'; end if;
  if to_regclass('public.payment') is null then raise exception 'UC-A03 requires public.payment'; end if;
  if to_regclass('public.variant') is null then raise exception 'UC-A03 requires public.variant'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'UC-A03 requires public.audit_log'; end if;
  if to_regclass('public.email_outbox') is null then raise exception 'UC-A03 requires public.email_outbox'; end if;
end $$;

alter table public.orders add column if not exists version integer not null default 1 check (version > 0);
alter table public.orders add column if not exists updated_at timestamptz not null default now();
alter table public.payment add column if not exists version integer not null default 1 check (version > 0);
alter table public.payment add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_orders_admin_status_date on public.orders(status, order_date desc);
create index if not exists idx_orders_admin_user_date on public.orders(user_id, order_date desc);
create index if not exists idx_orders_admin_shipping_phone on public.orders(shipping_phone);
create index if not exists idx_order_item_order on public.order_item(order_id);
create index if not exists idx_order_history_order_changed on public.order_status_history(order_id, changed_at desc);
create index if not exists idx_payment_order_created on public.payment(order_id, created_at desc);
create index if not exists idx_payment_discrepancy on public.payment(has_discrepancy, payment_status)
  where has_discrepancy or payment_status = 'discrepancy'::public.payment_status;

drop trigger if exists trg_orders_touch_updated_at on public.orders;
create trigger trg_orders_touch_updated_at
before update on public.orders
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_payment_touch_updated_at on public.payment;
create trigger trg_payment_touch_updated_at
before update on public.payment
for each row execute function public.velura_touch_updated_at();

create or replace function public.velura_is_order_reader()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.users u
    where u.user_id = public.velura_current_user_id()
      and u.role::text = 'admin'
      and u.is_active
      and u.admin_role::text in (
        'super_admin', 'admin_operator_donhang', 'admin_operator_cskh_dt'
      )
  )
$$;

create or replace function public.velura_is_order_operator()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.users u
    where u.user_id = public.velura_current_user_id()
      and u.role::text = 'admin'
      and u.is_active
      and u.admin_role::text in ('super_admin', 'admin_operator_donhang')
  )
$$;

create or replace function public.velura_enqueue_order_email(
  p_recipient text,
  p_template_code text,
  p_subject text,
  p_body text,
  p_user_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if nullif(btrim(p_recipient), '') is null then return; end if;
  insert into public.email_outbox (
    email_id, recipient, template_code, subject, body, status, attempts,
    next_attempt_at, related_user_id, metadata, created_at, updated_at
  ) values (
    gen_random_uuid(), btrim(p_recipient), p_template_code, p_subject, p_body,
    'pending', 0, now(), p_user_id, coalesce(p_metadata, '{}'::jsonb), now(), now()
  );
end;
$$;

create or replace function public.admin_change_order_status(
  p_order_id uuid,
  p_new_status text,
  p_reason text,
  p_tracking_code text,
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
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_status public.orders.status%type;
  v_customer_email text;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'ORDER_REASON_REQUIRED';
  end if;

  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text in ('completed', 'cancelled') then
    raise sqlstate 'PT422' using message = 'ORDER_TERMINAL';
  end if;
  if p_new_status = 'cancelled' then
    raise sqlstate 'PT422' using message = 'USE_CANCEL_ACTION';
  end if;
  if not (
    (v_before.status::text = 'pending' and p_new_status = 'confirmed')
    or (v_before.status::text = 'confirmed' and p_new_status = 'preparing')
    or (v_before.status::text = 'preparing' and p_new_status = 'shipping')
    or (v_before.status::text = 'shipping' and p_new_status in ('delivered', 'failed_delivery'))
    or (v_before.status::text = 'failed_delivery' and p_new_status = 'shipping')
    or (v_before.status::text = 'delivered' and p_new_status = 'completed')
  ) then
    raise sqlstate 'PT422' using message = 'INVALID_ORDER_TRANSITION';
  end if;
  if p_new_status = 'shipping' and nullif(btrim(p_tracking_code), '') is null then
    raise sqlstate 'PT422' using message = 'TRACKING_CODE_REQUIRED';
  end if;

  select x.status into v_status
  from jsonb_populate_record(null::public.orders, jsonb_build_object('status', p_new_status)) x;

  update public.orders
  set status = v_status,
      tracking_code = case when p_new_status = 'shipping' then btrim(p_tracking_code) else tracking_code end,
      delivered_at = case when p_new_status = 'delivered' then now() else delivered_at end,
      version = version + 1,
      updated_at = now()
  where order_id = p_order_id and version = p_expected_version
  returning * into v_after;
  if v_after.order_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  insert into public.order_status_history (
    history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
  )
  select
    x.history_id, x.order_id, x.old_status, x.new_status,
    x.trigger_type, x.changed_by, x.changed_at, x.note
  from jsonb_populate_record(
    null::public.order_status_history,
    jsonb_build_object(
      'history_id', gen_random_uuid(), 'order_id', p_order_id,
      'old_status', v_before.status::text, 'new_status', p_new_status,
      'trigger_type', 'manual', 'changed_by', v_actor.user_id,
      'changed_at', now(), 'note', btrim(p_reason)
    )
  ) x;

  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'tracking_code', v_after.tracking_code),
    p_ip_address
  );

  select email into v_customer_email from public.users where user_id = v_after.user_id;
  perform public.velura_enqueue_order_email(
    v_customer_email, 'order_status_changed', 'Cap nhat trang thai don hang',
    format('Don hang %s da chuyen sang trang thai %s.', p_order_id, p_new_status),
    v_after.user_id, jsonb_build_object('order_id', p_order_id, 'status', p_new_status)
  );
  return to_jsonb(v_after);
end;
$$;

create or replace function public.admin_cancel_order(
  p_order_id uuid,
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
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_cancelled_status public.orders.status%type;
  v_payment public.payment%rowtype;
  v_customer_email text;
  v_item record;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'ORDER_REASON_REQUIRED';
  end if;

  select * into v_before from public.orders where order_id = p_order_id for update;
  if v_before.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text not in ('pending', 'confirmed', 'preparing', 'failed_delivery') then
    raise sqlstate 'PT422' using message = 'ORDER_CANNOT_CANCEL';
  end if;

  perform 1
  from public.variant v
  where v.variant_id in (select oi.variant_id from public.order_item oi where oi.order_id = p_order_id)
  order by v.variant_id
  for update;

  for v_item in
    select oi.variant_id, sum(oi.quantity)::integer as quantity
    from public.order_item oi where oi.order_id = p_order_id group by oi.variant_id
  loop
    update public.variant
    set stock_quantity = stock_quantity + v_item.quantity,
        reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0),
        version = version + 1,
        updated_at = now()
    where variant_id = v_item.variant_id;
    if not found then raise sqlstate 'PT409' using message = 'ORDER_VARIANT_NOT_FOUND'; end if;
  end loop;

  select x.status into v_cancelled_status
  from jsonb_populate_record(null::public.orders, '{"status":"cancelled"}'::jsonb) x;
  update public.orders
  set status = v_cancelled_status,
      cancelled_reason = btrim(p_reason),
      version = version + 1,
      updated_at = now()
  where order_id = p_order_id and version = p_expected_version
  returning * into v_after;
  if v_after.order_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  select * into v_payment
  from public.payment
  where order_id = p_order_id and payment_status::text = 'paid'
  order by created_at desc limit 1 for update;
  if v_payment.payment_id is not null then
    update public.payment
    set payment_status = (
          select x.payment_status from jsonb_populate_record(
            null::public.payment, '{"payment_status":"refund_pending"}'::jsonb
          ) x
        ),
        refund_amount = amount,
        refund_reason = btrim(p_reason),
        version = version + 1,
        updated_at = now()
    where payment_id = v_payment.payment_id;
  end if;

  insert into public.order_status_history (
    history_id, order_id, old_status, new_status, trigger_type, changed_by, changed_at, note
  )
  select
    x.history_id, x.order_id, x.old_status, x.new_status,
    x.trigger_type, x.changed_by, x.changed_at, x.note
  from jsonb_populate_record(
    null::public.order_status_history,
    jsonb_build_object(
      'history_id', gen_random_uuid(), 'order_id', p_order_id,
      'old_status', v_before.status::text, 'new_status', 'cancelled',
      'trigger_type', 'manual', 'changed_by', v_actor.user_id,
      'changed_at', now(), 'note', btrim(p_reason)
    )
  ) x;

  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object(
      'status', v_after.status, 'version', v_after.version,
      'refund_status', case when v_payment.payment_id is null then 'no_refund' else 'refund_pending' end
    ),
    p_ip_address
  );

  select email into v_customer_email from public.users where user_id = v_after.user_id;
  perform public.velura_enqueue_order_email(
    v_customer_email, 'order_cancelled', 'Thong bao huy don hang',
    format('Don hang %s da bi huy. Ly do: %s', p_order_id, btrim(p_reason)),
    v_after.user_id, jsonb_build_object('order_id', p_order_id, 'refund_pending', v_payment.payment_id is not null)
  );
  return jsonb_build_object('order', to_jsonb(v_after), 'refund_pending', v_payment.payment_id is not null);
end;
$$;

create or replace function public.admin_resolve_payment(
  p_order_id uuid,
  p_payment_id uuid,
  p_decision text,
  p_reason text,
  p_expected_order_version integer,
  p_expected_payment_version integer,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_order public.orders%rowtype;
  v_before public.payment%rowtype;
  v_after public.payment%rowtype;
  v_status public.payment.payment_status%type;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if not public.velura_is_order_operator() then raise sqlstate 'PT403' using message = 'RBAC_DENIED'; end if;
  if p_decision not in ('mark_paid', 'mark_failed') then
    raise sqlstate 'PT422' using message = 'INVALID_PAYMENT_DECISION';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'PAYMENT_REASON_REQUIRED';
  end if;

  select * into v_order from public.orders where order_id = p_order_id for update;
  if v_order.order_id is null then raise sqlstate 'PT404' using message = 'ORDER_NOT_FOUND'; end if;
  if v_order.version <> p_expected_order_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_order.status::text in ('completed', 'cancelled') then
    raise sqlstate 'PT422' using message = 'ORDER_TERMINAL';
  end if;

  select * into v_before
  from public.payment where payment_id = p_payment_id and order_id = p_order_id for update;
  if v_before.payment_id is null then raise sqlstate 'PT404' using message = 'PAYMENT_NOT_FOUND'; end if;
  if v_before.version <> p_expected_payment_version then
    raise sqlstate 'PT409' using message = 'PAYMENT_VERSION_CONFLICT';
  end if;
  if v_before.payment_status::text not in ('failed', 'discrepancy') and not v_before.has_discrepancy then
    raise sqlstate 'PT422' using message = 'PAYMENT_NOT_RESOLVABLE';
  end if;

  select x.payment_status into v_status
  from jsonb_populate_record(
    null::public.payment,
    jsonb_build_object('payment_status', case when p_decision = 'mark_paid' then 'paid' else 'failed' end)
  ) x;
  update public.payment
  set payment_status = v_status,
      has_discrepancy = false,
      paid_at = case when p_decision = 'mark_paid' then coalesce(paid_at, now()) else paid_at end,
      gateway_response_code = case when p_decision = 'mark_paid' then 'ADMIN_OK' else gateway_response_code end,
      version = version + 1,
      updated_at = now()
  where payment_id = p_payment_id and version = p_expected_payment_version
  returning * into v_after;
  if v_after.payment_id is null then raise sqlstate 'PT409' using message = 'PAYMENT_VERSION_CONFLICT'; end if;

  update public.orders set version = version + 1, updated_at = now()
  where order_id = p_order_id and version = p_expected_order_version;
  if not found then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'orders', v_actor.user_id, v_actor.admin_role::text, 'update', p_order_id,
    jsonb_build_object('payment_id', p_payment_id, 'payment_status', v_before.payment_status, 'version', v_before.version),
    jsonb_build_object('payment_id', p_payment_id, 'payment_status', v_after.payment_status, 'version', v_after.version),
    p_ip_address
  );
  return to_jsonb(v_after);
end;
$$;

alter table public.orders enable row level security;
alter table public.order_item enable row level security;
alter table public.order_status_history enable row level security;
alter table public.payment enable row level security;

drop policy if exists velura_orders_select on public.orders;
drop policy if exists velura_orders_select_restriction on public.orders;
create policy velura_orders_select on public.orders for select to authenticated
using (user_id = public.velura_current_user_id() or public.velura_is_order_reader());
create policy velura_orders_select_restriction on public.orders as restrictive for select to authenticated
using (user_id = public.velura_current_user_id() or public.velura_is_order_reader());

drop policy if exists velura_order_item_select on public.order_item;
drop policy if exists velura_order_item_select_restriction on public.order_item;
create policy velura_order_item_select on public.order_item for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = order_item.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));
create policy velura_order_item_select_restriction on public.order_item as restrictive for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = order_item.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));

drop policy if exists velura_order_history_select on public.order_status_history;
drop policy if exists velura_order_history_select_restriction on public.order_status_history;
create policy velura_order_history_select on public.order_status_history for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = order_status_history.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));
create policy velura_order_history_select_restriction on public.order_status_history as restrictive for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = order_status_history.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));

drop policy if exists velura_payment_select on public.payment;
drop policy if exists velura_payment_select_restriction on public.payment;
create policy velura_payment_select on public.payment for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = payment.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));
create policy velura_payment_select_restriction on public.payment as restrictive for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.order_id = payment.order_id
    and (o.user_id = public.velura_current_user_id() or public.velura_is_order_reader())
));

revoke update, delete, truncate on public.orders, public.order_item, public.order_status_history, public.payment
from anon, authenticated;
grant select on public.orders, public.order_item, public.order_status_history, public.payment
to authenticated, service_role;

revoke all on function public.velura_is_order_reader() from public, anon;
revoke all on function public.velura_is_order_operator() from public, anon;
revoke all on function public.velura_enqueue_order_email(text, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.admin_change_order_status(uuid, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_resolve_payment(uuid, uuid, text, text, integer, integer, text) from public, anon, authenticated;

grant execute on function public.velura_is_order_reader() to authenticated;
grant execute on function public.velura_is_order_operator() to authenticated;
grant execute on function public.admin_change_order_status(uuid, text, text, text, integer, text) to authenticated;
grant execute on function public.admin_cancel_order(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_resolve_payment(uuid, uuid, text, text, integer, integer, text) to authenticated;

commit;
