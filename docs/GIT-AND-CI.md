# Git versioning + GitHub Actions (bắt buộc trước khi code)

**Đọc hết file này + làm checklist ở cuối trước khi mở branch feature.**  
Phá nhánh / skip CI / push thẳng `main` = phá kiến trúc vận hành đã dựng.

Repo canonical: https://github.com/Royal2005-coder/Velura-Angular  
Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)  
Luồng Jira: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) · Ngày 1: [ONBOARDING.md](./ONBOARDING.md)

---

## 1. Vì sao phải làm đúng

| Lớp | Ý nghĩa |
|---|---|
| Jira `KAN-n` | Việc / trạng thái board |
| Branch + commit | Version trong git |
| Pull Request + `## Why` | Lý do thay đổi (ADR của ticket) |
| GitHub Actions | Cổng bắt buộc — không xanh thì không merge |
| `main` | Production (`velura.royalai.dev`) |

Context **không** nằm trong `docs/KAN-n.md`. Context = type/JSDoc + `git log` + PR + git notes ([AGENTS.md](../AGENTS.md)).

GitLab (`.gitlab-ci.yml`) = **legacy**. Team **không** push / không mở MR GitLab.

---

## 2. Cài máy (một lần / người)

### 2.1 Tooling

1. **Git** ≥ 2.40  
2. **Node.js 22** (đúng engines trong `package.json`)  
3. **GitHub account** được invite **Write** vào repo  
4. **`gh` CLI** (khuyến nghị): https://cli.github.com/  
5. Jira account project **KAN** — [MCP-SETUP.md](./MCP-SETUP.md)

```bash
git --version
node -v          # v22.x
gh auth login    # HTTPS, scope repo
gh auth status
```

### 2.2 Git identity (trùng GitHub / school email)

```bash
git config --global user.name "Họ Tên"
git config --global user.email "ban@st.uel.edu.vn"
```

### 2.3 Clone đúng nhánh

```bash
git clone https://github.com/Royal2005-coder/Velura-Angular.git
cd Velura-Angular
git remote -v
# origin → github.com/Royal2005-coder/Velura-Angular.git

git checkout develop
git pull origin develop
git fetch origin refs/notes/commits:refs/notes/commits
npm install
copy .env.example .env
# Lead gửi giá trị .env — KHÔNG commit .env / *.pem
```

Xác nhận:

```bash
git branch --show-current   # phải là develop
git status -sb              # sạch (hoặc chỉ .env untracked nếu chưa gitignore — .env đã ignore)
npm run test:api
npm run test:ng
npm run build
```

Local OK ≠ được merge. Merge chỉ khi **PR CI xanh**.

---

## 3. Versioning — quy ước cứng

### 3.1 Nhánh

| Nhánh | Ai push | Việc |
|---|---|---|
| `feature/KAN-<n>-<slug>` | Dev | Code ticket |
| `hotfix/KAN-<n>-<slug>` | Dev / Lead | Fix prod khẩn → vẫn PR `develop` rồi promote |
| `develop` | Chỉ merge PR | Integration; chạy CI, không triển khai môi trường riêng |
| `main` | Chỉ merge PR promote | MVP production; publish signed images và reconcile reviewed production pins |

Cấm:

- Push trực tiếp `develop` / `main` (branch protection)
- Feature PR target `main`
- Branch không có `KAN-n` trong tên khi làm ticket
- `[skip ci]` / `[ci skip]` trong commit hoặc title

### 3.2 Commit

```text
KAN-42 rút gọn why một dòng
```

```bash
git add -p
git commit -m "KAN-42 hide admin price editor when role cannot mutate"
```

Mỗi commit phải gắn được với Jira. Không commit “fix”, “update”, “wip” không có `KAN-n`.

### 3.3 Pull Request (log phiên bản)

1. Target **`develop`** (feature/hotfix).  
2. Title: `KAN-n …` (hoặc `Draft: KAN-n …`).  
3. Body: dùng template [`.github/pull_request_template.md`](../.github/pull_request_template.md) — **bắt buộc** có heading `## Why`.  
4. Đợi checks: `validate`, `validate-pr-contract`, `test-api`, `test-angular`, `build`, `note-pr`.  
5. MVP không yêu cầu approval; tag/CODEOWNERS để thông báo, đọc diff trước merge. CI đỏ/pending = **không merge**.
6. Sau merge: comment URL PR trên Jira → chuyển trạng thái.

Promote production:

```text
PR source = develop → target = main
Title gợi ý: KAN-n: promote develop → main (…)
```

