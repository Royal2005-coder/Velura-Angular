begin;

-- ============================================================
-- UC-A04/A05/A06: Reviews, Returns/CSKH, Pricing RPC functions
-- ============================================================

-- Pre-flight: verify required tables
do $$
begin
  if to_regclass('public.review') is null then raise exception 'UC-A04 requires public.review'; end if;
  if to_regclass('public.return_exchange') is null then raise exception 'UC-A05 requires public.return_exchange'; end if;
  if to_regclass('public.return_item') is null then raise exception 'UC-A05 requires public.return_item'; end if;
  if to_regclass('public.support_ticket') is null then raise exception 'UC-A05 requires public.support_ticket'; end if;
  if to_regclass('public.price_history') is null then raise exception 'UC-A06 requires public.price_history'; end if;
  if to_regclass('public.promotion') is null then raise exception 'UC-A06 requires public.promotion'; end if;
  if to_regclass('public.voucher') is null then raise exception 'UC-A06 requires public.voucher'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'UC-A04/05/06 requires public.audit_log'; end if;
end $$;

-- Add version/updated_at columns where missing
alter table public.review add column if not exists version integer not null default 1 check (version > 0);
alter table public.review add column if not exists updated_at timestamptz not null default now();
alter table public.return_exchange add column if not exists version integer not null default 1 check (version > 0);
alter table public.return_exchange add column if not exists updated_at timestamptz not null default now();
alter table public.support_ticket add column if not exists version integer not null default 1 check (version > 0);
alter table public.support_ticket add column if not exists updated_at timestamptz not null default now();
alter table public.promotion add column if not exists version integer not null default 1 check (version > 0);
alter table public.promotion add column if not exists updated_at timestamptz not null default now();
alter table public.voucher add column if not exists version integer not null default 1 check (version > 0);
alter table public.voucher add column if not exists updated_at timestamptz not null default now();

-- Indexes
create index if not exists idx_review_status_submitted on public.review(status, submitted_at desc);
create index if not exists idx_review_product on public.review(product_id);
create index if not exists idx_return_exchange_status on public.return_exchange(status, created_at desc);
create index if not exists idx_return_exchange_order on public.return_exchange(order_id);
create index if not exists idx_support_ticket_status on public.support_ticket(status, created_at desc);
create index if not exists idx_promotion_active on public.promotion(is_active, start_date desc);
create index if not exists idx_voucher_code on public.voucher(code);
create index if not exists idx_voucher_active on public.voucher(is_active, start_date desc);
create index if not exists idx_price_history_product on public.price_history(product_id, changed_at desc);

-- Triggers for updated_at
drop trigger if exists trg_review_touch_updated_at on public.review;
create trigger trg_review_touch_updated_at before update on public.review
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_return_exchange_touch_updated_at on public.return_exchange;
create trigger trg_return_exchange_touch_updated_at before update on public.return_exchange
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_support_ticket_touch_updated_at on public.support_ticket;
create trigger trg_support_ticket_touch_updated_at before update on public.support_ticket
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_promotion_touch_updated_at on public.promotion;
create trigger trg_promotion_touch_updated_at before update on public.promotion
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_voucher_touch_updated_at on public.voucher;
create trigger trg_voucher_touch_updated_at before update on public.voucher
for each row execute function public.velura_touch_updated_at();

-- ============================================================
-- UC-A04: Review RPC functions
-- ============================================================

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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text <> 'pending' then
    raise sqlstate 'PT422' using message = 'REVIEW_CANNOT_APPROVE';
  end if;

  update public.review
  set status = 'approved'::review_status,
      admin_reply = p_action_note,
      moderated_by = public.velura_current_user_id(),
      moderated_at = now(),
      is_flagged_urgent = false,
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', public.velura_current_user_id(), 'admin', 'update', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.review
  set status = 'rejected'::public.review_status,
      rejection_reason = btrim(p_reason),
      moderated_by = public.velura_current_user_id(),
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', public.velura_current_user_id(), 'admin', 'update', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
begin
  if p_reply is null or length(btrim(p_reply)) < 1 then
    raise sqlstate 'PT422' using message = 'REPLY_REQUIRED';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  update public.review
  set admin_reply = btrim(p_reply),
      moderated_by = public.velura_current_user_id(),
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', public.velura_current_user_id(), 'admin', 'reply', p_review_id,
    jsonb_build_object('admin_reply', v_before.admin_reply, 'version', v_before.version),
    jsonb_build_object('admin_reply', v_after.admin_reply, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.review%rowtype;
  v_after public.review%rowtype;
  v_ticket_id uuid;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;

  select * into v_before from public.review where review_id = p_review_id for update;
  if v_before.review_id is null then raise sqlstate 'PT404' using message = 'REVIEW_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  -- Create support ticket from review
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
      moderated_by = public.velura_current_user_id(),
      moderated_at = now(),
      version = version + 1,
      updated_at = now()
  where review_id = p_review_id and version = p_expected_version
  returning * into v_after;
  if v_after.review_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'reviews', public.velura_current_user_id(), 'admin', 'escalate', p_review_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'ticket_id', v_ticket_id),
    p_ip_address
  );

  return jsonb_build_object('review', to_jsonb(v_after), 'ticket_id', v_ticket_id);
