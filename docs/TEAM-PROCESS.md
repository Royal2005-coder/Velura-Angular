# Two-team process (Jira + GitLab)

Onboard 5 người: bắt đầu ở [README.md](./README.md) (mục lục docs) → [ONBOARDING.md](./ONBOARDING.md) → [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) → [PRACTICE-DRILL.md](./PRACTICE-DRILL.md).

Jira plans work. GitLab holds code, merge requests, CI, and production deploy.

| Team | Owns | Production | Local |
|---|---|---|---|
| **Storefront** | `apps/user-ng` | https://velura.royalai.dev/ | `npm run start:user` → :4002 |
| **Admin** | `apps/admin-ng`, `apps/api` | https://admin.royalai.dev/ | admin :4001, API :8787 |

Shared packages (`packages/*`, `database/`) need both teams on the MR.

## Boards

- Jira site: https://webadvance.atlassian.net
- Project: **KAN** (Webadvance Team)
- Epics:
  - [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) Storefront
  - [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) Admin
- Labels: `team-storefront`, `team-admin`, `angular`, `process`

Placeholder tickets KAN-1 … KAN-3 are sample data. Do not use them for Velura work.

## Flow

```
Jira KAN-n (To Do)
  → feature/KAN-n-short-kebab
  → MR title starts with KAN-n  (template in .gitlab/merge_request_templates)
  → CI: validate + test:api + build:angular  (no deploy)
  → merge main
  → CI: deploy:production + verify:production
  → Jira → Close
```

Do not push product work to `main`. Do not deploy from a feature branch.

## Branch and commit

| Item | Rule |
|---|---|
| Branch | `feature/KAN-12-policies-signals` |
| Commit | `KAN-12 explain why` (conventional type optional: `feat: KAN-12 …`) |
| MR title | `KAN-12 Policies page uses Signals` |

## Who reviews what

- Storefront MR: another Storefront reviewer; Admin reviewer if API/DTO changed.
- Admin MR: another Admin reviewer; Storefront reviewer if storefront contracts changed.
- CI red = no merge.

## GitLab MCP (Cursor)

The GitLab MCP URL is correct (`https://gitlab.com/api/v4/mcp`). A **404 after OAuth** means GitLab.com has not enabled MCP on the **top-level group**. A group Owner signed in as `boygia757-netizen` must:

1. Group → Settings → GitLab Duo: availability on
2. Beta / experimental features on
3. Allow MCP server access

OAuth in Cursor must use **`boygia757-netizen`**. `glab` as `Royal2005-coder` cannot see this project.

Tracked as [KAN-11](https://webadvance.atlassian.net/browse/KAN-11).

## GitLab ↔ Jira click-path

1. Jira: Apps → GitLab for Jira Cloud → link group `boygia757-netizen`.
2. GitLab project → Settings → Integrations → Jira:
   - Web URL: `https://webadvance.atlassian.net`
   - Email + API token
   - Project keys: `KAN`
   - Comment on issues + transition on merge
