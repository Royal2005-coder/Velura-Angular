begin;

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'UC-A01 requires canonical table public.users';
  end if;
  if to_regclass('public.approval_admin_request') is null then
    raise exception 'UC-A01 requires canonical table public.approval_admin_request';
  end if;
  if to_regclass('public.audit_log') is null then
    raise exception 'UC-A01 requires canonical table public.audit_log';
  end if;
end $$;

-- Supabase Auth owns password credentials. The public profile must not duplicate
-- the password hash; the legacy column remains only for backward compatibility.
alter table public.users alter column password_hash drop not null;
alter table public.users add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table public.users add column if not exists lock_type text check (lock_type in ('temporary', 'permanent'));
alter table public.users add column if not exists lock_reason text;
alter table public.users add column if not exists unlock_reason text;
alter table public.users add column if not exists locked_by uuid references public.users(user_id) on delete set null;
alter table public.users add column if not exists locked_at timestamptz;
alter table public.users add column if not exists version integer not null default 1 check (version > 0);
alter table public.users add column if not exists updated_at timestamptz not null default now();
alter table public.users add column if not exists is_verified boolean not null default false;

update public.users u
set auth_user_id = u.user_id
from auth.users au
where au.id = u.user_id
  and u.auth_user_id is null;

create unique index if not exists uq_users_auth_user_id
  on public.users(auth_user_id)
  where auth_user_id is not null;
create index if not exists idx_users_admin_account_filter
  on public.users(role, admin_role, is_active, created_at desc);
create index if not exists idx_users_email_lower on public.users(lower(email));
create index if not exists idx_users_phone on public.users(phone) where phone is not null;

alter table public.approval_admin_request
  alter column request_id set default gen_random_uuid();
alter table public.approval_admin_request
  alter column status set default 'pending';
alter table public.approval_admin_request
  alter column created_at set default now();
alter table public.approval_admin_request
  add column if not exists expires_at timestamptz not null default (now() + interval '10 days');
alter table public.approval_admin_request
  add column if not exists target_version integer not null default 1;
alter table public.approval_admin_request
  add column if not exists version integer not null default 1 check (version > 0);

create unique index if not exists uq_admin_request_pending_target_role
  on public.approval_admin_request(target_user_id, requested_role)
  where status = 'pending';
create index if not exists idx_admin_request_status_expires
  on public.approval_admin_request(status, expires_at);

