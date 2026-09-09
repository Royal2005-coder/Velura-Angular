# Source of truth (Velura)

Đây là **nguồn sự thật ổn định** của workspace. Agent và người mới: `AGENTS.md` → `README.md` → file này → rồi mới mở code.

`docs/` **không** thay GitLab. Ticket / diff / git log nằm trên **MR**. File này chỉ map kiến trúc + SDLC để cả team cùng một hợp đồng.

## Hai lớp nguồn sự thật

| Lớp | Nội dung | Nơi lưu |
|---|---|---|
| Ổn định (ít đổi) | Angular là SPA; API là Node; standalone+Signals; luồng develop→staging→main | `docs/` (file này, ADR 0001/0002, HOW-IT-WORKS) |
| Từng version | Vì sao sửa, file nào đổi, SHA nào | GitLab MR: title `KAN-n`, tab Changes, CI `note:mr` (git log + `diff --stat`) |
| Việc | Ai làm gì, Done/Close | Jira **KAN** |

Không tạo `docs/KAN-14.md` / ADR cho bug thường. Người sau / agent:

```bash
git log --oneline --grep=KAN-n
git show --stat <sha>
```

Rồi mở MR cùng key trên GitLab.

## Tài liệu học thuật (ngoài Git)

| Gốc | Vai trò | Map trong repo |
|---|---|---|
| Slide UEL *Angular Framework* (Phúc NQ) | App → Module → Component → Service → HTTP | [source-of-truth/LECTURE-MAP.md](./source-of-truth/LECTURE-MAP.md) |
| *Angular 2+ Notes for Professionals* (GoalKicker) | DI, interceptor, forms, routing, testing | [source-of-truth/BOOK-MAP.md](./source-of-truth/BOOK-MAP.md) |
| TinyBigCorp `AGENTS.md` | SOLID, MVVM + Signals | Áp dụng **frontend**. Backend Velura = Node — [ADR 0002](./adr/0002-node-api-javascript.md) |

## Angular không phải toàn bộ hệ thống

Angular = **SPA TypeScript trên browser** (`apps/user-ng`, `apps/admin-ng`).

Slide và sách: Angular là front-end. GoalKicker **ch. 1.1** = Angular + **Node/Express**. API không viết bằng Angular.

| Tầng | Công nghệ Velura | Angular? |
|---|---|---|
| Storefront / Admin UI | Angular 21 standalone + Signals + TypeScript | Có |
| HTTP API | Node, `apps/api/**/*.js`, router → service → repository | Không — **đúng** |
| Test API | `tests/api/*.test.js` | Không |
| Test UI | `*.spec.ts` trên CI (`test:angular`) | Có — còn mỏng từng page |
| DB | PostgreSQL / Supabase | Không |

Viết API bằng Angular hoặc nhét SQL vào component = sai source of truth.

## Ánh xạ slide (NgModule) → production (standalone)

Slide dạy Module vì Angular 2–13. Angular 21 + TinyBigCorp bắt buộc **standalone**. Cùng OOP, khác cú pháp:

| Slide / sách (cũ) | Velura |
|---|---|
| `AppModule` / feature `NgModule` | `app.config.ts` + `app.routes.ts` |
| `declarations: [ListComponent]` | `standalone: true` |
| `providers` trong module | `providedIn: 'root'` hoặc `inject()` |
| `HttpClientModule` | `provideHttpClient(withInterceptors([...]))` |
| `*ngIf` / `*ngFor` | `@if` / `@for` |
| `[(ngModel)]` | Reactive forms + Signals trên page |
| Service HTTP, component subscribe | Service = Model; Component = ViewModel (`signal` / `computed`) |

Quyết định: [adr/0001-angular-21-standalone-signals.md](./adr/0001-angular-21-standalone-signals.md).

## API JavaScript vẫn đúng kiến trúc

```
router (HTTP) → service (luật, RBAC, expectedVersion) → repository (Supabase)
```

Ví dụ: `apps/api/src/products/product-router.js` → `product-service.js` → `product-repository.js`.

Angular không import repository. Chỉ DTO JSON qua `ApiService` / `AdminApiService`.

TypeScript cho API = cải tiến sau (ADR mới), không phải điều kiện “đúng Angular”.

## SDLC (bắt buộc)

1. Jira Task dưới KAN-4 hoặc KAN-5
2. Branch từ **`develop`**: `feature/KAN-n-short-name`
3. Code theo [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md)
4. MR **vào develop**, title `KAN-n …` — MR là log phiên bản
5. CI: validate + `test:api` + `test:angular` + build + **note:mr** (không `allow_failure`)
6. Merge `develop` → staging verify (cùng VM, Host `staging.*`)
7. MR `develop` → `main` → production
8. Jira Close + comment URL MR

Chi tiết: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). Gap: [COMPLIANCE.md](./COMPLIANCE.md).

## Team clone hôm nay

`main` chưa có file này. Xem bảng trạng thái trong [AGENTS.md](../AGENTS.md) và [README.md](../README.md). Checkout `feature/KAN-13-team-onboarding` cho đến khi lead merge vào `develop`.
