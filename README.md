# Velura Angular

Hai SPA **Angular 21** (storefront + admin) và HTTP API **Node**. Không viết API bằng Angular.

Đọc [AGENTS.md](AGENTS.md) → file này → [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md). Mục lục: [docs/README.md](docs/README.md).

## Clone

```bash
git clone git@gitlab.com:boygia757-netizen/velura-project.git
cd velura-project
git checkout develop
git pull
npm install
copy .env.example .env
```

Làm việc trên `develop`. Production = `main` sau MR promote. Chi tiết [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Source of truth

| Câu hỏi | Đọc |
|---|---|
| Angular / HTTP | [SOURCE-OF-TRUTH](docs/SOURCE-OF-TRUTH.md) · [LECTURE-MAP](docs/source-of-truth/LECTURE-MAP.md) · [BOOK-MAP](docs/source-of-truth/BOOK-MAP.md) |
| API `.ts` trên Node | [ADR 0002](docs/adr/0002-node-api-javascript.md) · [ADR 0003](docs/adr/0003-node-api-typescript.md) |
| Không NgModule | [ADR 0001](docs/adr/0001-angular-21-standalone-signals.md) |
| Gap | [COMPLIANCE](docs/COMPLIANCE.md) |
| MCP | [MCP-SETUP](docs/MCP-SETUP.md) |
| Ngày 1 | [ONBOARDING](docs/ONBOARDING.md) |

Context từng version = type/JSDoc + GitLab MR `## Why` + git notes, không phải `docs/KAN-n.md`.

## Team

| Team | Folder | Epic |
|---|---|---|
| Storefront (2) | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) |
| Admin (2) | `apps/admin-ng`, `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) |
| Lead (1) | CI, `docs/`, `packages/` | cả hai khi đụng contract |

Jira: https://webadvance.atlassian.net (**KAN**). GitLab: https://gitlab.com/boygia757-netizen/velura-project

## Pipeline

```
feature/KAN-n → MR develop → CI (tests + note:mr, không deploy)
             → MR develop → main → production
```

```bash
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
```

Cấm: feature → `main`, `[skip ci]`, ADR.md cho ticket thường.

## Local

| App | Command | URL |
|---|---|---|
| API | `npm run start:api` | http://localhost:8787/health |
| Admin | `npm run start:admin` | http://localhost:4001/login (`localhost`) |
| Storefront | `npm run start:user` | http://localhost:4002/ |

```bash
npm run test:api
npm run test:ng
npm run build
```

Không commit `.env`.

## URLs

| Surface | URL |
|---|---|
| Storefront | https://velura.royalai.dev/ |
| Admin | https://admin.royalai.dev/login |
| API | https://velura.royalai.dev/api/health |

DNS/CORS: [docs/CLOUDFLARE-SUPABASE.md](docs/CLOUDFLARE-SUPABASE.md).
