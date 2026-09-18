# MCP setup (Cursor) — Jira (+ GitHub CLI)

Agent và thành viên mới: cài MCP **trước** khi tạo issue/PR hộ team.

**Canonical VCS:** https://github.com/Royal2005-coder/Velura-Angular (GitHub Actions).  
GitLab MCP là legacy — không cần cho team đồ án.

## 1. File cấu hình (Jira)

```json
{
  "mcpServers": {
    "Atlassian": {
      "url": "https://mcp.atlassian.com/v1/mcp"
    }
  }
}
```

Atlassian: Streamable HTTP `https://mcp.atlassian.com/v1/mcp`. SSE `/v1/sse` hết hỗ trợ sau **30/06/2026**.

Copy vào `%USERPROFILE%\.cursor\mcp.json` nếu Cursor chưa có.

## 2. Connect trong Cursor

1. Settings → Tools & MCP.
2. **Atlassian** → Connect → OAuth (account Jira `webadvance.atlassian.net`).
3. GitHub: dùng `gh auth login` + Cursor GitHub connect (PR/review). Không bắt buộc GitLab MCP.

## 3. Agent dùng thế nào (không bỏ pipeline)

1. Jira: `searchJiraIssuesUsingJql` / `createJiraIssue` — key `KAN`.
2. Code trên branch `feature/KAN-n-…`.
3. Git: commit message có `KAN-n`, push lên GitHub, PR title có `KAN-n`, body có `## Why`.
4. Đợi GitHub Actions xanh → review → merge vào `develop`.
5. Jira: comment link PR, chuyển Waiting for Review / Close theo [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

Cấm: sửa `main` trực tiếp; tạo GitHub/GitLab Issue thay Jira; bỏ key `KAN-n`; push CI lên GitLab.
