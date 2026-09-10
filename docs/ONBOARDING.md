# Onboarding — ngày 1

Đọc [AGENTS.md](../AGENTS.md) trước. Context = type/JSDoc + `git log --show-notes` + MR `## Why`.

## Team

Cùng một repo. Lead ghi tên vào bảng khi chia slot.

| Team | Folder | Epic |
|---|---|---|
| Storefront (2) | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) |
| Admin (2) | `apps/admin-ng` + `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) |
| Lead (1) | CI, `docs/`, `packages/`, `database/` | cả hai khi đụng contract |

Review: Storefront MR do Storefront khác; Admin MR do Admin khác. Đụng DTO/API thì cả hai. CI đỏ = không merge.

## Account

1. Jira https://webadvance.atlassian.net — project **KAN** (không VEL).
2. GitLab Developer+. Không push `main` / `develop`.
3. Node.js 22. MCP: [MCP-SETUP.md](./MCP-SETUP.md). API = TypeScript trên Node (`npm run start:api`, `npm run test:api`). Angular = hai SPA.

Không share `.env` / `*.pem`.

## Clone

```bash
git clone git@gitlab.com:boygia757-netizen/velura-project.git
cd velura-project
git checkout develop
git pull
git fetch origin refs/notes/commits:refs/notes/commits
npm install
copy .env.example .env
```

`.env` từ lead — **không commit**.

| App | Command | URL |
|---|---|---|
| API | `npm run start:api` | http://localhost:8787/health |
| Admin | `npm run start:admin` | http://localhost:4001/login (`localhost`, không `127.0.0.1`) |
| Storefront | `npm run start:user` | http://localhost:4002/ |

```bash
npm run test:api
npm run test:ng
npm run build
```

## Quy tắc

1. Việc = Task Jira dưới KAN-4 hoặc KAN-5.
2. Branch `feature/KAN-<n>-<ten>` từ `develop`.
3. Commit + **title MR** bắt đầu `KAN-<n>`.
4. MR **vào develop**. CI: validate + `test:api` + `test:angular` + build + `note:mr`.
5. Không merge CI đỏ. Không feature → `main`. Không `[skip ci]`.
6. Production chỉ sau MR `develop` → `main`. `develop` không deploy.

Luồng: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). UI: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md).

## Practice (một lần / người)

Mỗi người một Task Jira (không dùng chung KAN-13/KAN-14). Draft MR vào `develop`, **không merge**.

```bash
git checkout develop && git pull
git checkout -b feature/KAN-n-onboarding-practice
git commit --allow-empty -m "KAN-n practice MR — empty commit, do not merge"
git push -u origin HEAD
```

Title: `KAN-n Practice for <tên>`. Mark as draft. Đợi CI xanh + Notes có git log. Close MR (không Merge). Jira Close: `Practice complete; MR not merged.`

Placeholder KAN-1…KAN-3 trên board là mẫu — không dùng cho Velura.
