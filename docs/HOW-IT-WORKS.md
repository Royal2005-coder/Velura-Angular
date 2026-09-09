# Jira ↔ GitLab — luồng vận hành

Jira = việc. GitLab MR = **log phiên bản** (diff, git log, CI note).  
`docs/` chỉ giữ map ổn định (Angular, pipeline). **Không** tạo file md cho từng ticket.

Bộ SDLC này **chưa** trên `main`. Team clone `feature/KAN-13-team-onboarding` cho đến khi MR vào `develop` được merge. Xem [AGENTS.md](../AGENTS.md).

## Vòng đời

```
Jira KAN-n
  → git checkout develop && git pull
  → feature/KAN-n-short
  → commit "KAN-n why"
  → MR vào develop (title bắt đầu KAN-n, điền template)
  → CI bắt buộc: validate + test:api + test:angular + build + note:mr (ghi git log + diff --stat lên MR)
  → 1 reviewer (CODEOWNERS) merge develop
  → CI develop: deploy:staging + verify:staging
  → Lead kiểm tra staging
  → MR develop → main (title KAN-n promote / cùng key)
  → CI main: deploy:production + verify:production
  → Jira Close
```

Cấm: feature → `main`. Cấm `[skip ci]`. Cấm ADR.md cho bug/feature thường.

## Trace (CLI + giao diện MR)

```bash
git log --oneline --grep=KAN-13
git show --stat <sha>
git diff develop...HEAD --stat
```

Trên GitLab: MR → Changes (file) + Notes (CI trace bắt buộc). Agent/người sau sửa tiếp từ MR, không từ docs rời.

## Jobs

| Khi | Jobs | Deploy |
|---|---|---|
| MR → `develop` | validate, `test:api`, `test:angular`, build, **note:mr** | Không |
| Push `develop` | tests + build + `deploy:staging` + `verify:staging` | Staging cùng VM |
| MR `develop` → `main` | cùng cổng MR | Không |
| Push `main` | tests + build + `deploy:production` + `verify:production` | Production |

`note:mr` **không** `allow_failure`. Thiếu `GITLAB_TOKEN` (api) thì dùng `JOB-TOKEN`; nếu 403, thêm biến `GITLAB_TOKEN`.

## Staging (cùng Azure VM)

| Host | Root |
|---|---|
| staging.velura.royalai.dev | `/var/www/velura-staging/user` |
| staging-admin.royalai.dev | `/var/www/velura-staging/admin` |
| API :8788 | `/opt/velura-staging/api`, `.env` `PORT=8788` |

Cloudflare A (proxied) cùng IP `135.235.219.13`. Verify CI dùng `Host:` tới `127.0.0.1` nên không phụ thuộc DNS để pass; DNS cần cho người mở browser.

CORS staging: thêm origin staging vào `/opt/velura-staging/.env`.

## GitLab Settings (bật một lần, không nằm trong YAML)

1. Settings → Repository → Protected branches: `main` và `develop` — no direct push, maintainers merge.
2. Settings → Merge requests: **Pipelines must succeed**; **Require approval from code owners**; approvals ≥ 1.
3. Settings → Repository → Push rules: reject commit message `\[skip ci\]`.
4. CI/CD Variables: `SSH_PRIVATE_KEY` available on **develop and main** (unprotect or protect both).
5. CODEOWNERS: `.gitlab/CODEOWNERS` — thêm 5 username GitLab.

## Jira Development

Branch/MR phải chứa `KAN-n`. App **GitLab for Jira Cloud** link group `boygia757-netizen`.
