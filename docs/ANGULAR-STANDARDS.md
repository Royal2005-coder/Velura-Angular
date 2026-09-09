# Angular 21 coding standard (Velura)

Lecture slides (`Angularframewor.md`) teach Module → Component → Service. This workspace keeps that teaching model and implements it with **standalone components + Signals**, as required by the academic Clean Architecture guides.

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
