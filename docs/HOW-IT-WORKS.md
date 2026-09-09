# Jira ↔ GitLab — luồng vận hành

Jira = việc. GitLab MR = **log phiên bản** (Changes, git log, CI `note:mr`).  
`docs/` chỉ map ổn định. **Không** tạo markdown theo ticket.

```
Jira KAN-n
  → git checkout develop && git pull
  → feature/KAN-n-short
  → commit "KAN-n why"
  → MR vào develop (title bắt đầu KAN-n)
  → CI: validate + test:api + test:angular + build + note:mr
  → CODEOWNERS reviewer merge develop
  → deploy:staging + verify:staging (cùng Azure VM)
  → MR develop → main (title KAN-n promote)
  → deploy:production + verify:production
  → Jira Close + comment URL MR
```

Cấm: feature → `main`. Cấm `[skip ci]`. Cấm ADR.md cho bug thường. Cấm GitLab Issues làm backlog.

## Trace

```bash
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
git diff develop...HEAD --stat
```

GitLab: MR (`## Why`) + Changes + job `note:mr` (log, notes, artifact `mr-trace.md`).

## Jobs

| Khi | Jobs | Deploy |
|---|---|---|
| MR → `develop` | validate, tests, build, **note:mr** | Không |
| Push `develop` | tests + build + staging | `staging.velura.royalai.dev` |
| MR `develop` → `main` | cùng cổng MR | Không |
| Push `main` | tests + build + production | `velura.royalai.dev` |

`note:mr` không `allow_failure`. Trace bắt buộc nằm trên job log + artifact `mr-trace.md`. Post lên tab Notes khi có `GITLAB_TOKEN` (scope `api`); Job-Token thường 403 và **không** chặn merge.

## Staging (cùng VM, API :8788)

| Host | Path |
|---|---|
| staging.velura.royalai.dev | `/var/www/velura-staging/user` |
| staging-admin.royalai.dev | `/var/www/velura-staging/admin` |
| API | `/opt/velura-staging/api`, `.env` `PORT=8788` |

Verify CI gọi `Host:` tới `127.0.0.1` — không phụ thuộc DNS. Browser cần Cloudflare A (proxied) cùng IP `135.235.219.13`.

## Production

| Path | Env |
|---|---|
| `/var/www/velura/{user,admin}` | SPA |
| `/opt/velura/api` + `/opt/velura/.env` | API :8787 |

## CI variables (GitLab → CI/CD)

| Variable | Ghi chú |
|---|---|
| `SSH_PRIVATE_KEY` | PEM; **unprotect hoặc protect cả `develop` và `main`** |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan -H 135.235.219.13` |
| `DEPLOY_HOST` | `135.235.219.13` |
| `DEPLOY_USER` | `azureuser` |
| `GITLAB_TOKEN` | Chỉ khi `CI_JOB_TOKEN` không post được MR note |

Sudoers VM phải có `systemctl restart velura-api-staging` (`deploy/scripts/bootstrap-vps.sh`).

## GitLab Settings (lead, một lần)

1. Protected branches: `main` + `develop` — no direct push, Maintainers merge via MR.
2. Merge requests: Pipelines must succeed; Require approval from code owners; ≥ 1 approval.
3. Push rules: reject `\[skip ci\]`.
4. Integrations → Jira: Web URL `https://webadvance.atlassian.net`, project key `KAN`, comment + transition on merge.
5. Jira app **GitLab for Jira Cloud** link group `boygia757-netizen`.

CODEOWNERS: `.gitlab/CODEOWNERS` — thêm đủ 5 username GitLab khi có account.