create table if not exists public.email_outbox (
  email_id uuid primary key default gen_random_uuid(),
  recipient text not null,
  template_code text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  related_user_id uuid references public.users(user_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_outbox_dispatch
  on public.email_outbox(status, next_attempt_at)
  where status in ('pending', 'failed') and attempts < 3;

create or replace function public.velura_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_users_touch_updated_at on public.users;
create trigger trg_users_touch_updated_at
before update on public.users
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_email_outbox_touch_updated_at on public.email_outbox;
create trigger trg_email_outbox_touch_updated_at
before update on public.email_outbox
for each row execute function public.velura_touch_updated_at();

create or replace function public.velura_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  insert into public.users (
    user_id,
    auth_user_id,
    email,
    phone,
    full_name,
    role,
    admin_role,
    is_active,
    is_verified,
    created_at,
    updated_at
  )
  values (
    new.id,
    new.id,
    new.email,
    new.phone,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      new.phone,
      'Nguoi dung Velura'
    ),
    'member',
    null,
    true,
    new.email_confirmed_at is not null or new.phone_confirmed_at is not null,
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (user_id) do update
  set auth_user_id = excluded.auth_user_id,
      email = coalesce(public.users.email, excluded.email),
      phone = coalesce(public.users.phone, excluded.phone),
      is_verified = excluded.is_verified,
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_velura_auth_user_created on auth.users;
create trigger trg_velura_auth_user_created
after insert on auth.users
for each row execute function public.velura_handle_new_auth_user();

create or replace function public.velura_current_user_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select u.user_id
  from public.users u
  where u.auth_user_id = auth.uid()
     or (u.auth_user_id is null and u.user_id = auth.uid())
  limit 1
$$;

create or replace function public.velura_is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select coalesce((
    select u.role::text = 'admin' and u.is_active
    from public.users u
    where u.user_id = public.velura_current_user_id()
  ), false)
$$;

create or replace function public.velura_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select coalesce((
    select u.role::text = 'admin'
       and u.admin_role::text = 'super_admin'
       and u.is_active
    from public.users u
    where u.user_id = public.velura_current_user_id()
  ), false)
$$;

create or replace function public.velura_reason_word_count(p_value text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when nullif(btrim(p_value), '') is null then 0
    else cardinality(regexp_split_to_array(btrim(p_value), E'\\s+'))
  end
$$;

create or replace function public.velura_safe_user(p_user public.users)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'user_id', p_user.user_id,
    'email', p_user.email,
    'phone', p_user.phone,
    'full_name', p_user.full_name,
    'date_of_birth', p_user.date_of_birth,
    'gender', p_user.gender,
    'avatar', p_user.avatar,
    'role', p_user.role,
    'admin_role', p_user.admin_role,
    'is_active', p_user.is_active,
    'is_verified', p_user.is_verified,
    'failed_login_count', p_user.failed_login_count,
    'locked_until', p_user.locked_until,
    'lock_type', p_user.lock_type,
    'lock_reason', p_user.lock_reason,
    'unlock_reason', p_user.unlock_reason,
    'locked_by', p_user.locked_by,
    'locked_at', p_user.locked_at,
    'created_at', p_user.created_at,
    'last_login_at', p_user.last_login_at,
    'version', p_user.version,
    'updated_at', p_user.updated_at
  )
$$;

create or replace function public.velura_append_audit(
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
  v_ip_address public.audit_log.ip_address%type;
begin
  select x.actor_role, x.action, x.ip_address
  into v_actor_role, v_action, v_ip_address
  from jsonb_populate_record(
    null::public.audit_log,
    jsonb_build_object(
      'actor_role', p_actor_role,
      'action', p_action,
      'ip_address', coalesce(nullif(p_ip_address, ''), '0.0.0.0')
    )
  ) x;

  insert into public.audit_log (
    audit_id,
    actor_id,
    actor_role,
    action,
    module,
    target_id,
    old_value,
    new_value,
    ip_address,
    timestamp
  )
  values (
    gen_random_uuid(),
    p_actor_id,
    v_actor_role,
    v_action,
    'accounts',
    p_target_id,
    p_old_value,
    p_new_value,
    v_ip_address,
    now()
  );
end;
$$;

create or replace function public.velura_enqueue_account_email(
  p_recipient text,
  p_template_code text,
  p_subject text,
  p_body text,
  p_related_user_id uuid
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.email_outbox (
    recipient,
    template_code,
    subject,
    body,
    related_user_id
  )
  select p_recipient, p_template_code, p_subject, p_body, p_related_user_id
  where nullif(btrim(p_recipient), '') is not null
$$;

create or replace function public.velura_expire_admin_requests()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.approval_admin_request%rowtype;
  v_target public.users%rowtype;
  v_expired integer := 0;
begin
  for v_request in
    select *
    from public.approval_admin_request
    where status::text = 'pending'
      and expires_at <= now()
    for update skip locked
  loop
    update public.approval_admin_request
    set status = 'expired',
        action_note = coalesce(action_note, 'Expired automatically after 10 days'),
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id
      and status::text = 'pending';

    if found then
      select * into v_target
      from public.users
      where user_id = v_request.target_user_id;

      if v_target.user_id is not null then
        perform public.velura_enqueue_account_email(
          v_target.email,
          'super_admin_request_expired',
          'Yeu cau nang quyen da het han',
          'Yeu cau nang quyen super_admin da het han sau 10 ngay. Vai tro tai khoan khong thay doi.',
          v_target.user_id
        );
      end if;
      v_expired := v_expired + 1;
    end if;
  end loop;
  return v_expired;
end;
$$;

create or replace function public.velura_claim_email_outbox(p_limit integer default 20)
returns setof public.email_outbox
language sql
security definer
set search_path = pg_catalog, public
as $$
  with candidates as (
    select email_id
    from public.email_outbox
    where status in ('pending', 'failed')
      and attempts < 3
      and next_attempt_at <= now()
    order by created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  update public.email_outbox outbox
  set status = 'sending',
      attempts = outbox.attempts + 1,
      updated_at = now()
  from candidates
  where outbox.email_id = candidates.email_id
  returning outbox.*
$$;

create or replace function public.velura_complete_email_outbox(
  p_email_id uuid,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.email_outbox
  set status = case when p_success then 'sent' else 'failed' end,
      last_error = case when p_success then null else left(coalesce(p_error, 'Email provider failed'), 1000) end,
      next_attempt_at = case
        when p_success then next_attempt_at
        when attempts = 1 then now() + interval '1 hour'
        when attempts = 2 then now() + interval '6 hours'
        else now() + interval '24 hours'
      end,
      updated_at = now()
  where email_id = p_email_id
    and status = 'sending';
end;
$$;

create or replace function public.admin_lock_user(
  p_target_user_id uuid,
  p_lock_type text,
  p_reason text,
  p_expected_version integer,
  p_locked_until timestamptz default null,
  p_ip_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_active_super_admins integer;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_lock_type not in ('temporary', 'permanent') then
    raise sqlstate 'PT422' using message = 'INVALID_LOCK_TYPE';
  end if;
  if public.velura_reason_word_count(p_reason) <= 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_11_WORDS';
  end if;

  select * into v_before
  from public.users
  where user_id = p_target_user_id
  for update;

  if v_before.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if not v_before.is_active then
    raise sqlstate 'PT409' using message = 'ACCOUNT_ALREADY_LOCKED';
  end if;

  if v_before.role::text = 'admin' and v_before.admin_role::text = 'super_admin' then
    select count(*) into v_active_super_admins
    from public.users
    where role::text = 'admin'
      and admin_role::text = 'super_admin'
      and is_active;
    if v_active_super_admins <= 1 then
      raise sqlstate 'PT409' using message = 'LAST_SUPER_ADMIN';
    end if;
  end if;

  update public.users
  set is_active = false,
      lock_type = p_lock_type,
      lock_reason = btrim(p_reason),
      unlock_reason = null,
      locked_by = v_actor.user_id,
      locked_at = now(),
      locked_until = case when p_lock_type = 'temporary' then p_locked_until else null end,
      version = version + 1,
      updated_at = now()
  where user_id = p_target_user_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.user_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    'lock',
    v_after.user_id,
    public.velura_safe_user(v_before),
    public.velura_safe_user(v_after),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_after.email,
    'account_locked',
    'Tai khoan Velura da bi khoa',
    format('Tai khoan cua ban da bi khoa. Ly do: %s', btrim(p_reason)),
    v_after.user_id
  );

  return public.velura_safe_user(v_after);
end;
$$;

create or replace function public.admin_unlock_user(
  p_target_user_id uuid,
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
  v_before public.users%rowtype;
  v_after public.users%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if public.velura_reason_word_count(p_reason) <= 10 then
    raise sqlstate 'PT422' using message = 'REASON_MIN_11_WORDS';
  end if;

  select * into v_before
  from public.users
  where user_id = p_target_user_id
  for update;

  if v_before.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_before.is_active then
    raise sqlstate 'PT409' using message = 'ACCOUNT_ALREADY_ACTIVE';
  end if;

  update public.users
  set is_active = true,
      lock_type = null,
      unlock_reason = btrim(p_reason),
      lock_reason = null,
      locked_by = null,
      locked_at = null,
      locked_until = null,
      failed_login_count = 0,
      version = version + 1,
      updated_at = now()
  where user_id = p_target_user_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.user_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    'unlock',
    v_after.user_id,
    public.velura_safe_user(v_before),
    public.velura_safe_user(v_after),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_after.email,
    'account_unlocked',
    'Tai khoan Velura da duoc mo khoa',
    format('Tai khoan cua ban da duoc mo khoa. Ly do: %s', btrim(p_reason)),
    v_after.user_id
  );

  return public.velura_safe_user(v_after);
end;
$$;

create or replace function public.admin_change_user_role(
  p_target_user_id uuid,
  p_role text,
  p_admin_role text,
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
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_typed public.users%rowtype;
  v_request public.approval_admin_request%rowtype;
  v_active_super_admins integer;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;

  if p_role not in ('member', 'admin') then
    raise sqlstate 'PT422' using message = 'INVALID_ROLE';
  end if;
  if p_role = 'admin' and p_admin_role not in (
    'admin_viewer',
    'admin_operator_sanpham',
    'admin_operator_donhang',
    'admin_operator_cskh_dt',
    'admin_operator_gia_km',
    'admin_operator_danhgia_review',
    'super_admin'
  ) then
    raise sqlstate 'PT422' using message = 'INVALID_ADMIN_ROLE';
  end if;
  if p_role = 'member' and p_admin_role is not null then
    raise sqlstate 'PT422' using message = 'ADMIN_ROLE_NOT_ALLOWED';
  end if;

  select * into v_before
  from public.users
  where user_id = p_target_user_id
  for update;

  if v_before.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;
  if v_before.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  if p_role = 'admin'
     and p_admin_role = 'super_admin'
     and not (v_before.role::text = 'admin' and v_before.admin_role::text = 'super_admin') then
    if exists (
      select 1
      from public.approval_admin_request
      where target_user_id = p_target_user_id
        and requested_role = 'super_admin'
        and status::text = 'pending'
    ) then
      raise sqlstate 'PT409' using message = 'PENDING_APPROVAL_EXISTS';
    end if;

    insert into public.approval_admin_request (
      requester_id,
      target_user_id,
      requested_role,
      status,
      created_at,
      expires_at,
      target_version,
      version
    )
    values (
      v_actor.user_id,
      v_before.user_id,
      'super_admin',
      'pending',
      now(),
      now() + interval '10 days',
      v_before.version,
      1
    )
    returning * into v_request;

    perform public.velura_append_audit(
      v_actor.user_id,
      v_actor.admin_role::text,
      'create',
      v_before.user_id,
      public.velura_safe_user(v_before),
      jsonb_build_object('approval_request', to_jsonb(v_request)),
      p_ip_address
    );
    perform public.velura_enqueue_account_email(
      v_before.email,
      'super_admin_requested',
      'Yeu cau nang quyen Velura dang cho duyet',
      'Tai khoan cua ban da duoc de xuat nang quyen super_admin va dang cho phe duyet.',
      v_before.user_id
    );

    return jsonb_build_object(
      'kind', 'approval',
      'request', to_jsonb(v_request),
      'account', public.velura_safe_user(v_before)
    );
  end if;

  if v_before.role::text = 'admin'
     and v_before.admin_role::text = 'super_admin'
     and not (p_role = 'admin' and p_admin_role = 'super_admin') then
    select count(*) into v_active_super_admins
    from public.users
    where role::text = 'admin'
      and admin_role::text = 'super_admin'
      and is_active;
    if v_active_super_admins <= 1 then
      raise sqlstate 'PT409' using message = 'LAST_SUPER_ADMIN';
    end if;
  end if;

  select * into v_typed
  from jsonb_populate_record(
    null::public.users,
    jsonb_build_object('role', p_role, 'admin_role', p_admin_role)
  );

  update public.users
  set role = v_typed.role,
      admin_role = case when p_role = 'admin' then v_typed.admin_role else null end,
      version = version + 1,
      updated_at = now()
  where user_id = p_target_user_id
    and version = p_expected_version
  returning * into v_after;

  if v_after.user_id is null then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    'update',
    v_after.user_id,
    public.velura_safe_user(v_before),
    public.velura_safe_user(v_after),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_after.email,
    'account_role_changed',
    'Vai tro tai khoan Velura da thay doi',
    format('Vai tro moi cua tai khoan: %s / %s.', p_role, coalesce(p_admin_role, '-')),
    v_after.user_id
  );

  return jsonb_build_object('kind', 'updated', 'account', public.velura_safe_user(v_after));
end;
$$;

create or replace function public.admin_review_role_request(
  p_request_id uuid,
  p_decision text,
  p_action_note text,
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
  v_request public.approval_admin_request%rowtype;
  v_target public.users%rowtype;
  v_after public.users%rowtype;
  v_typed public.users%rowtype;
begin
  select * into v_actor
  from public.users
  where user_id = public.velura_current_user_id();

  if v_actor.user_id is null
     or v_actor.role::text <> 'admin'
     or v_actor.admin_role::text <> 'super_admin'
     or not v_actor.is_active then
    raise sqlstate 'PT403' using message = 'RBAC_DENIED';
  end if;
  if p_decision not in ('approve', 'reject') then
    raise sqlstate 'PT422' using message = 'INVALID_APPROVAL_DECISION';
  end if;
  if p_decision = 'reject' and public.velura_reason_word_count(p_action_note) <= 10 then
    raise sqlstate 'PT422' using message = 'REJECTION_REASON_MIN_11_WORDS';
  end if;

  select * into v_request
  from public.approval_admin_request
  where request_id = p_request_id
  for update;

  if v_request.request_id is null then
    raise sqlstate 'PT404' using message = 'APPROVAL_NOT_FOUND';
  end if;
  if v_request.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'VERSION_CONFLICT';
  end if;
  if v_request.status::text <> 'pending' then
    raise sqlstate 'PT409' using message = 'APPROVAL_ALREADY_RESOLVED';
  end if;
  if v_actor.user_id in (v_request.requester_id, v_request.target_user_id) then
    raise sqlstate 'PT409' using message = 'APPROVAL_SEPARATION_REQUIRED';
  end if;

  select * into v_target
  from public.users
  where user_id = v_request.target_user_id
  for update;

  if v_target.user_id is null then
    raise sqlstate 'PT404' using message = 'ACCOUNT_NOT_FOUND';
  end if;

  if now() >= v_request.expires_at then
    update public.approval_admin_request
    set status = 'expired',
        approver_id = v_actor.user_id,
        action_note = 'Expired automatically after 10 days',
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id;

    perform public.velura_append_audit(
      v_actor.user_id,
      v_actor.admin_role::text,
      'update',
      v_target.user_id,
      jsonb_build_object('approval_request', to_jsonb(v_request)),
      jsonb_build_object('status', 'expired'),
      p_ip_address
    );
    return jsonb_build_object('kind', 'expired', 'request_id', v_request.request_id);
  end if;

  if p_decision = 'approve' then
    select * into v_typed
    from jsonb_populate_record(
      null::public.users,
      jsonb_build_object('role', 'admin', 'admin_role', v_request.requested_role)
    );

    update public.users
    set role = v_typed.role,
        admin_role = v_typed.admin_role,
        version = version + 1,
        updated_at = now()
    where user_id = v_target.user_id
      and version = v_target.version
    returning * into v_after;

    if v_after.user_id is null then
      raise sqlstate 'PT409' using message = 'TARGET_VERSION_CONFLICT';
    end if;
  else
    v_after := v_target;
  end if;

  if p_decision = 'approve' then
    update public.approval_admin_request
    set status = 'approved',
        approver_id = v_actor.user_id,
        action_note = nullif(btrim(p_action_note), ''),
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id;
  else
    update public.approval_admin_request
    set status = 'rejected',
        approver_id = v_actor.user_id,
        action_note = nullif(btrim(p_action_note), ''),
        resolved_at = now(),
        version = version + 1
    where request_id = v_request.request_id;
  end if;

  perform public.velura_append_audit(
    v_actor.user_id,
    v_actor.admin_role::text,
    p_decision,
    v_target.user_id,
    public.velura_safe_user(v_target),
    jsonb_build_object(
      'account', public.velura_safe_user(v_after),
      'approval_request_id', v_request.request_id,
      'decision', p_decision
    ),
    p_ip_address
  );
  perform public.velura_enqueue_account_email(
    v_target.email,
    case when p_decision = 'approve' then 'super_admin_approved' else 'super_admin_rejected' end,
    case when p_decision = 'approve' then 'Yeu cau nang quyen da duoc duyet' else 'Yeu cau nang quyen bi tu choi' end,
    format('Ket qua yeu cau nang quyen: %s.', p_decision),
    v_target.user_id
  );

  return jsonb_build_object(
    'kind', p_decision,
    'request_id', v_request.request_id,
    'account', public.velura_safe_user(v_after)
  );
end;
$$;

alter table public.users enable row level security;
alter table public.approval_admin_request enable row level security;
alter table public.audit_log enable row level security;
alter table public.email_outbox enable row level security;

-- Remove known unsafe prototype policies if they were applied manually.
drop policy if exists users_authenticated_select on public.users;
drop policy if exists users_service_all on public.users;
drop policy if exists approval_authenticated_select on public.approval_admin_request;
drop policy if exists approval_service_all on public.approval_admin_request;
drop policy if exists audit_authenticated_select on public.audit_log;
drop policy if exists audit_service_all on public.audit_log;

drop policy if exists velura_users_self_or_account_admin_select on public.users;
create policy velura_users_self_or_account_admin_select
on public.users for select
to authenticated
using (user_id = public.velura_current_user_id() or public.velura_is_super_admin());

drop policy if exists velura_users_self_or_account_admin_restriction on public.users;
create policy velura_users_self_or_account_admin_restriction
on public.users for select
to authenticated
using (user_id = public.velura_current_user_id() or public.velura_is_super_admin());

drop policy if exists velura_users_admin_mutation_via_rpc_only on public.users;
create policy velura_users_admin_mutation_via_rpc_only
on public.users for update
to authenticated
using (false)
with check (false);

drop policy if exists velura_admin_requests_super_admin_select on public.approval_admin_request;
create policy velura_admin_requests_super_admin_select
on public.approval_admin_request for select
to authenticated
using (public.velura_is_super_admin());

drop policy if exists velura_admin_requests_super_admin_restriction on public.approval_admin_request;
create policy velura_admin_requests_super_admin_restriction
on public.approval_admin_request for select
to authenticated
using (public.velura_is_super_admin());

drop policy if exists velura_audit_active_admin_select on public.audit_log;
create policy velura_audit_active_admin_select
on public.audit_log for select
to authenticated
using (public.velura_is_active_admin());

drop policy if exists velura_audit_active_admin_restriction on public.audit_log;
create policy velura_audit_active_admin_restriction
on public.audit_log for select
to authenticated
using (public.velura_is_active_admin());

drop policy if exists velura_email_outbox_super_admin_select on public.email_outbox;
create policy velura_email_outbox_super_admin_select
on public.email_outbox for select
to authenticated
using (public.velura_is_super_admin());

drop policy if exists velura_email_outbox_super_admin_restriction on public.email_outbox;
create policy velura_email_outbox_super_admin_restriction
on public.email_outbox for select
to authenticated
using (public.velura_is_super_admin());

revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;
revoke insert, update, delete, truncate on public.email_outbox from anon, authenticated;
grant select on public.users, public.approval_admin_request, public.audit_log, public.email_outbox to authenticated;

revoke all on function public.velura_handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.velura_current_user_id() from public, anon, authenticated;
revoke all on function public.velura_is_active_admin() from public, anon, authenticated;
revoke all on function public.velura_is_super_admin() from public, anon, authenticated;
revoke all on function public.velura_reason_word_count(text) from public, anon, authenticated;
revoke all on function public.velura_safe_user(public.users) from public, anon, authenticated;
revoke all on function public.velura_append_audit(uuid, text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.velura_enqueue_account_email(text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.velura_expire_admin_requests() from public, anon, authenticated;
revoke all on function public.velura_claim_email_outbox(integer) from public, anon, authenticated;
revoke all on function public.velura_complete_email_outbox(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_lock_user(uuid, text, text, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.admin_unlock_user(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_change_user_role(uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.admin_review_role_request(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.velura_current_user_id() to authenticated;
grant execute on function public.velura_is_active_admin() to authenticated;
grant execute on function public.velura_is_super_admin() to authenticated;
grant execute on function public.velura_reason_word_count(text) to authenticated;
grant execute on function public.admin_lock_user(uuid, text, text, integer, timestamptz, text) to authenticated;
grant execute on function public.admin_unlock_user(uuid, text, integer, text) to authenticated;
grant execute on function public.admin_change_user_role(uuid, text, text, integer, text) to authenticated;
grant execute on function public.admin_review_role_request(uuid, text, text, integer, text) to authenticated;
grant execute on function public.velura_expire_admin_requests() to service_role;
grant execute on function public.velura_claim_email_outbox(integer) to service_role;
grant execute on function public.velura_complete_email_outbox(uuid, boolean, text) to service_role;

commit;
