-- Link GoTrue users onto the existing public.users admin row (same email)
-- and keep is_verified in sync after the mailbox is confirmed.

create or replace function public.velura_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  existing_id uuid;
  verified boolean;
begin
  verified := new.email_confirmed_at is not null or new.phone_confirmed_at is not null;

  if new.email is not null then
    select u.user_id
      into existing_id
    from public.users u
    where u.auth_user_id is distinct from new.id
      and lower(u.email) = lower(new.email)
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
        is_verified = verified or is_verified,
        updated_at = now()
    where user_id = existing_id;

    return new;
  end if;

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
    verified,
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (user_id) do update
  set auth_user_id = excluded.auth_user_id,
      email = coalesce(public.users.email, excluded.email),
      phone = coalesce(public.users.phone, excluded.phone),
      is_verified = public.users.is_verified or excluded.is_verified,
      updated_at = now();
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
  set is_verified = (new.email_confirmed_at is not null or new.phone_confirmed_at is not null) or is_verified,
      updated_at = now()
  where auth_user_id = new.id
     or user_id = new.id;

  return new;
end;
$$;

drop trigger if exists trg_velura_auth_user_verified on auth.users;
create trigger trg_velura_auth_user_verified
after update of email_confirmed_at, phone_confirmed_at on auth.users
for each row execute function public.velura_sync_auth_user_verified();

revoke all on function public.velura_sync_auth_user_verified() from public, anon, authenticated;

update public.users u
set is_verified = true,
    updated_at = now()
from auth.users au
where u.is_verified = false
  and (u.auth_user_id = au.id or u.user_id = au.id)
  and (au.email_confirmed_at is not null or au.phone_confirmed_at is not null);
