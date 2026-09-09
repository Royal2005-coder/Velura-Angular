-- Fix all RPC functions: add actor lookup and use v_actor.admin_role instead of hardcoded 'admin'
-- This is a patch that re-creates the affected functions with correct audit role

-- A04: admin_approve_review
create or replace function public.admin_approve_review(
  p_review_id uuid,
  p_expected_version integer default 0,
  p_action_note text default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text <> 'pending' then
    raise sqlstate 'PT422' using message = 'REVIEW_CANNOT_APPROVE';
  end if;

  update public.review
  set status = 'approved'::review_status,
      admin_reply = p_action_note,
      moderated_by = v_actor.user_id,
      moderated_at = now(),
      is_flagged_urgent = false,
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', v_actor.user_id, v_actor.admin_role::text, 'update', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A04: admin_hide_review
create or replace function public.admin_hide_review(
  p_review_id uuid,
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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.review
  set status = 'rejected'::public.review_status,
      rejection_reason = btrim(p_reason),
      moderated_by = v_actor.user_id,
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', v_actor.user_id, v_actor.admin_role::text, 'update', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A04: admin_reply_review
create or replace function public.admin_reply_review(
  p_review_id uuid,
  p_reply text,
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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_reply is null or length(btrim(p_reply)) < 1 then
    raise sqlstate 'PT422' using message = 'REPLY_REQUIRED';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.review
  set admin_reply = btrim(p_reply),
      moderated_by = v_actor.user_id,
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', v_actor.user_id, v_actor.admin_role::text, 'reply', p_review_id,
    jsonb_build_object('admin_reply', v_before.admin_reply, 'version', v_before.version),
    jsonb_build_object('admin_reply', v_after.admin_reply, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A04: admin_escalate_review
create or replace function public.admin_escalate_review(
  p_review_id uuid,
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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
  v_ticket_id uuid;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  v_ticket_id := gen_random_uuid();
  insert into public.support_ticket (
    ticket_id, user_id, guest_phone, guest_email, title, description,
    priority, status, admin_reply, created_at, resolved_at
  ) values (
    v_ticket_id, v_before.user_id, null, null,
    'Escalated from review ' || p_review_id,
    btrim(p_reason),
    'high'::public.ticket_priority,
    'open'::public.ticket_status,
    null, now(), null
  );

  update public.review
  set status = 'rejected'::public.review_status,
      is_flagged_urgent = true,
      moderated_by = v_actor.user_id,
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', v_actor.user_id, v_actor.admin_role::text, 'escalate', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'ticket_id', v_ticket_id),
    p_ip_address
  );

  return jsonb_build_object('review', to_jsonb(v_after), 'ticket_id', v_ticket_id);
end;
$$;

-- A05: admin_approve_refund
create or replace function public.admin_approve_refund(
  p_return_id uuid,
  p_refund_amount numeric,
  p_expected_version integer default 0,
  p_admin_note text default '',
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
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_refund_amount is null or p_refund_amount <= 0 then
    raise sqlstate 'PT422' using message = 'REFUND_AMOUNT_REQUIRED';
  end if;

  select * into v_before from public.return_exchange where return_id = p_return_id for update;
  if v_before.return_id is null then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text <> 'pending' then
    raise sqlstate 'PT422' using message = 'RETURN_NOT_PENDING';
  end if;

  update public.return_exchange
  set status = 'approved'::public.return_status,
      refund_amount = p_refund_amount,
      admin_note = btrim(p_admin_note),
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where return_id = p_return_id and version = p_expected_version
  returning * into v_after;
  if v_after.return_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'returns', v_actor.user_id, v_actor.admin_role::text, 'approve_refund', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'refund_amount', v_after.refund_amount),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A05: admin_approve_exchange
create or replace function public.admin_approve_exchange(
  p_return_id uuid,
  p_expected_version integer default 0,
  p_admin_note text default '',
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
  if v_before.status::text <> 'pending' then
    raise sqlstate 'PT422' using message = 'RETURN_NOT_PENDING';
  end if;

  v_new_order_id := gen_random_uuid();
  update public.return_exchange
  set status = 'approved'::public.return_status,
      exchange_order_id = v_new_order_id,
      admin_note = btrim(p_admin_note),
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where return_id = p_return_id and version = p_expected_version
  returning * into v_after;
  if v_after.return_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'returns', v_actor.user_id, v_actor.admin_role::text, 'approve_exchange', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'exchange_order_id', v_new_order_id),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A05: admin_reject_return
create or replace function public.admin_reject_return(
  p_return_id uuid,
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
  v_before public.return_exchange%rowtype;
  v_after public.return_exchange%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.return_exchange where return_id = p_return_id for update;
  if v_before.return_id is null then raise sqlstate 'PT404' using message = 'RETURN_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text <> 'pending' then
    raise sqlstate 'PT422' using message = 'RETURN_NOT_PENDING';
  end if;

  update public.return_exchange
  set status = 'rejected'::public.return_status,
      rejection_reason = btrim(p_reason),
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where return_id = p_return_id and version = p_expected_version
  returning * into v_after;
  if v_after.return_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'returns', v_actor.user_id, v_actor.admin_role::text, 'reject', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A05: admin_assign_ticket
create or replace function public.admin_assign_ticket(
  p_ticket_id uuid,
  p_assigned_to text,
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
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then raise sqlstate 'PT422' using message = 'TICKET_CLOSED'; end if;

  update public.support_ticket
  set status = 'processing'::public.ticket_status,
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', v_actor.user_id, v_actor.admin_role::text, 'assign', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'assigned_to', p_assigned_to),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A05: admin_respond_ticket
create or replace function public.admin_respond_ticket(
  p_ticket_id uuid,
  p_response text,
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
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_response is null or length(btrim(p_response)) < 1 then
    raise sqlstate 'PT422' using message = 'RESPONSE_REQUIRED';
  end if;

  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then raise sqlstate 'PT422' using message = 'TICKET_CLOSED'; end if;

  update public.support_ticket
  set admin_reply = btrim(p_response),
      status = 'processing'::public.ticket_status,
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', v_actor.user_id, v_actor.admin_role::text, 'respond', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A05: admin_close_ticket
create or replace function public.admin_close_ticket(
  p_ticket_id uuid,
  p_expected_version integer default 0,
  p_reason text default '',
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then raise sqlstate 'PT422' using message = 'TICKET_ALREADY_CLOSED'; end if;

  update public.support_ticket
  set status = 'closed'::public.ticket_status,
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', v_actor.user_id, v_actor.admin_role::text, 'close', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A06: admin_change_product_price
create or replace function public.admin_change_product_price(
  p_product_id uuid,
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
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.product where product_id = p_product_id for update;
  if v_before.product_id is null then raise sqlstate 'PT404' using message = 'PRODUCT_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  insert into public.price_history (
    price_history_id, product_id, variant_id,
    old_base_price, new_base_price, old_sale_price, new_sale_price,
    changed_by, changed_at, reason
  ) values (
    gen_random_uuid(), p_product_id, null,
    v_before.base_price, v_before.base_price,
    v_before.sale_price, p_new_sale_price,
    v_actor.user_id, now(), btrim(p_reason)
  );

  update public.product
  set sale_price = p_new_sale_price,
      version = version + 1,
      updated_at = now()
  where product_id = p_product_id and version = p_expected_version
  returning * into v_after;
  if v_after.product_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'pricing', v_actor.user_id, v_actor.admin_role::text, 'change_price', p_product_id,
    jsonb_build_object('sale_price', v_before.sale_price, 'version', v_before.version),
    jsonb_build_object('sale_price', v_after.sale_price, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A06: admin_create_promotion
create or replace function public.admin_create_promotion(
  p_name varchar,
  p_start_date timestamptz,
  p_end_date timestamptz,
  p_promo_type text default 'product_discount',
  p_description text default '',
  p_applicable_categories jsonb default null,
  p_budget_limit numeric default 0,
  p_max_vouchers_allowed integer default 0,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_new public.promotion%rowtype;
  v_promo_type public.promotion.promo_type%type;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  if p_name is null or length(btrim(p_name)) = 0 then
    raise sqlstate 'PT422' using message = 'NAME_REQUIRED';
  end if;
  if p_start_date is null or p_end_date is null then
    raise sqlstate 'PT422' using message = 'DATES_REQUIRED';
  end if;
  if p_start_date >= p_end_date then
    raise sqlstate 'PT422' using message = 'END_AFTER_START';
  end if;

  select x.promo_type into v_promo_type
  from jsonb_populate_record(null::public.promotion, jsonb_build_object('promo_type', p_promo_type)) x;

  insert into public.promotion (
    promo_id, promo_name, promo_type, applicable_categories,
    start_date, end_date, is_active, budget_limit,
    max_vouchers_allowed, total_discount_issued, created_by
  ) values (
    gen_random_uuid(), btrim(p_name), v_promo_type, p_applicable_categories,
    p_start_date, p_end_date, false, p_budget_limit,
    p_max_vouchers_allowed, 0, v_actor.user_id
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'create', v_new.promo_id,
    null, to_jsonb(v_new), p_ip_address
  );

  return to_jsonb(v_new);
end;
$$;

-- A06: admin_activate_promotion
create or replace function public.admin_activate_promotion(
  p_promo_id uuid,
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
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.is_active then raise sqlstate 'PT422' using message = 'ALREADY_ACTIVE'; end if;
  if now() < v_before.start_date or now() > v_before.end_date then
    raise sqlstate 'PT422' using message = 'OUTSIDE_DATE_RANGE';
  end if;

  update public.promotion
  set is_active = true, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'activate', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A06: admin_pause_promotion
create or replace function public.admin_pause_promotion(
  p_promo_id uuid,
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
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if not v_before.is_active then raise sqlstate 'PT422' using message = 'NOT_ACTIVE'; end if;

  update public.promotion
  set is_active = false, version = version + 1, updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'pause', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A06: admin_create_voucher
create or replace function public.admin_create_voucher(
  p_code varchar,
  p_name varchar,
  p_discount_type text,
  p_discount_value numeric,
  p_start_date timestamptz,
  p_end_date timestamptz,
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
  v_new public.voucher%rowtype;
  v_disc_type public.voucher.discount_type%type;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
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

-- A06: admin_update_promotion
create or replace function public.admin_update_promotion(
  p_promo_id uuid,
  p_expected_version integer default 0,
  p_name varchar default null,
  p_description text default null,
  p_applicable_categories jsonb default null,
  p_budget_limit numeric default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.promotion where promo_id = p_promo_id for update;
  if v_before.promo_id is null then raise sqlstate 'PT404' using message = 'PROMOTION_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.promotion
  set promo_name = coalesce(btrim(p_name), promo_name),
      applicable_categories = coalesce(p_applicable_categories, applicable_categories),
      budget_limit = coalesce(p_budget_limit, budget_limit),
      version = version + 1,
      updated_at = now()
  where promo_id = p_promo_id and version = p_expected_version
  returning * into v_after;
  if v_after.promo_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'promotions', v_actor.user_id, v_actor.admin_role::text, 'update', p_promo_id,
    jsonb_build_object('version', v_before.version),
    jsonb_build_object('version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- A06: admin_update_voucher
create or replace function public.admin_update_voucher(
  p_voucher_id uuid,
  p_expected_version integer default 0,
  p_is_active boolean default null,
  p_name varchar default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.voucher%rowtype;
  v_after public.voucher%rowtype;
begin
  select * into v_actor from public.users where user_id = public.velura_current_user_id();
  select * into v_before from public.voucher where voucher_id = p_voucher_id for update;
  if v_before.voucher_id is null then raise sqlstate 'PT404' using message = 'VOUCHER_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.voucher
  set is_active = coalesce(p_is_active, is_active),
      name = coalesce(btrim(p_name), name),
      version = version + 1,
      updated_at = now()
  where voucher_id = p_voucher_id and version = p_expected_version
  returning * into v_after;
  if v_after.voucher_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'vouchers', v_actor.user_id, v_actor.admin_role::text, 'update', p_voucher_id,
    jsonb_build_object('version', v_before.version, 'is_active', v_before.is_active),
    jsonb_build_object('version', v_after.version, 'is_active', v_after.is_active),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;
