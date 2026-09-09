# GitOps

Một Azure VM. Git = nguồn sự thật. Không Kubernetes.

Luồng đầy đủ: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). Context từng version = **GitLab MR** (git log + note CI), không phải ADR.md từng ticket.

| Branch | Deploy |
|---|---|
| `feature/KAN-*` / MR → `develop` | Không |
| `develop` | Staging `staging.velura.royalai.dev` / `staging-admin.royalai.dev` |
| `main` | Production `velura.royalai.dev` / `admin.royalai.dev` |

## CI variables

| Variable | Ghi chú |
|---|---|
| `SSH_PRIVATE_KEY` | PEM; bật cho `develop` **và** `main` |
| `SSH_KNOWN_HOSTS` | `ssh-keyscan -H 135.235.219.13` |
| `DEPLOY_HOST` | `135.235.219.13` |
| `DEPLOY_USER` | `azureuser` |
| `GITLAB_TOKEN` | Project token `api` — bắt buộc nếu `JOB-TOKEN` không post được MR note |

## Paths

| Path | Env |
|---|---|
| `/var/www/velura/{user,admin}` | production |
| `/opt/velura/api` + `/opt/velura/.env` | production API :8787 |
| `/var/www/velura-staging/{user,admin}` | staging |
| `/opt/velura-staging/api` + `.env` `PORT=8788` | staging API |

Sudoers trên VM phải include `systemctl restart velura-api-staging` (cập nhật bằng `bootstrap-vps.sh` hoặc sửa `/etc/sudoers.d/velura-deploy` một lần).
