# Source of truth (Velura)

Đây là **nguồn sự thật** của workspace. Agent và người mới đọc `AGENTS.md` → `README.md` → file này, rồi mới mở code.

Hai tài liệu gốc (học thuật, không copy nguyên cuốn sách có bản quyền vào Git):

| Gốc | Vai trò | File map trong repo |
|---|---|---|
| Slide UEL *Angular Framework* (Phúc NQ) | Kiến trúc SPA: App → Module → Component → Service → HTTP | [source-of-truth/LECTURE-MAP.md](./source-of-truth/LECTURE-MAP.md) |
| *Angular 2+ Notes for Professionals* (GoalKicker) | Chi tiết professional: DI, interceptor, forms, routing, testing | [source-of-truth/BOOK-MAP.md](./source-of-truth/BOOK-MAP.md) |
| TinyBigCorp `AGENTS.md` | SOLID, MVVM + Signals, Clean Architecture | Áp dụng **frontend** nguyên văn. Backend production Velura = Node (xem ADR 0002) |

## Angular không phải toàn bộ hệ thống

Angular = **SPA TypeScript trên browser** (`apps/user-ng`, `apps/admin-ng`).

Slide và sách đều nói: Angular là front-end SPA. Sách GoalKicker **Chapter 1.1** còn hướng dẫn Angular + **Node/Express backend**. API không viết bằng Angular.

| Tầng | Công nghệ Velura | Có phải Angular? |
|---|---|---|
| Storefront / Admin UI | Angular 21 standalone + Signals + TypeScript | Có |
| HTTP API | Node, `apps/api/**/*.js`, router → service → repository | Không — và **đúng** |
| Test API | `tests/api/*.test.js` (Node test runner) | Không — test đúng ngôn ngữ API |
| Test UI | `*.spec.ts` (Jasmine/Karma/Vitest Angular) | Có — đang mỏng, phải bổ sung theo book ch. 2.3 / 23.3 |
| DB | PostgreSQL / Supabase | Không |

Viết API bằng Angular hoặc nhét SQL vào component là **sai** source of truth.

## Ánh xạ slide (NgModule) → production (standalone)

Slide dạy Module vì đó là mô hình Angular 2–13. TinyBigCorp và Angular 21 bắt buộc **standalone**. Cùng OOP, khác cú pháp:

| Slide / sách (cũ) | Velura (đúng production) |
|---|---|
| `AppModule` / feature `NgModule` | `app.config.ts` + `app.routes.ts` |
| `declarations: [ListComponent]` | `standalone: true` (mặc định CLI 21) |
| `providers: [ProductService]` trong module | `providedIn: 'root'` hoặc `inject()` |
| `HttpClientModule` | `provideHttpClient(withInterceptors([...]))` |
| `*ngIf` / `*ngFor` | `@if` / `@for` (cùng ý structural directive) |
| `[(ngModel)]` | Reactive forms + Signals trên page |
| Service gọi HTTP, component subscribe | Service = Model; Component = ViewModel (`signal` / `computed`) |

Quyết định ghi ở [adr/0001-angular-21-standalone-signals.md](./adr/0001-angular-21-standalone-signals.md).

## OOP trên API (JavaScript) vẫn professional

`apps/api` không “thuần Angular” vì **không được**. Nó tuân Clean Architecture bằng JS:

```
router (parse HTTP) → service (luật, RBAC, expectedVersion) → repository (Supabase)
```

Ví dụ: `apps/api/src/products/product-router.js` → `product-service.js` → `product-repository.js`.

Không import repository vào Angular. Angular chỉ nói chuyện với DTO JSON qua `ApiService` / `AdminApiService`.

TypeScript cho API là **cải tiến sau** (ADR riêng), không phải điều kiện “đúng Angular”.

## Thứ tự làm việc (SDLC)

1. Jira Task dưới KAN-4 hoặc KAN-5
2. Branch từ `develop`: `feature/KAN-n-short-name`
3. Code theo [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md)
4. MR **vào develop**, title `KAN-n …` — **MR là log** (CI note = git log + diff). Không thêm md theo ticket
5. CI: validate + `test:api` + `test:angular` + build + note:mr
6. Merge develop → staging verify
7. MR develop → main → production
8. Jira Close

Chi tiết: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

## Gap (làm tiếp, không giả vờ xong)

Xem [COMPLIANCE.md](./COMPLIANCE.md).
