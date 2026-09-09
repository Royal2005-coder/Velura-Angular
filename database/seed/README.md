# Database seed

Only `seed-admin-users.mjs` is active for UC-A01. It creates Supabase Auth users first and then upserts the canonical `public.users` rows by Auth UUID.

Required safeguards:

- Target must be development or staging.
- `VELURA_ALLOW_SEED=1` must be set explicitly.
- `VELURA_SUPABASE_SERVICE_ROLE_KEY` must come from a secret store.
- `VELURA_SEED_PASSWORD` must contain at least 16 characters.
- Never run account seed scripts against production.

Historical one-off SQL fixes are stored under `database/legacy/unsafe-hotfixes`. They are intentionally outside the active seed path because some widen RLS, promote hard-coded emails, or delete account rows.
