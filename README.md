# Velura Angular

Workspace production: hai SPA **Angular 21** (storefront + admin) và HTTP API **Node** (không phải Angular).

Người mới và agent: đọc **[AGENTS.md](AGENTS.md)** trước, rồi file này, rồi **[docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md)**.

## Source of truth

| Câu hỏi | Đọc |
|---|---|
| Angular là gì / component / service / HTTP | [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md) + [LECTURE-MAP](docs/source-of-truth/LECTURE-MAP.md) + [BOOK-MAP](docs/source-of-truth/BOOK-MAP.md) |
| Vì sao API vẫn `.js` | [ADR 0002](docs/adr/0002-node-api-javascript.md) |
| Vì sao không `NgModule` | [ADR 0001](docs/adr/0001-angular-21-standalone-signals.md) |
| Đã chuẩn chưa / còn gap | [docs/COMPLIANCE.md](docs/COMPLIANCE.md) |
| Cài MCP Cursor (Jira + GitLab) | [docs/MCP-SETUP.md](docs/MCP-SETUP.md) |
| Làm việc Jira → MR → CI → production | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| Ngày 1 / practice | [docs/ONBOARDING.md](docs/ONBOARDING.md), [docs/PRACTICE-DRILL.md](docs/PRACTICE-DRILL.md) |
| Mục lục docs | [docs/README.md](docs/README.md) |

Slide gốc và sách GoalKicker nằm ngoài Git (TinyBigCorp `docs/`). Repo chỉ giữ **bản map** để agent không dán sách có bản quyền.

## Team (5 người)

| Team | Folder | Epic |
|---|---|---|
| Storefront (2) | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) |
| Admin (2) | `apps/admin-ng`, `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) |
| Lead (1) | CI, `docs/`, `packages/` | cả hai khi đụng contract |

Jira: https://webadvance.atlassian.net (project **KAN**).  
GitLab: https://gitlab.com/boygia757-netizen/velura-project  
Không dùng GitLab Issues làm backlog.

## Pipeline bắt buộc

```
Jira KAN-n → feature/KAN-n → MR vào develop (CI + note:mr bắt buộc)
         → merge develop → staging
         → MR develop → main → production
```

MR đang chạy: https://gitlab.com/boygia757-netizen/velura-project/-/merge_requests/1 — **đổi target sang `develop`**. Không merge thẳng `main`.

## Local

| App | Command | URL |
|---|---|---|
| API | `npm run start:api` | http://localhost:8787/health |
| Admin | `npm run start:admin` | http://localhost:4001/login (`localhost`, không `127.0.0.1`) |
| Storefront | `npm run start:user` | http://localhost:4002/ |

```bash
git clone git@gitlab.com:boygia757-netizen/velura-project.git
cd velura-project
npm install
copy .env.example .env
npm run test:api
npm run build
```

Không commit `.env`.

## Production and staging

| Surface | URL |
|---|---|
| Storefront | https://velura.royalai.dev/ |
| Admin | https://admin.royalai.dev/login |
| API | https://velura.royalai.dev/api/health |
| Staging storefront | https://staging.velura.royalai.dev/ |
| Staging admin | https://staging-admin.royalai.dev/login |

Cloudflare/Supabase: [docs/CLOUDFLARE-SUPABASE.md](docs/CLOUDFLARE-SUPABASE.md). Deploy: [docs/GITOPS.md](docs/GITOPS.md).
