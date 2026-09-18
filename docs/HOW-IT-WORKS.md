# Jira ↔ GitHub Actions — luồng vận hành

Jira = việc. GitHub **Pull Request** = **log phiên bản** (Files changed, git log, CI `note-pr`).  
`docs/` chỉ map ổn định. **Không** tạo markdown theo ticket.

**Canonical CI/CD:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) trên  
https://github.com/Royal2005-coder/Velura-Angular  

GitLab (`.gitlab-ci.yml`) là **legacy** — không dùng cho team; hết phút shared runner.

```
Jira KAN-n
  → git checkout develop && git pull
  → feature/KAN-n-short
  → commit "KAN-n why"
  → PR vào develop (title bắt đầu KAN-n)
  → CI: validate + test-api + test-angular + build + note-pr
  → CODEOWNERS reviewer merge develop
  → Push develop: cùng cổng test/build — không deploy
  → PR develop → main (source/target đủ; title promote nên `KAN-n: …`)
  → deploy-production + verify-production
  → Jira Close + comment URL PR
```

Cấm: feature → `main`. Cấm `[skip ci]`. Cấm ADR.md cho bug thường. Cấm GitHub/GitLab Issues làm backlog (chỉ Jira **KAN**).

## Trace

```bash
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
git diff develop...HEAD --stat
```

GitHub: PR (`## Why`) + Files changed + job `note-pr` (comment + artifact `pr-trace.md`).

## Jobs (GitHub Actions)

`validate-pr-contract` **chỉ** chạy trên Pull Request. Feature → `develop`: title `KAN-n` + `## Why`. Promote `develop` → `main`: chỉ cần đúng hai nhánh (why đã nằm trong git log feature). Feature → `main` cấm. Sửa title/body trên GitHub; không tạo `docs/KAN-n.md`; lỗi validate **không** phải SSH key.

| Khi | Jobs | Deploy |
|---|---|---|
| PR → `develop` | validate, tests, build, **note-pr** | Không |
| Push `develop` | validate, tests, build | Không |
| PR `develop` → `main` | cùng cổng PR | Không |
| Push `main` | tests + build + **production** | `velura.royalai.dev` |

`note-pr` bắt buộc xanh. Trace = job log + artifact `pr-trace.md` + comment trên PR.

Không có staging trên CI. Kiểm tra local (`:4001` / `:4002` / API `:8787`) rồi promote `develop` → `main`.

## Admin TMĐT — cơ sở đúng

Chuẩn phân hệ lấy từ Vendure (catalog, orders, customers, marketing, settings) nhưng **runtime là Angular + Node**. Mỗi màn `admin-ng` phải thỏa 8 điểm trong [COMPLIANCE.md](./COMPLIANCE.md) (list server-paged, detail, mutation có version, audit, RBAC từ `/api/auth/me`, MVVM, lazy route, test empty/error).

Luồng shop ↔ admin: sửa catalog/giá/KM trên admin → storefront đọc cùng API. Không page-builder. CMS nội dung (`/api/content`) hoãn đến khi catalog/orders đúng hợp đồng.

## Production

| Path | Env |
|---|---|
| `/var/www/velura/{user,admin}` | SPA |
| `/opt/velura/api` + `/opt/velura/.env` | API :8787 |

## Secrets (GitHub → Settings → Environments → production)

| Secret | Ghi chú |
|---|---|
| `SSH_PRIVATE_KEY` | PEM deploy |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan -H 135.235.219.13` |
| `DEPLOY_HOST` | `135.235.219.13` |
| `DEPLOY_USER` | `azureuser` |

Sudoers VM: `systemctl restart velura-api` (`deploy/scripts/bootstrap-vps.sh`).

Repo **public** + Student Pack: Actions runner chuẩn trên public **không trừ** phút. Private mới đếm vào 3.000 phút/tháng.

## GitHub Settings (lead, một lần)

1. Protected branches: `main` + `develop` — không push trực tiếp; merge qua PR.
2. Required status checks: `validate`, `test-api`, `test-angular`, `build` (+ `validate-pr-contract` / `note-pr` trên PR).
3. Environment **production**: secrets ở trên; chỉ job trên `main` deploy.
4. Require PR before merging; ≥ 1 approval (CODEOWNERS).
5. Cấm `[skip ci]` (job `validate` fail nếu có).
6. Jira: comment URL PR sau merge (app GitHub for Jira nếu có).

CODEOWNERS: [`.github/CODEOWNERS`](../.github/CODEOWNERS) — thêm username GitHub của 5–6 thành viên khi có account.