Chỉ Lead / người được chỉ định mở promote PR. MVP dùng một môi trường production:
source trên `main` qua toàn bộ CI rồi build/scan/SBOM/sign; GitHub App mở PR
production pins vào `develop`. Sau review và CI xanh, promote `develop` → `main`
để Flux triển khai đúng digest đã ký, không rebuild. Không cần staging project,
staging verification hay staging credentials. Flux root quản lý cấu hình owner
và bật production từ PR pins có bằng chứng publisher hợp lệ; không resume tay
cho từng release. Bot mang ancestry của main vào PR pins để giữ nhánh promote
up-to-date với branch protection.

### 3.4 Đọc lại version (trước khi sửa code cũ)

```bash
git fetch origin
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-42
git show --stat <sha>
git diff origin/develop...HEAD --stat
```

### 3.5 Git notes (cảnh báo bên lề)

Không nhét “đừng cache / cố ý không optimize” vào ADR.md ticket. Dùng notes:

```bash
# xem deploy/scripts/git-notes.sh nếu có
git log --show-notes --oneline -n 20
```

---

## 4. Hiểu GitHub Actions (trước khi code)

File: `.github/workflows/ci.yml`. Mọi push/PR vào `develop` hoặc `main` đều chạy.

### 4.1 Sơ đồ

```
PR feature → develop
  validate
  validate-pr-contract   (title KAN-n + ## Why; cấm feature→main)
  test-api               (typecheck + tests Node)
  test-angular           (user-ng + admin-ng)
  build                  (api + user + admin artifacts)
  note-pr                (comment Trace + artifact pr-trace.md)
       ↓ merge (CI xanh; tag thành viên liên quan)
Push develop             (validate/tests/build; không publish image)
  production-pins merge  → CI kiểm chứng publisher main + chữ ký cùng digest
       ↓
PR develop → main        (cùng cổng PR; kiểm tra signed-main production evidence)
       ↓ merge
Push main
  app source changed     → deploy-production (scan/SBOM/sign) → PR production pins
  production pins changed → Flux root/production → verify-production (owner opt-in)
  workflow_dispatch      → recovery=release-main, chỉ SHA main hiện tại, đủ gates
```

### 4.2 Job nào fail nghĩa là gì

| Job | Ý nghĩa | Việc của bạn |
|---|---|---|
| `validate` | Thiếu file workspace / có `[skip ci]` / có private key trong repo / `@ts-nocheck` API | Sửa commit; đừng skip CI |
| `validate-pr-contract` | Sai title/body/nhánh | Sửa title PR hoặc `## Why` trên GitHub |
| `test-api` / `test-angular` | Test hoặc typecheck đỏ | Chạy cùng lệnh local rồi push lại |
| `build` | Build không ra `dist` | `npm run build` local |
| `note-pr` | Không ghi được trace | Thường do job trước; xem log |
| `deploy-production` / `promote-images` | Registry build/scan/sign hoặc PR promotion thất bại | Lead; không tự sửa cluster image |
| `verify-production` | Chữ ký, app revision hoặc DB/gateway chưa ready | Ops; endpoint này không chứng minh Flux |

### 4.3 Secrets production (chỉ Lead)

**Không** dùng trang Deploy keys.  
Đúng: **Settings → Secrets and variables → Actions → Environment `production`**.

| Secret | Vai trò |
|---|---|
| `PRODUCTION_VERIFY_TOKEN` | Bearer riêng từng Environment, khớp namespace-local API Secret |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Chỉ bắt buộc khi `VELURA_CF_ACCESS_ENABLED=true`, phải là service token thật |
| `GITHUB_TOKEN` | Publish/sign và đọc evidence; không dùng làm tác giả PR vì không kích hoạt PR workflows |
| `RELEASE_APP_ID` (variable) / `RELEASE_APP_PRIVATE_KEY` (secret) | GitHub App cài trên repo này, Contents + Pull requests write; token ngắn hạn tạo PR rồi được revoke |

Dev thường **không** cần và **không** được yêu cầu secrets này để code.

MVP không dùng Environment/database staging. Production cần `SUPABASE_DB_URL`,
`SUPABASE_DB_CA_CERT` và verification token độc lập. `VELURA_VERIFY_PRODUCTION=true`
bật kiểm chứng read-only. Cloudflare Access là lớp tùy chọn: khi chưa bật, ops
endpoint vẫn yêu cầu Bearer token và admin vẫn chịu authentication/RBAC của app;
không dùng placeholder để giả chứng minh Access. Digest bundle, main publisher
run và attempt được ghi ở `deploy/releases/production.json` (`mode=direct-mvp`).
CI xác minh cả job gates và chữ ký Cosign gắn đúng revision/build ID; không thay
bằng `Ready` của pod hoặc SHA khai báo trong ConfigMap.
Bootstrap: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#k3s-production-mvp-runbook).

