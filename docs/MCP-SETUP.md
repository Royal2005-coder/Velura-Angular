# MCP setup (Cursor) — GitLab + Jira

Agent và thành viên mới: cài MCP **trước** khi tạo issue/MR hộ team. File mẫu: `.cursor/mcp.json` (commit trong repo). Copy vào `%USERPROFILE%\.cursor\mcp.json` nếu Cursor chưa có.

## 1. File cấu hình

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://gitlab.com/api/v4/mcp",
      "headers": {
        "X-Gitlab-Mcp-Server-Tool-Name-Prefix": "gitlab_"
      }
    },
    "Atlassian": {
      "url": "https://mcp.atlassian.com/v1/mcp"
    }
  }
}
```

Atlassian: dùng Streamable HTTP `https://mcp.atlassian.com/v1/mcp`. SSE `/v1/sse` hết hỗ trợ sau **30/06/2026**.

## 2. Connect trong Cursor

1. Settings → Tools & MCP.
2. **Atlassian** → Connect → OAuth (account Jira `webadvance.atlassian.net`).
3. **GitLab** → Connect → OAuth bằng user **có quyền** `boygia757-netizen/velura-project`.

## 3. GitLab MCP trả 404

URL đúng. 404 = group GitLab.com chưa bật MCP (Duo + beta + Allow MCP). Owner group bật; xem [KAN-11](https://webadvance.atlassian.net/browse/KAN-11).  
`glab` login nhầm user (`Royal2005-coder`) không thấy project — không dùng user đó cho MCP.

Không có GitLab MCP: vẫn làm việc bằng `git` SSH + UI GitLab. Jira MCP vẫn đủ tạo/chuyển Task.

## 4. Agent dùng MCP thế nào (không bỏ pipeline)

1. Jira: `searchJiraIssuesUsingJql` / `createJiraIssue` — key `KAN`.
2. Code trên branch `feature/KAN-n-…`.
3. Git (không MCP): commit message chứa `KAN-n`, push, MR title chứa `KAN-n`.
4. Jira: comment link MR, chuyển Waiting for Review / Close theo [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

Cấm: sửa `main` trực tiếp; tạo GitLab Issue thay Jira; bỏ key `KAN-n`.
