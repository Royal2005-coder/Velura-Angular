# Source of truth (Velura)

Agent và người mới: `AGENTS.md` → `README.md` → file này → rồi mới mở code.

`docs/` không thay GitLab. Diff / git log / SHA nằm trên **MR**.

| Lớp | Ở đâu |
|---|---|
| Kiến trúc ổn định | file này + ADR 0001–0003 |
| Từng version | GitLab MR (`KAN-n`, Changes, CI `note:mr`) |
| Việc | Jira **KAN** |

```bash
git log --oneline --grep=KAN-n
git show --stat <sha>
```

## Học thuật (không copy sách vào Git)

| Gốc | Map |
|---|---|
| Slide UEL *Angular Framework* | [source-of-truth/LECTURE-MAP.md](./source-of-truth/LECTURE-MAP.md) |
| GoalKicker *Angular 2+ Notes for Professionals* | [source-of-truth/BOOK-MAP.md](./source-of-truth/BOOK-MAP.md) |
| TinyBigCorp `AGENTS.md` | Frontend MVVM+Signals. API Velura = Node — [ADR 0002](./adr/0002-node-api-javascript.md) |

## Angular = SPA, không phải HTTP server

| Tầng | Velura | Angular? |
|---|---|---|
| Storefront / Admin | Angular 21 standalone + Signals | Có |
| HTTP API | Node TypeScript, `apps/api`, router → service → repository | Không — **đúng** |
| Test API | `tests/api/*.test.ts` | Không |
| Test UI | `*.page.spec.ts` (CI `test:angular`) | Có |
| DB | PostgreSQL / Supabase | Không |

GoalKicker ch. 1.1: Angular + **Node**. Không viết API bằng Angular.

## Layers

```
View (HTML)
  → ViewModel (standalone page, signal / computed)
    → Model (ApiService / AdminApiService)
      → Node router → service → repository (Supabase)
```

Page không biết SQL/HTTP verb. `HttpClient` chỉ trong service.

## NgModule (slide) → standalone (production)

| Slide | Velura |
|---|---|
| `AppModule` | `app.config.ts` + `app.routes.ts` |
| `declarations` | `standalone: true` |
| `HttpClientModule` | `provideHttpClient(withInterceptors([...]))` |
| `*ngIf` / `*ngFor` | `@if` / `@for` |

[ADR 0001](./adr/0001-angular-21-standalone-signals.md). TypeScript trên API Node: [ADR 0003](./adr/0003-node-api-typescript.md) (Accepted).

## SDLC

Feature → MR **develop** → staging → MR **develop → main** → production. Chi tiết [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). Gap: [COMPLIANCE.md](./COMPLIANCE.md).
