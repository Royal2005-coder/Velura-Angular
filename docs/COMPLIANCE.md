# Compliance vs source of truth

Đánh giá trung thực. Agent không được tuyên bố “đã 100% Angular thuần” nếu mục còn Gap.

## Đúng chuẩn (giữ)

| Mục | Bằng chứng |
|---|---|
| Angular = frontend TypeScript SPA | `apps/user-ng`, `apps/admin-ng` |
| User / Admin tách | hai app, hai origin production |
| Component + template + TS class | `*.page.ts` / `.html` |
| HTTP trong service, không trong template | `ApiService`, `AdminApiService` |
| DI | `inject()` |
| Interceptor auth | `core/interceptors`, `admin-auth.interceptor.ts` |
| Standalone + Signals (TinyBigCorp) | không `NgModule` |
| API OOP layers | `*-router.ts` → `*-service.ts` → `*-repository.ts` |
| Tests API theo ngôn ngữ API | `tests/api/*.test.ts` (CI `test:api` + `typecheck:api`) |
| Tests Angular trên CI | `test:angular` → `ng test --watch=false` |
| Page ViewModel specs | `*.page.spec.ts` cạnh page; mock Model, không gọi mạng |
| Pipeline Jira key | branch/MR `KAN-n`; feature → develop → staging → main |
| Trace version | CI `note:mr`: job log + artifact `mr-trace.md` |
| CODEOWNERS | `.gitlab/CODEOWNERS` |

## Cố ý không làm (không phải thiếu)

| Ý tưởng sai | Lý do |
|---|---|
| Viết API bằng Angular | Angular không chạy server HTTP production của Velura |
| Đổi `apps/api` sang Python FastAPI ngay | TinyBigCorp academic stack; Velura đang live Node + Supabase. Xem [ADR 0002](./adr/0002-node-api-javascript.md) |
| Đưa NgModule trở lại “cho giống slide” | Trái Angular 21 + TinyBigCorp |
| Đợi API TypeScript rồi mới test page | Page test mock `ApiService`. API đã TypeScript trên Node ([ADR 0003](./adr/0003-node-api-typescript.md)) |

## Gap (ticket / MR tiếp)

| Gap | Việc | Jira |
|---|---|---|
| Lazy routes | `loadComponent` feature | [KAN-7](https://webadvance.atlassian.net/browse/KAN-7) |
| Empty/error UI | cart, wishlist, checkout | [KAN-8](https://webadvance.atlassian.net/browse/KAN-8) |
| Change password admin | gọi API, bỏ stub local | [KAN-9](https://webadvance.atlassian.net/browse/KAN-9) |
| Page specs sâu hơn khi đụng feature | empty/error/filter còn thiếu trên một số page | KAN-4 / KAN-5 |
| Domain API bỏ `// @ts-nocheck` | từng bounded context, runtime vẫn Node | [ADR 0003](./adr/0003-node-api-typescript.md) · [KAN-15](https://webadvance.atlassian.net/browse/KAN-15) |
| GitLab MCP 404 | bật Duo/MCP trên group | [KAN-11](https://webadvance.atlassian.net/browse/KAN-11) |
