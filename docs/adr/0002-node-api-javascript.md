# ADR 0002: Node HTTP beside Angular SPAs

Date: 2026-09-09  
Status: Accepted  
Trace: `git log --oneline --show-notes --grep=KAN-13`

## Decision

`apps/api` = **Node** (router → service → repository). Không viết API bằng Angular hay FastAPI trong MR UI. Ngôn ngữ nguồn: TypeScript — [0003](./0003-node-api-typescript.md).
