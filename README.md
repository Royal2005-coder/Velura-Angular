# Velura Angular

Hai SPA **Angular 21** (storefront + admin) và HTTP API **Node**. Không viết API bằng Angular.

**Bàn giao team:** đọc [AGENTS.md](AGENTS.md) → file này → [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md).

## Đã lên `main` chưa?

**Chưa hết.** Production `main` đang chạy app + onboarding v1. Bộ source-of-truth + staging SDLC + test Angular trên CI **chỉ có trên nhánh feature**.

| Ref | SHA / ý | Team làm việc trên cái này |
|---|---|---|
| `origin/main` | `ab82af7` — merge KAN-13 đợt 1 (onboarding) | Production live. **Thiếu** maps, staging, `test:angular`, `note:mr` bắt buộc |
| `origin/develop` | **= `main`** lúc này | Chưa nhận SDLC mới |
| `feature/KAN-13-team-onboarding` | `ce31e9a` + `be5cb2e` + bàn giao này | **Checkout nhánh này hôm nay** |

Luồng đúng sau khi lead merge:

```
feature/KAN-n  →  MR vào develop  →  staging
develop        →  MR vào main     →  production
```

Không merge feature thẳng `main`. MR còn lại: đổi target sang **`develop`**.

```bash
git clone git@gitlab.com:boygia757-netizen/velura-project.git
cd velura-project
git fetch origin
git checkout feature/KAN-13-team-onboarding   # hôm nay: bộ docs + CI đầy đủ
# Sau khi MR vào develop đã merge:
# git checkout develop && git pull
```

## Source of truth (md ổn định — không nhân bản theo ticket)

| Câu hỏi | Đọc |
|---|---|
| Angular / component / HTTP | [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md) · [LECTURE-MAP](docs/source-of-truth/LECTURE-MAP.md) · [BOOK-MAP](docs/source-of-truth/BOOK-MAP.md) |
| API vẫn `.js` | [ADR 0002](docs/adr/0002-node-api-javascript.md) |
| Không `NgModule` | [ADR 0001](docs/adr/0001-angular-21-standalone-signals.md) |
| Gap | [docs/COMPLIANCE.md](docs/COMPLIANCE.md) |
| MCP Cursor | [docs/MCP-SETUP.md](docs/MCP-SETUP.md) |
| Jira → MR → staging → prod | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| Ngày 1 / practice | [docs/ONBOARDING.md](docs/ONBOARDING.md) · [docs/PRACTICE-DRILL.md](docs/PRACTICE-DRILL.md) |
| Mục lục | [docs/README.md](docs/README.md) |

Slide + sách GoalKicker nằm ngoài Git (TinyBigCorp `docs/`). Repo chỉ giữ **map**. Context từng version = **GitLab MR** (git log + CI note + tab Changes), không phải `docs/KAN-n.md`.

## Team (5 người)

| Team | Folder | Epic |
|---|---|---|
| Storefront (2) | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) |
| Admin (2) | `apps/admin-ng`, `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) |
| Lead (1) | CI, `docs/`, `packages/` | cả hai khi đụng contract |

Jira: https://webadvance.atlassian.net (project **KAN**).  
GitLab: https://gitlab.com/boygia757-netizen/velura-project  
Không dùng GitLab Issues làm backlog.

## Vận hành (bắt buộc)

```
Jira KAN-n
  → git checkout develop && git pull
  → feature/KAN-n-short
  → MR vào develop (title bắt đầu KAN-n)
  → CI: validate + test:api + test:angular + build + note:mr (bắt buộc)
  → reviewer (CODEOWNERS) merge develop
  → deploy staging → lead verify browser
  → MR develop → main → production
  → comment Jira bằng URL MR
```

Trace (CLI + giao diện GitLab):

```bash
git log --oneline --grep=KAN-13
git show --stat <sha>
git diff develop...HEAD --stat
```

Cùng nội dung: MR → Notes (job `note:mr`) và tab Changes.

Cấm: feature → `main`. Cấm `[skip ci]`. Cấm ADR.md cho ticket thường.

## Local

| App | Command | URL |
|---|---|---|
| API | `npm run start:api` | http://localhost:8787/health |
| Admin | `npm run start:admin` | http://localhost:4001/login (`localhost`, không `127.0.0.1`) |
| Storefront | `npm run start:user` | http://localhost:4002/ |

```bash
npm install
copy .env.example .env
npm run test:api
npm run test:ng
npm run build
```

Không commit `.env`.

## Staging và production

| Surface | URL |
|---|---|
| Storefront prod | https://velura.royalai.dev/ |
| Admin prod | https://admin.royalai.dev/login |
| API prod | https://velura.royalai.dev/api/health |
| Staging storefront | https://staging.velura.royalai.dev/ |
| Staging admin | https://staging-admin.royalai.dev/login |

Cùng một Azure VM. Staging API `:8788`. DNS Cloudflare + sudoers: [docs/GITOPS.md](docs/GITOPS.md). Lead bật GitLab: protected `develop`/`main`, CODEOWNERS, pipelines must succeed, push rule cấm `[skip ci]`, `SSH_PRIVATE_KEY` cho **cả** `develop`.