end;
$$;

-- ============================================================
-- UC-A05: Return/Exchange RPC functions
-- ============================================================

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
  v_before public.return_exchange%rowtype;
  v_after public.return_exchange%rowtype;
begin
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
    'returns', public.velura_current_user_id(), 'admin', 'approve_refund', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'refund_amount', v_after.refund_amount),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.return_exchange%rowtype;
  v_after public.return_exchange%rowtype;
  v_new_order_id uuid;
begin
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
    'returns', public.velura_current_user_id(), 'admin', 'approve_exchange', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'exchange_order_id', v_new_order_id),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.return_exchange%rowtype;
  v_after public.return_exchange%rowtype;
begin
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
    'returns', public.velura_current_user_id(), 'admin', 'reject', p_return_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- Support ticket RPCs
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
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  if p_assigned_to is null or length(btrim(p_assigned_to)) = 0 then
    raise sqlstate 'PT422' using message = 'ASSIGNEE_REQUIRED';
  end if;

  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then
    raise sqlstate 'PT422' using message = 'TICKET_CLOSED';
  end if;

  update public.support_ticket
  set status = 'processing'::public.ticket_status,
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', public.velura_current_user_id(), 'admin', 'assign', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version, 'assigned_to', p_assigned_to),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  if p_response is null or length(btrim(p_response)) < 1 then
    raise sqlstate 'PT422' using message = 'RESPONSE_REQUIRED';
  end if;

  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then
    raise sqlstate 'PT422' using message = 'TICKET_CLOSED';
  end if;

  update public.support_ticket
  set admin_reply = btrim(p_response),
      status = 'processing'::public.ticket_status,
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', public.velura_current_user_id(), 'admin', 'respond', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.support_ticket%rowtype;
  v_after public.support_ticket%rowtype;
