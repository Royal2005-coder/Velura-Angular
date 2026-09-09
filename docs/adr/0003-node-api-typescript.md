# ADR 0003: TypeScript on the Node API (not Angular)

Date: 2026-09-09  
Status: Proposed  
Jira: [KAN-14](https://webadvance.atlassian.net/browse/KAN-14)  
Supersedes: nothing. Extends [ADR 0002](./0002-node-api-javascript.md).

## Context

COMPLIANCE and GoalKicker ch. 1.1 agree: Angular is the **browser SPA**. The HTTP API stays **Node**. End-to-end type safety is a real gap: `apps/user-ng` / `apps/admin-ng` speak TypeScript DTOs while `apps/api` and `tests/api` are JavaScript.

Two wrong “fixes” that agents keep proposing:

1. Rewrite the API **in Angular** — Angular does not host this production HTTP server.
2. Rewrite the API in **Python FastAPI** inside a UI MR — live Velura is Node + Supabase (ADR 0002).

The only professional upgrade for types is: **same Node runtime, same router → service → repository, `.js` → `.ts`**.

## Decision

- **Do not** convert `apps/api` to Angular, Nest-as-Angular, or FastAPI in order to “match the lecture.”
- **May** migrate `apps/api/**/*.js` and `tests/api/*.test.js` to TypeScript **incrementally**, one bounded context per MR (`products`, `orders`, `auth`, …).
- Public HTTP JSON contracts stay stable. Angular services keep consuming the same paths.
- Shared DTO types, if introduced, live in a small `packages/` contract — not inside `*.page.ts`.
- This ADR stays **Proposed** until the first context (recommend `apps/api/src/health` or `products`) lands with tests green. Then mark Accepted.

## Consequences

- `test:api` remains the backend quality gate; language may become `node --test` on compiled TS or `tsx` — chosen in the first migrate MR, not here.
- Page unit tests (`*.page.spec.ts`) mock `ApiService` / `AdminApiService`. They do **not** wait for API TypeScript.
- No ADR.md per ticket. Execution log = GitLab MR titled `KAN-n`.