### 4.4 Xem pipeline

- Tab **Actions** trên repo  
- Hoặc: `gh run list` / `gh pr checks`

Public repo + Student Pack: runner chuẩn **không trừ** phút Actions. Không lấy cớ “hết phút” để skip CI.

---

## 5. Kiến trúc code không được phá

Trước khi thêm file / đổi tầng, đọc:

| Vùng | Rule |
|---|---|
| `apps/user-ng`, `apps/admin-ng` | Angular 21 standalone + Signals; HTTP chỉ trong service |
| `apps/api` | Router → Service → Repository; không `any` / `@ts-nocheck` |
| UI page | Không filter/logic nặng trong template; specs mock Model |
| DB | Flyway / SQL trong `database/` — không sửa schema “tay” ngoài migration |

Chi tiết: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md), [COMPLIANCE.md](./COMPLIANCE.md), [SOURCE-OF-TRUTH.md](./SOURCE-OF-TRUTH.md).

---

## 6. Một ngày làm việc (cheatsheet)

```bash
# 1. Đồng bộ
git checkout develop && git pull origin develop

# 2. Branch từ Jira KAN-n
git checkout -b feature/KAN-n-short-slug

# 3. Code + test local (cùng lệnh CI)
npm run test:api
npm run test:ng
# hoặc ít nhất test vùng bạn đụng

# 4. Commit + push
git commit -m "KAN-n why..."
git push -u origin HEAD

# 5. Mở PR → develop (gh hoặc UI)
gh pr create --base develop --title "KAN-n ..." --body-file .github/pull_request_template.md

# 6. Đợi Actions xanh + review → merge
# 7. Comment Jira bằng URL PR
```

Production: **không** tự merge `main`. Lead mở PR `develop` → `main` sau khi `develop` ổn định / đã UAT local.

---

## 7. Checklist gate — tick hết mới được code feature thật

In hoặc copy vào comment Jira onboarding:

- [ ] Đã đọc [AGENTS.md](../AGENTS.md) + file này + [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) + [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ ] `gh auth status` / GitHub Web login OK; remote `origin` = Velura-Angular
- [ ] Làm việc trên `develop`; biết `main` = production
- [ ] Hiểu: feature → PR develop → (promote) PR develop→main → deploy
- [ ] Biết mở Actions tab và đọc job đỏ
- [ ] Biết PR cần `KAN-n` + `## Why`; cấm `[skip ci]`
- [ ] Biết folder + layer của role mình (Storefront / Admin / API / DB) trong ARCHITECTURE
- [ ] `npm install` + `test:api` + `test:ng` + `build` local chạy được
- [ ] Có `.env` từ lead; không commit secret
- [ ] Đã làm **Practice PR** trong [ONBOARDING.md](./ONBOARDING.md) (draft, không merge)
- [ ] Biết folder mình được phép sửa (Storefront / Admin / Lead)

**Lead xác nhận checklist trước khi giao ticket đầu tiên.**

---

## 8. Việc Lead phải giữ (team 6)

1. Invite GitHub Write; cập nhật [`.github/CODEOWNERS`](../.github/CODEOWNERS) đủ username.  
2. Giữ branch protection `develop` + `main`.  
3. Secrets chỉ trên Environment `production`.  
4. Không bảo team đẩy lên GitLab.  
5. Promote `develop`→`main` có chủ đích; theo dõi Actions deploy/verify.

### Đồng bộ branch protection (Lead, một lần khi đổi policy)

Policy được version trong `.github/branch-protection.json`, áp dụng cho cả hai
nhánh. Required checks chỉ nhận từ GitHub Actions; branch phải up-to-date,
approval count bằng 0, giải quyết conversation và không có bypass cho admin.
CODEOWNERS/mention chỉ dùng để thông báo theo phạm vi trong TEAM-WORKFLOW.

```bash
for branch in develop main; do
  gh api --method PUT "repos/Royal2005-coder/Velura-Angular/branches/$branch/protection" \
    --input .github/branch-protection.json
done
```

Auto-merge chỉ hoàn tất khi toàn bộ required checks đạt yêu cầu. Merge source
không đồng nghĩa đã rollout: release còn phải có image scan/sign, main publisher evidence,
production pins và Flux/HTTP verification. Khi các bootstrap gates đã được gỡ,
team không SSH, đổi image trực tiếp hay resume Flux cho từng release.