begin
  select * into v_before from public.support_ticket where ticket_id = p_ticket_id for update;
  if v_before.ticket_id is null then raise sqlstate 'PT404' using message = 'TICKET_NOT_FOUND'; end if;
  if v_before.version <> p_expected_version then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;
  if v_before.status::text = 'closed' then
    raise sqlstate 'PT422' using message = 'TICKET_ALREADY_CLOSED';
  end if;

  update public.support_ticket
  set status = 'closed'::public.ticket_status,
      resolved_at = now(),
      version = version + 1,
      updated_at = now()
  where ticket_id = p_ticket_id and version = p_expected_version
  returning * into v_after;
  if v_after.ticket_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'support_tickets', public.velura_current_user_id(), 'admin', 'close', p_ticket_id,
    jsonb_build_object('status', v_before.status, 'version', v_before.version),
    jsonb_build_object('status', v_after.status, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- ============================================================
-- UC-A06: Pricing/Promotion/Voucher RPC functions
-- ============================================================

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
  v_before public.product%rowtype;
  v_after public.product%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_10_CHARS';
  end if;
  if p_new_sale_price < 0 then
    raise sqlstate 'PT422' using message = 'PRICE_NON_NEGATIVE';
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
    public.velura_current_user_id(), now(), btrim(p_reason)
  );

  update public.product
  set sale_price = p_new_sale_price,
      version = version + 1,
      updated_at = now()
  where product_id = p_product_id and version = p_expected_version
  returning * into v_after;
  if v_after.product_id is null then raise sqlstate 'PT409' using message = 'VERSION_CONFLICT'; end if;

  perform public.velura_append_module_audit(
    'pricing', public.velura_current_user_id(), 'admin', 'change_price', p_product_id,
    jsonb_build_object('sale_price', v_before.sale_price, 'version', v_before.version),
    jsonb_build_object('sale_price', v_after.sale_price, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_new public.promotion%rowtype;
  v_promo_type public.promotion.promo_type%type;
begin
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
    p_max_vouchers_allowed, 0, public.velura_current_user_id()
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'promotions', public.velura_current_user_id(), 'admin', 'create', v_new.promo_id,
    null,
    to_jsonb(v_new),
    p_ip_address
  );

  return to_jsonb(v_new);
end;
$$;

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
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
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
    'promotions', public.velura_current_user_id(), 'admin', 'update', p_promo_id,
    jsonb_build_object('version', v_before.version),
    jsonb_build_object('version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
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
    'promotions', public.velura_current_user_id(), 'admin', 'activate', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

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
  v_before public.promotion%rowtype;
  v_after public.promotion%rowtype;
begin
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
    'promotions', public.velura_current_user_id(), 'admin', 'pause', p_promo_id,
    jsonb_build_object('is_active', v_before.is_active, 'version', v_before.version),
    jsonb_build_object('is_active', v_after.is_active, 'version', v_after.version),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- Voucher RPCs
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
  v_new public.voucher%rowtype;
  v_disc_type public.voucher.discount_type%type;
  v_user_group public.voucher.applicable_user_group%type;
begin
  if p_code is null or length(btrim(p_code)) = 0 then
    raise sqlstate 'PT422' using message = 'CODE_REQUIRED';
  end if;
  -- Check unique code
  if exists (select 1 from public.voucher where code = btrim(p_code)) then
    raise sqlstate 'PT409' using message = 'VOUCHER_CODE_EXISTS';
  end if;

  select x.discount_type into v_disc_type
  from jsonb_populate_record(null::public.voucher, jsonb_build_object('discount_type', p_discount_type)) x;

  v_user_group := 'all_users'::public.applicable_user_group;

  insert into public.voucher (
    voucher_id, promo_id, code, name, discount_type, discount_value,
    max_discount_amount, min_order_value, usage_limit_total, usage_limit_per_user,
    used_count, applicable_categories, applicable_user_group,
    start_date, end_date, is_active, created_by
  ) values (
    gen_random_uuid(), p_promo_id, btrim(p_code), btrim(p_name), v_disc_type, p_discount_value,
    p_max_discount_amount, p_min_order_value, p_usage_limit_total, p_usage_limit_per_user,
    0, p_applicable_categories, v_user_group,
    p_start_date, p_end_date, true, public.velura_current_user_id()
  ) returning * into v_new;

  perform public.velura_append_module_audit(
    'vouchers', public.velura_current_user_id(), 'admin', 'create', v_new.voucher_id,
    null, to_jsonb(v_new), p_ip_address
  );

  return to_jsonb(v_new);
end;
$$;

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
  v_before public.voucher%rowtype;
  v_after public.voucher%rowtype;
begin
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
    'vouchers', public.velura_current_user_id(), 'admin', 'update', p_voucher_id,
    jsonb_build_object('version', v_before.version, 'is_active', v_before.is_active),
    jsonb_build_object('version', v_after.version, 'is_active', v_after.is_active),
    p_ip_address
  );

  return to_jsonb(v_after);
end;
$$;

-- ============================================================
-- GRANTs
-- ============================================================

-- Revoke from anon/authenticated for all new RPCs
revoke all on function public.admin_approve_review(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_hide_review(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_reply_review(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_escalate_review(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_approve_refund(uuid, numeric, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_approve_exchange(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_reject_return(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_assign_ticket(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_respond_ticket(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_close_ticket(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_change_product_price(uuid, numeric, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_create_promotion(varchar, timestamptz, timestamptz, text, text, jsonb, numeric, integer, text) from public, anon, authenticated;
revoke all on function public.admin_update_promotion(uuid, integer, varchar, text, jsonb, numeric, text) from public, anon, authenticated;
revoke all on function public.admin_activate_promotion(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.admin_pause_promotion(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.admin_create_voucher(varchar, varchar, text, numeric, timestamptz, timestamptz, uuid, numeric, numeric, integer, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_update_voucher(uuid, integer, boolean, varchar, text) from public, anon, authenticated;

-- Grant to authenticated
grant execute on function public.admin_approve_review(uuid, integer, text, text) to authenticated;
grant execute on function public.admin_hide_review(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_reply_review(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_escalate_review(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_approve_refund(uuid, numeric, integer, text, text) to authenticated;
grant execute on function public.admin_approve_exchange(uuid, integer, text, text) to authenticated;
grant execute on function public.admin_reject_return(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_assign_ticket(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_respond_ticket(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_close_ticket(uuid, integer, text, text) to authenticated;
grant execute on function public.admin_change_product_price(uuid, numeric, text, integer, text) to authenticated;
grant execute on function public.admin_create_promotion(varchar, timestamptz, timestamptz, text, text, jsonb, numeric, integer, text) to authenticated;
grant execute on function public.admin_update_promotion(uuid, integer, varchar, text, jsonb, numeric, text) to authenticated;
grant execute on function public.admin_activate_promotion(uuid, integer, text) to authenticated;
grant execute on function public.admin_pause_promotion(uuid, integer, text) to authenticated;
grant execute on function public.admin_create_voucher(varchar, varchar, text, numeric, timestamptz, timestamptz, uuid, numeric, numeric, integer, integer, jsonb, text) to authenticated;
grant execute on function public.admin_update_voucher(uuid, integer, boolean, varchar, text) to authenticated;

-- Grant SELECT on tables for service_role (already done via grant script, but ensure)
grant select on public.review, public.return_exchange, public.return_item, public.support_ticket,
  public.price_history, public.promotion, public.promotion_product, public.voucher
to service_role;

commit;
