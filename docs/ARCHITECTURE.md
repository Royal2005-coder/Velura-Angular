# Velura Angular architecture

The lecture slides in `Angularframewor.md` describe modules, components, and services. This workspace keeps that teaching model and implements it with **Angular 21 standalone components + Signals**, as required by the academic Clean Architecture guides.

```
View (template)
  → ViewModel (standalone component, signals, computed)
    → Model (injectable service)
      → HTTP / API DTO
        → Node router
          → Application service
            → Repository (Supabase)
```

## Apps

| Path | Responsibility |
|---|---|
| `apps/user-ng` | Customer storefront SPA. Port 4002 locally. |
| `apps/admin-ng` | Admin operations SPA. Port 4001 locally. |
| `apps/api` | Interface + application + infrastructure for HTTP. Port 8787. |

## Frontend rules

- A page component holds UI state in Signals. It does not know SQL or HTTP verbs.
- `AdminApiService` / `ApiService` own HTTP and DTO mapping.
- Shared presentational pieces (pagination, product card) receive inputs and emit outputs.
- Public methods have JSDoc. Types are explicit. `any` is forbidden.
- Production builds replace `environment.ts` with `environment.prod.ts` (`apiUrl: ''` = same origin).

## Backend rules

- Routers parse the request and call a service.
- Services enforce validation, optimistic locking, and role rules.
- Repositories are the only files that talk to Supabase.
- Database exceptions become domain/HTTP errors before they leave the service.

## Local vs production

Local admin Google SSO uses `http://localhost:4001/auth/callback`. Production admin uses the same path on `https://admin.velura.royalai.dev` so the SPA does not need a `/admin` base href.
