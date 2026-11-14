-- KAN-66: Google SSO failed with server_error after Google token exchange succeeded.
-- Root cause: auth.users rows created by scripts/restore-supabase-data.mjs had NULL in the token
-- columns below. GoTrue scans them into non-nullable Go strings, so any lookup of such a user
-- (OAuth email linking, password login, recovery) fails with "converting NULL to string".
-- Idempotent: touches only rows that still hold NULL.
begin;

update auth.users set
  confirmation_token = coalesce(confirmation_token, ''),
  recovery_token = coalesce(recovery_token, ''),
  email_change = coalesce(email_change, ''),
  email_change_token_new = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change = coalesce(phone_change, ''),
  phone_change_token = coalesce(phone_change_token, ''),
  reauthentication_token = coalesce(reauthentication_token, '')
where confirmation_token is null or recovery_token is null or email_change is null
   or email_change_token_new is null or email_change_token_current is null
   or phone_change is null or phone_change_token is null or reauthentication_token is null;

commit;
