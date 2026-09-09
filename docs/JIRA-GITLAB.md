# Jira ↔ GitLab workspace (Velura)

Jira owns planning. GitLab owns code, MR, CI, and production deploy.
Issue keys stay in the **branch name and MR title**.

Site: https://webadvance.atlassian.net  
Project key: **KAN** (not VEL). Two-team playbook: [TEAM-PROCESS.md](./TEAM-PROCESS.md). Angular rules: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md).

```
Jira issue KAN-12
        ↓
feature/KAN-12-short-name
        ↓
Merge Request: "KAN-12 Policies page uses Signals"
        ↓
GitLab CI: validate → test → build  (no deploy)
        ↓
merge main
        ↓
GitLab CI: deploy + verify production
        ↓
Jira development panel shows branch, MR, commits, deploy
```

## 1. GitLab MCP (Cursor)

Config is in `%USERPROFILE%\.cursor\mcp.json` and this repo's `.cursor/mcp.json`.

1. Cursor → Settings → Tools & MCP.
2. **GitLab** and **Atlassian** should appear. Click **Connect** if they show Needs authentication.
3. Approve OAuth as **`boygia757-netizen`** (owner of `velura-project`).  
   `glab` on this machine as `Royal2005-coder` cannot see that project.

If GitLab MCP returns **404** after OAuth, the top-level GitLab group has not enabled Duo + beta + MCP server. That is [KAN-11](https://webadvance.atlassian.net/browse/KAN-11). See GitLab docs: https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/

Atlassian MCP: prefer Streamable HTTP `https://mcp.atlassian.com/v1/mcp` (SSE `/v1/sse` is deprecated after 30 June 2026).

## 2. Jira Cloud app (development panel)

1. In Jira: **Apps → Explore more apps → GitLab for Jira Cloud → Get it now**.
2. **Get started → Link groups**.
3. Sign in to GitLab.com as `boygia757-netizen` and link the namespace that contains `velura-project`.

Marketplace: https://marketplace.atlassian.com/apps/1221736/gitlab-com-for-jira-cloud

## 3. Jira issues integration (comments + close on merge)

GitLab project:  
https://gitlab.com/boygia757-netizen/velura-project/-/settings/integrations

1. Open **Jira**.
2. Active = on.
3. Authentication: **Basic**.
4. Web URL: `https://webadvance.atlassian.net` (no trailing slash).
5. Email: Atlassian account (currently `uelailab701@gmail.com`).
6. Password / API token: https://id.atlassian.com/manage-profile/security/api-tokens
7. Jira project keys: `KAN`
8. Enable comment on issues and transition on merge.

Save → **Test settings**.

## 4. Branch and MR contract

| Item | Rule |
|---|---|
| Branch | `feature/KAN-123-short-kebab` |
| Commit | `KAN-123 explain why` |
| MR title | starts with `KAN-123` |
| MR template | Jira key required |
| Close issue | put `KAN-123` in the MR title; GitLab transitions Jira if configured |

Do not push product work to `main`. Production deploy is the `main` pipeline only.

## 5. Board (already created)

| Key | Type | Team |
|---|---|---|
| [KAN-4](https://webadvance.atlassian.net/browse/KAN-4) | Epic | Storefront |
| [KAN-5](https://webadvance.atlassian.net/browse/KAN-5) | Epic | Admin |
| [KAN-6](https://webadvance.atlassian.net/browse/KAN-6) | Task | Policies Signals |
| [KAN-7](https://webadvance.atlassian.net/browse/KAN-7) | Task | Lazy routes |
| [KAN-8](https://webadvance.atlassian.net/browse/KAN-8) | Task | Empty/error states |
| [KAN-9](https://webadvance.atlassian.net/browse/KAN-9) | Task | Admin change password API |
| [KAN-10](https://webadvance.atlassian.net/browse/KAN-10) | Task | Admin theme folder |
| [KAN-11](https://webadvance.atlassian.net/browse/KAN-11) | Task | GitLab MCP + Jira app |
| [KAN-12](https://webadvance.atlassian.net/browse/KAN-12) | Task | Process docs |
| [KAN-13](https://webadvance.atlassian.net/browse/KAN-13) | Task | Onboarding practice (do not merge main) |
