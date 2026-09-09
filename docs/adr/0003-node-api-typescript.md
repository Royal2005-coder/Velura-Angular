# ADR 0003: TypeScript on the Node API (not Angular)

Date: 2026-09-09  
Status: Accepted  
Jira: [KAN-15](https://webadvance.atlassian.net/browse/KAN-15)  
Supersedes: language of [ADR 0002](./0002-node-api-javascript.md) (runtime still Node).

## Context

COMPLIANCE and GoalKicker ch. 1.1 agree: Angular is the **browser SPA**. The HTTP API stays **Node**. End-to-end type safety requires the API source to be TypeScript on that same runtime.

Two wrong “fixes”:

1. Rewrite the API **in Angular**.
2. Rewrite the API in **Python FastAPI** inside a UI MR.

## Decision

- `apps/api/src/**/*.ts` is the API source. `tests/api/*.test.ts` is the API test source.
- Runtime is **Node**. Compile with `tsc` to `apps/api/dist`. systemd runs `node dist/server.js`.
- Local/dev and CI tests run TypeScript via `tsx` (`npm run start:api`, `npm run test:api`).
- Public HTTP JSON contracts stay stable. Angular services keep consuming the same paths.
- Kernel modules (`types`, `http`, `config`, `rbac`, `supabase`, `rate-limit`, `auth-helper`) are fully type-checked. Remaining bounded contexts may keep `// @ts-nocheck` until a follow-up MR removes it file-by-file.
- Do **not** convert `apps/api` to Angular or FastAPI.

## Consequences

- CI `test:api` runs `typecheck:api` then `node --import tsx --test tests/api/*.test.ts`.
- CI `build:angular` also runs `build:api` so deploy artifacts include `dist/`.
- Page unit tests still mock `ApiService` / `AdminApiService`.
