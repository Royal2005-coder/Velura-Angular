-- KAN-28: Guest checkout account activation without temporary passwords.
alter table public.users
  add column if not exists activation_token_hash varchar(64),
  add column if not exists activation_expires_at timestamptz;

create unique index if not exists users_activation_token_hash_uq
  on public.users (activation_token_hash)
  where activation_token_hash is not null;
