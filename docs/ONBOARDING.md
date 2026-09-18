# Onboarding — ngày 1 (gate trước khi code)

> **Cấm bắt đầu feature thật** cho đến khi hoàn thành mục [Gate](#gate--bắt-buộc) bên dưới.  
> Versioning + GitHub Actions chi tiết: **[GIT-AND-CI.md](./GIT-AND-CI.md)** (đọc hết).

Đọc [AGENTS.md](../AGENTS.md) trước. Context = type/JSDoc + `git log --show-notes` + PR `## Why`.

## Team

Cùng một repo GitHub. Lead ghi tên vào bảng khi chia slot.

| Team | Folder | Epic |
|---|---|---|
| Storefront (2) | `apps/user-ng` | [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) |
| Admin (2) | `apps/admin-ng` + `apps/api` | [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) |
| Lead (1) | CI, `docs/`, `packages/`, `database/` | cả hai khi đụng contract |

Review: Storefront PR do Storefront khác; Admin PR do Admin khác. Đụng DTO/API thì cả hai. **CI đỏ = không merge.**

## Account

1. Jira https://webadvance.atlassian.net — project **KAN** (không VEL).
2. GitHub Write trên https://github.com/Royal2005-coder/Velura-Angular — **không** push `main` / `develop`.
3. Node.js **22**, Git, `gh auth login`. MCP Jira: [MCP-SETUP.md](./MCP-SETUP.md).

Không share `.env` / `*.pem`. Không dùng GitLab cho CI/CD team.

## Clone + local

Làm đúng từng bước trong [GIT-AND-CI.md §2](./GIT-AND-CI.md#2-cài-máy-một-lần--người).

```bash
git clone https://github.com/Royal2005-coder/Velura-Angular.git
cd Velura-Angular
git checkout develop && git pull
git fetch origin refs/notes/commits:refs/notes/commits
npm install
copy .env.example .env
```

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

## Quy tắc versioning (tóm tắt)

Chi tiết đầy đủ: [GIT-AND-CI.md §3–§4](./GIT-AND-CI.md#3-versioning--quy-ước-cứng).

1. Việc = Task Jira dưới KAN-4 hoặc KAN-5.
2. Branch `feature/KAN-<n>-<ten>` **từ `develop`**.
3. Commit + **title PR** bắt đầu `KAN-<n>`; body có `## Why` (template `.github/pull_request_template.md`).
4. PR **chỉ vào `develop`**. CI: `validate` + `validate-pr-contract` + `test-api` + `test-angular` + `build` + `note-pr`.
5. Không merge CI đỏ. Không feature → `main`. Không `[skip ci]`.
6. Production chỉ sau PR `develop` → `main` (Lead). `develop` **không** deploy.

Luồng: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). UI: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md). Kiến trúc không phá: [COMPLIANCE.md](./COMPLIANCE.md).

## Practice (một lần / người) — bắt buộc

Mỗi người một Task Jira riêng (không dùng chung KAN-13/KAN-14). Draft PR vào `develop`, **không merge**.

```bash
git checkout develop && git pull
git checkout -b feature/KAN-n-onboarding-practice
git commit --allow-empty -m "KAN-n practice PR — empty commit, do not merge"
git push -u origin HEAD
gh pr create --base develop --title "KAN-n Practice for <tên>" --draft
```

1. Đợi Actions **xanh** + comment Trace (`note-pr`).  
2. **Close** PR (không Merge).  
3. Jira Close: `Practice complete; PR not merged.`

Placeholder KAN-1…KAN-3 trên board là mẫu — không dùng cho Velura.

## Gate — bắt buộc

Copy checklist [GIT-AND-CI.md §7](./GIT-AND-CI.md#7-checklist-gate--tick-hết-mới-được-code-feature-thật) vào comment Jira onboarding và tick hết.

Lead **không giao** ticket feature cho đến khi:

- Practice PR đã chạy CI xanh (và đã close), và  
- Thành viên giải thích được: nhánh nào deploy, vì sao cấm `[skip ci]`, mở đâu để xem job Actions đỏ.
