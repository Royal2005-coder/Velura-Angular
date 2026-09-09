# Velura API

Node 20 API gateway for Velura admin and future user backend flows.

## Run Locally

1. Copy `.env.example` to `.env`.
2. Fill `VELURA_SUPABASE_SERVICE_ROLE_KEY` for local admin API writes.
3. Run:

```bash
npm run api:dev
```

Healthcheck:

```text
GET http://localhost:8787/health
```

The API deliberately has no extra runtime dependencies yet. It uses Node 20 `fetch` and Supabase REST/Auth endpoints.
