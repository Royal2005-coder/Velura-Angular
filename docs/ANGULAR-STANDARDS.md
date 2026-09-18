# Angular 21 coding standard (Velura)

**Cây dự án + layer OOP + role map:** [ARCHITECTURE.md](./ARCHITECTURE.md) (đọc trước khi sửa feature).

Lecture slides map: [docs/source-of-truth/LECTURE-MAP.md](./source-of-truth/LECTURE-MAP.md).  
Book map: [docs/source-of-truth/BOOK-MAP.md](./source-of-truth/BOOK-MAP.md).  
Index: [SOURCE-OF-TRUTH.md](./SOURCE-OF-TRUTH.md).

This workspace keeps the teaching model and implements it with **Angular 21 standalone components + Signals** ([ADR 0001](./adr/0001-angular-21-standalone-signals.md)).

```
View (HTML template)
  → ViewModel (standalone component: signals, computed, events)
    → Model (injectable service)
      → HttpClient / DTO
        → apps/api router → service → repository
```

## Required

- Standalone components only. No `NgModule`.
- Derived UI state is `computed()` / `signal()`. Templates do not call `.filter()`, `.map()`, or `.sort()`.
- HTTP lives in services (`ApiService`, `AdminApiService`, catalog services). Pages inject those services.
- Public methods have JSDoc. Types are explicit. `any` is forbidden (`unknown` only when the DTO is truly unknown).
- Smart (page/container) vs dumb (presentational: product card, pagination, icons).
- Design tokens: `src/app/theme/colors.ts`, `typography.scss`, `icons.registry.ts`. New SCSS uses CSS variables, not hex.
- Auth admin Google callback is `{origin}/auth/callback` (local :4001, prod `https://admin.royalai.dev`).
- Admin list payloads are `{ rows, count }`. Mutations send `expectedVersion` when the API uses optimistic locking.

## Forbidden

- Logic in templates (`{{ items.filter(...) }}`)
- `HttpClient` inside a page component
- Hardcoded `#FFFFFF` in new component SCSS
- Importing from `app.module`
- Service-role keys or `.env` in the browser or Git

## File layout per feature

```
features/<name>/
  <name>.page.ts      ViewModel (signals)
  <name>.page.html    View
  <name>.page.scss    optional; tokens only
core/services/        Model (HTTP, mapping)
shared/               presentational inputs/outputs
theme/                tokens
```

## Two apps

| App | Theme folder | Model service |
|---|---|---|
| `apps/user-ng` | `src/app/theme` | `core/services/api.service.ts` |
| `apps/admin-ng` | `src/app/theme` | `core/admin-api.service.ts` |

Local ports stay **4002** (user), **4001** (admin, host `localhost` for Google SSO), **8787** (API).

## Unit tests (ViewModel)

Book ch. 2 / 23.3: test the **component class**, not the HTTP server.

- Colocate `*.page.spec.ts` next to `*.page.ts`.
- Provide a **stub Model** (`ApiService`, `AdminApiService`, `CatalogService`). Never hit the network.
- Assert **signals / computed** (empty cart, invalid login form, dashboard tabs). `should create` alone is not enough for a page with ViewModel logic.
- Do not import `HttpClient` in the spec to “make the page work” — if the page needs HTTP, the architecture is wrong.
- API TypeScript is [ADR 0003](./adr/0003-node-api-typescript.md). Page tests do not block on it.
