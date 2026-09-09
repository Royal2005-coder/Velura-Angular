alter table public.users
  add column if not exists social_accounts jsonb not null default '{}'::jsonb;

comment on column public.users.social_accounts is
  'Linked OAuth account display metadata keyed by provider, e.g. google/facebook with providerEmail, providerName, linkedAt.';

notify pgrst, 'reload schema';
