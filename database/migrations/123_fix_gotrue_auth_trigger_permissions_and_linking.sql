-- KAN-66: harden the GoTrue -> public.users profile trigger. Already applied to the live project.
--
-- What this does (hardening, NOT the cause of the Google SSO server_error; see 124 for that):
--  1. Link an incoming auth user onto an existing public.users row by email (or phone) regardless of
--     whether that row is already linked, instead of falling through to an INSERT that can hit
--     users_email_key.
--  2. Copy name/avatar from the provider metadata (Google sends name, avatar_url/picture).
--  3. Never abort the auth.users transaction because the profile mirror failed: a warning is logged and
--     /api/user/auth/social-login creates or links the profile on the next step.
--  4. Explicit GRANTs for supabase_auth_admin. Postgres does not check EXECUTE when a trigger fires, so
--     these are defensive only.
--
-- Idempotent: create or replace + drop/create trigger.
begin;

create or replace function public.velura_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  existing_id uuid;
  verified boolean;
  user_full_name text;
  user_avatar text;
begin
  verified := (new.email_confirmed_at is not null or new.phone_confirmed_at is not null);

  user_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    new.phone,
    'Nguoi dung Velura'
  );

  user_avatar := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'picture'), '')
  );

  if new.email is not null and new.email <> '' then
    select u.user_id
      into existing_id
    from public.users u
    where lower(u.email) = lower(new.email)
    order by case when u.role::text = 'admin' then 0 else 1 end, u.created_at asc
    limit 1;
  elsif new.phone is not null and new.phone <> '' then
    select u.user_id
      into existing_id
    from public.users u
    where u.phone = new.phone
    order by case when u.role::text = 'admin' then 0 else 1 end, u.created_at asc
    limit 1;
  end if;

  if existing_id is not null then
    update public.users
    set auth_user_id = null
    where auth_user_id = new.id
      and user_id <> existing_id;

    update public.users
    set auth_user_id = new.id,
        is_verified = (verified or is_verified),
        avatar = coalesce(public.users.avatar, user_avatar),
        updated_at = now()
    where user_id = existing_id;

    return new;
  end if;

  insert into public.users (
    user_id, auth_user_id, email, phone, full_name, avatar,
    role, admin_role, is_active, is_verified, created_at, updated_at
  )
  values (
    new.id, new.id, new.email, new.phone, user_full_name, user_avatar,
    'member', null, true, verified, coalesce(new.created_at, now()), now()
  )
  on conflict (user_id) do update
  set auth_user_id = excluded.auth_user_id,
      email = coalesce(public.users.email, excluded.email),
      phone = coalesce(public.users.phone, excluded.phone),
      full_name = case when public.users.full_name is null or public.users.full_name = 'Nguoi dung Velura' then excluded.full_name else public.users.full_name end,
      avatar = coalesce(public.users.avatar, excluded.avatar),
      is_verified = (public.users.is_verified or excluded.is_verified),
      updated_at = now();

  return new;
exception
  when others then
    raise warning 'velura_handle_new_auth_user error: % (SQLSTATE %)', sqlerrm, sqlstate;
    return new;
end;
$$;

create or replace function public.velura_sync_auth_user_verified()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if new.email_confirmed_at is not distinct from old.email_confirmed_at
     and new.phone_confirmed_at is not distinct from old.phone_confirmed_at then
    return new;
  end if;

  update public.users
  set is_verified = ((new.email_confirmed_at is not null or new.phone_confirmed_at is not null) or is_verified),
      updated_at = now()
  where auth_user_id = new.id
     or user_id = new.id;

  return new;
exception
  when others then
    raise warning 'velura_sync_auth_user_verified error: % (SQLSTATE %)', sqlerrm, sqlstate;
    return new;
end;
$$;

drop trigger if exists trg_velura_auth_user_created on auth.users;
create trigger trg_velura_auth_user_created
after insert on auth.users
for each row execute function public.velura_handle_new_auth_user();

drop trigger if exists trg_velura_auth_user_verified on auth.users;
create trigger trg_velura_auth_user_verified
after update of email_confirmed_at, phone_confirmed_at on auth.users
for each row execute function public.velura_sync_auth_user_verified();

revoke all on function public.velura_handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.velura_sync_auth_user_verified() from public, anon, authenticated;

grant execute on function public.velura_handle_new_auth_user() to supabase_auth_admin, service_role, postgres;
grant execute on function public.velura_sync_auth_user_verified() to supabase_auth_admin, service_role, postgres;
grant usage on schema public to supabase_auth_admin;

commit;
