# ADR 0002: Node JavaScript API beside Angular SPAs

Date: 2026-09-09  
Status: Accepted  
Jira: KAN-13

## Context

TinyBigCorp academic stack ghi FastAPI/Python. Sách Angular GoalKicker ch. 1.1 dùng Node/Express với Angular. Velura production đã chạy Node + Supabase trên `https://velura.royalai.dev/api`. Slide Angular **không** định nghĩa backend language.

Viết lại API bằng Angular là sai (Angular không phải HTTP server của hệ thống này). Rewrite Python ngay sẽ cắt pipeline đang live.

## Decision

Giữ `apps/api` **Node** với OOP: router → service → repository. Ngôn ngữ nguồn là TypeScript ([ADR 0003](./0003-node-api-typescript.md)). Test API bằng `tests/api/*.test.ts`. Angular apps chỉ consume JSON.

Migrate Python chỉ khi có ADR mới và epic riêng — không lẫn trong MR UI.

TypeScript **trên cùng Node runtime** (không phải Angular): [ADR 0003](./0003-node-api-typescript.md) (Accepted). Không rewrite API trong MR UI.

## Consequences

- `test:api` trong GitLab CI là cổng chất lượng backend.
- Agent không “chuẩn hóa” bằng cách xóa JS.
- JSDoc/docstring trên public functions API vẫn bắt buộc.
