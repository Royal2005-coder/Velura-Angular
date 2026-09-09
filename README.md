# Velura Angular

Production workspace for the Velura fashion shop: Angular 21 customer SPA, Angular 21 admin SPA, and the Node API that already ran locally on `localhost:4002`, `localhost:4001`, and `localhost:8787`.

This folder is the clean extract of the Angular work. Vanilla Vite apps stay in the original monorepo.

## Local (same ports as the original localhost)

| App | Command | URL |
|---|---|---|
| API | `npm run start:api` | http://localhost:8787/health |
| Admin Angular | `npm run start:admin` | http://localhost:4001/login |
| Customer Angular | `npm run start:user` | http://localhost:4002/ |

Copy `.env.example` to `.env` and use the same Supabase values as the original project. Do not commit `.env`.

```bash
npm install
npm run test:api
npm run build
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Frontend is MVVM + Signals (Angular 21 standalone). Backend is router → service → repository.

## GitLab GitOps

See [docs/GITOPS.md](docs/GITOPS.md) and [docs/JIRA-GITLAB.md](docs/JIRA-GITLAB.md).

- Feature branch: validate + API tests + production Angular build
- Merge Request: same gates + required notes
- `main`: deploy to the Azure origin after tests pass

## Production URLs

| Surface | URL |
|---|---|
| Customer SPA | https://velura.royalai.dev/ |
| Admin SPA | https://admin.royalai.dev/login |
| API health | https://velura.royalai.dev/api/health |
| Origin IP | `135.235.219.13` |

Cloudflare and Supabase allowlists: [docs/CLOUDFLARE-SUPABASE.md](docs/CLOUDFLARE-SUPABASE.md).
