# Agent contract (Velura)

Read this file first. Then follow the links. Do not invent a second process.

## Read order (mọi agent, mọi thành viên mới)

1. This file (`AGENTS.md`)
2. [README.md](README.md)
3. [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md) — Angular lecture + book mapped to this repo
4. [docs/MCP-SETUP.md](docs/MCP-SETUP.md) — Cursor GitLab + Jira MCP
5. [docs/ANGULAR-STANDARDS.md](docs/ANGULAR-STANDARDS.md) — how to write UI
6. [docs/COMPLIANCE.md](docs/COMPLIANCE.md) — what is done vs gap
7. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — Jira → GitLab CI → production
8. Feature code under `apps/user-ng` or `apps/admin-ng` or `apps/api`

Source files outside Git (do not copy the book into Git):

- Lecture: TinyBigCorp `docs/Angularframewor.md` → map [docs/source-of-truth/LECTURE-MAP.md](docs/source-of-truth/LECTURE-MAP.md)
- Book: TinyBigCorp `docs/Angularbooksourceoftruth.md` → map [docs/source-of-truth/BOOK-MAP.md](docs/source-of-truth/BOOK-MAP.md)

## Non-negotiable facts

- Angular is the **frontend SPA** only. `apps/api` in JavaScript is correct (ADR 0002). Tests for the API stay `tests/api/*.test.js`.
- Lecture `NgModule` maps to **standalone + Signals** (ADR 0001). Do not add `NgModule`.
- Work starts in Jira **KAN**, never as a GitLab Issue. Branch and MR title contain `KAN-n`.
- Feature/MR pipelines must not deploy. Only `main` runs `deploy:production`.

<Context>
  <Philosophy>
    Maintainability, typed UI contracts, and reviewable merge requests over speed.
    Explicit layers over framework magic. Map the UEL Angular lecture onto Angular 21.
  </Philosophy>
  <Scope>
    Storefront `apps/user-ng` (KAN-4) and Admin `apps/admin-ng` + Node `apps/api` (KAN-5).
  </Scope>
</Context>

<Architecture>
  <Frontend_Pattern>
    Lecture: Component (template + class) + Service (HTTP).
    Production: View = HTML, ViewModel = standalone component + signals,
    Model = injectable service. No HttpClient in pages. No `any`.
  </Frontend_Pattern>
  <Backend_Pattern>
    Router parses HTTP. Service owns rules and optimistic locking.
    Repository owns Supabase. Domain errors mapped before the router.
  </Backend_Pattern>
</Architecture>

<Constraints>
  <DO>
    - Standalone components and Signals for derived state
    - JSDoc on public TypeScript methods; docstrings on public API functions
    - Design tokens in `src/app/theme` — no new hardcoded hex
    - `feature/KAN-n-kebab` → MR template (ADR section if architecture) → CI → merge `main`
    - After code change, comment the Jira key with the MR URL
  </DO>
  <DO_NOT>
    - NgModules or `app.module.ts`
    - Logic in templates (`{{ data.filter(...) }}`)
    - Rewrite `apps/api` to Angular or Python inside a UI MR
    - Commit `.env`, `*.pem`, service-role keys
    - Deploy from a feature branch or skip the Jira key
  </DO_NOT>
</Constraints>
