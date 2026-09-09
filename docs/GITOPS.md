# GitOps and CI/CD

ReadyX training uses GitLab + Argo CD + Harbor on Kubernetes. This project is a **single Azure Ubuntu VM**, so Git remains the source of truth and GitLab CI deploys over SSH. There is no cluster and no Argo Application.

```
Jira KAN-n  →  feature/KAN-n-name  →  Merge Request (Jira key + notes)
                                                      ↓
                                         CI: validate / test / build
                                                      ↓
                                                   merge main
                                                      ↓
                              CI deploy + verify
                              https://velura.royalai.dev
                              https://admin.royalai.dev
```

## Branch policy

| Branch | Pipeline | Deploy |
|---|---|---|
| `feature/KAN-*` | validate, API tests, Angular production build | No |
| Merge Request | same + GitLab MR note with SHA | No |
| `develop` | same as feature (integration gate) | No |
| `main` | same gates, then `deploy:production` | Yes |

Never push directly to `main` for product work. Open an MR, fill the template in `.gitlab/merge_request_templates/Default.md`, wait for green pipelines, then merge.

## GitLab CI variables (Settings → CI/CD → Variables)

| Variable | Type | Value |
|---|---|---|
| `SSH_PRIVATE_KEY` | File / masked | Contents of `web_key.pem` — never commit this file |
| `SSH_KNOWN_HOSTS` | Variable | `ssh-keyscan -H 135.235.219.13` |
| `DEPLOY_HOST` | Variable | `135.235.219.13` |
| `DEPLOY_USER` | Variable | `azureuser` or `ubuntu` (set after first SSH) |
| `GITLAB_TOKEN` | Masked | Project token with `api` scope so MR notes can be posted |

Protected variables: protect `SSH_PRIVATE_KEY` for `main` only.

## Server layout

| Path | Content |
|---|---|
| `/var/www/velura/user` | Customer SPA (`user-ng` browser build) |
| `/var/www/velura/admin` | Admin SPA (`admin-ng` browser build) |
| `/opt/velura/api` | Node API |
| `/opt/velura/.env` | Production secrets (not in Git) |
| `/etc/nginx/sites-available/velura` | TLS + `/api` reverse proxy |
| `velura-api.service` | systemd unit on port 8787 |

## First bootstrap

From a machine that has the PEM:

```bash
ssh -i web_key.pem DEPLOY_USER@135.235.219.13
sudo bash /tmp/bootstrap-vps.sh
```

Then place `/opt/velura/.env` from `.env.example` with live Supabase keys.
