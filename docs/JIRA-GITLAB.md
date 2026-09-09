# Jira ↔ GitLab workspace (Velura)

Jira owns planning. GitLab owns code, MR, CI, and production deploy.
The two platforms stay in sync by **issue key in the branch and MR title**, plus two GitLab integrations.

```
Jira issue VEL-42
        ↓
feature/VEL-42-short-name
        ↓
Merge Request: "VEL-42 Fix admin host vhost"
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

Already written to `%USERPROFILE%\.cursor\mcp.json`.

1. Cursor → Settings → Tools & MCP.
2. **GitLab** and **Atlassian** should appear. Click **Connect** if they show Needs authentication.
3. Approve OAuth in the browser as **`boygia757-netizen`** (the owner of `velura-project`).  
   `glab` on this machine is currently `Royal2005-coder`, which cannot see that project.

GitLab.com group owners may also need: Group → Settings → GitLab Duo / MCP → allow MCP server access.

## 2. Jira Cloud app (development panel)

This is the panel on a Jira issue that lists GitLab branches, commits, and merge requests.

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
4. Web URL: `https://YOUR-SITE.atlassian.net` (no trailing slash).
5. Email: the Atlassian account email.
6. Password / API token: create at https://id.atlassian.com/manage-profile/security/api-tokens
7. Jira project keys: `VEL` (or the key you created).
8. Enable:
   - Comment on Jira issues
   - Transition Jira issues (typically **Done** / **Closed** when MR merges)

Save → **Test settings**.

## 4. Branch and MR contract (already in this repo)

| Item | Rule |
|---|---|
| Branch | `feature/VEL-123-short-kebab` |
| Commit | `VEL-123 explain why` |
| MR title | starts with `VEL-123` |
| MR template | Jira key required |
| Close issue | put `VEL-123` in the MR title; GitLab transitions Jira if configured |

Do not push product work to `main`. Production deploy is the `main` pipeline only.

## 5. Values this agent still needs to finish the API click for you

Send these in chat (API token is a secret — paste once, do not commit):

- Jira site: `https://….atlassian.net`
- Jira project key: e.g. `VEL`
- Atlassian email
- API token from https://id.atlassian.com/manage-profile/security/api-tokens

Without those four, GitLab cannot authenticate to Jira from this machine.
