# Velura Angular

Hai SPA **Angular 21** (storefront + admin) và HTTP API **Node**. Không viết API bằng Angular.

Đọc [AGENTS.md](AGENTS.md) → **[TEAM-WORKFLOW](docs/TEAM-WORKFLOW.md)** →
[Git/CI](docs/GIT-AND-CI.md) → [kiến trúc](docs/ARCHITECTURE.md) →
[onboarding](docs/ONBOARDING.md). Mục lục: [docs/README.md](docs/README.md).

**Repo + CI/CD (canonical):** https://github.com/Royal2005-coder/Velura-Angular  
GitLab chỉ còn archive / legacy — team làm việc trên GitHub Actions.

## Clone

```bash
git clone https://github.com/Royal2005-coder/Velura-Angular.git
cd Velura-Angular
git checkout develop
git pull
npm install
copy .env.example .env
```

Tạo feature branch từ develop; không code/push trực tiếp vào develop/main.
MVP chỉ có production: main publish signed images, PR pins và Flux tự rollout.
Approval không bắt buộc; PR + toàn bộ required CI xanh vẫn bắt buộc.
Chi tiết: [runbook](docs/HOW-IT-WORKS.md).

## Source of truth

| Câu hỏi | Đọc |
|---|---|
| Angular / HTTP | [SOURCE-OF-TRUTH](docs/SOURCE-OF-TRUTH.md) · [LECTURE-MAP](docs/source-of-truth/LECTURE-MAP.md) · [BOOK-MAP](docs/source-of-truth/BOOK-MAP.md) |
| API `.ts` trên Node | [ADR 0002](docs/adr/0002-node-api-javascript.md) · [ADR 0003](docs/adr/0003-node-api-typescript.md) |
| Không NgModule | [ADR 0001](docs/adr/0001-angular-21-standalone-signals.md) |
| Gap | [COMPLIANCE](docs/COMPLIANCE.md) |
| MCP | [MCP-SETUP](docs/MCP-SETUP.md) |
| Ngày 1 | [ONBOARDING](docs/ONBOARDING.md) · [GIT-AND-CI](docs/GIT-AND-CI.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) |

Context từng version = type/JSDoc + GitHub PR `## Why` + git notes, không phải `docs/KAN-n.md`.

## Team

| Team | Folder | Epic |
|---|---|---|
| Royal / Quỳnh — fullstack/backend | API, DB, Angular Models, tích hợp và release | KAN-4 / KAN-5 |
| Uyên / Khải — frontend redesign | `apps/user-ng`, `apps/admin-ng`; giữ contract nghiệp vụ | KAN-4 / KAN-5 |
| Royal / Quỳnh — platform | CI, Flux/SOPS, docs và runtime verification | các ticket hạ tầng |

Jira: https://webadvance.atlassian.net (**KAN**). GitHub: https://github.com/Royal2005-coder/Velura-Angular

## Pipeline

```
feature/KAN-n → PR develop → CI xanh (không deploy môi trường riêng)
             → PR develop → main → build/scan/SBOM/sign
             → production-pins PR → develop → main
             → Flux root / infra / production → verify revision/health
```

```bash
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
```

Cấm: feature → `main`, `[skip ci]`, ADR.md cho ticket thường.
`VELURA_AUTO_PROMOTE_MAIN=true` bật PR sync/promotion tự động có CI gates.
UI redesign, fullstack integration và rollback: [TEAM-WORKFLOW](docs/TEAM-WORKFLOW.md).
Atlas discovery/auth: [ATLAS.md](ATLAS.md); không nhầm với Atlassian Jira MCP.

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
