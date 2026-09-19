# Source of truth (Velura)

**Cái gì** = type + JSDoc trong code. **Tại sao** = `git log` + PR + git notes. File này chỉ map ổn định.

```bash
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
```

Chi tiết retrieval: [AGENTS.md](../AGENTS.md). Cây + layer: [ARCHITECTURE.md](./ARCHITECTURE.md). Versioning + Actions: [GIT-AND-CI.md](./GIT-AND-CI.md). Pipeline: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

| Lớp | Ở đâu |
|---|---|
| Hợp đồng nghiệp vụ | `interface` / JSDoc (ví dụ `apps/api/src/types.ts`, `ApiService`) |
| Version / why | GitHub PR (`## Why`) + CI `note-pr` + `git notes` |
| Việc | Jira **KAN** |
| Rule lâu dài (một câu) | [adr/README.md](./adr/README.md) |

## Angular = SPA

| Tầng | Velura | Angular? |
|---|---|---|
| Storefront / Admin | Angular 21 standalone + Signals | Có |
| HTTP API | Node TypeScript, router → service → repository | Không |
| Test UI / API | `*.page.spec.ts` / `tests/api/*.test.ts` | UI có / API không |
| DB | PostgreSQL / Supabase | Không |

GoalKicker ch. 1.1: Angular + **Node**. Slide: TypeScript trên component, REST Node tách.

| Slide | Repo |
|---|---|
| `AppModule` | `app.config.ts` + `app.routes.ts` |
| `*ngIf` / `*ngFor` | `@if` / `@for` |

Maps học thuật (không copy sách): [LECTURE-MAP](./source-of-truth/LECTURE-MAP.md), [BOOK-MAP](./source-of-truth/BOOK-MAP.md).
