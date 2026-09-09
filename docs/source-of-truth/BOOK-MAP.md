# Book map — Angular 2+ Notes for Professionals

Nguồn: GoalKicker *Angular 2+ Notes for Professionals* (file học thuật ngoài repo).  
**Không** commit nguyên sách (bản quyền). Agent áp dụng **cột Velura**.

| Ch. | Chủ đề sách | Làm gì trên Velura |
|---|---|---|
| 1.1 | Angular + Node/Express HTTP | Đúng mô hình: SPA Angular + `apps/api` Node |
| 1.2 / 52 | angular-cli | CLI trong từng app `user-ng` / `admin-ng` |
| 2 | Component, template, test component | Page standalone; unit test component còn thiếu — bổ sung khi đụng file |
| 3 / 8 / 51 | `@Input` `@Output` | `input()` / `output()` trên dumb components |
| 4 / 10 / 11 | Directives, ngIf, ngFor | `@if` `@for`; không `*ngFor` mới |
| 13 / 30 / 32 | Modules, feature, lazy | Thư mục feature + `loadComponent` (KAN-7) |
| 16 / 27 / 35 | Forms, validators | `ReactiveFormsModule` trên page; validate ở ViewModel |
| 17 / 18 / 48 | Routing, guards, resolvers | `app.routes.ts` + functional guards |
| 22 / 23 / 38 | HTTP, DI, CRUD REST | Service encapsulate HTTP; CRUD qua API JSON |
| 43 | Http interceptor | Đã có auth + logging |
| 21 | Lifecycle | `constructor` / `afterNextRender` khi cần; ưu tiên `signal` |
| 26 / 53 | Change detection | Signals = không đụng `ChangeDetectorRef` trừ khi có ADR |
| 49 / 66 | Protractor / unit tests | Ưu tiên unit `*.spec.ts` + API `tests/api`; E2E sau |
| 24 | Service worker / PWA | Chưa bật; cần ADR nếu làm |

Khi sách nói `NgModule` / `@NgModule.imports`: dịch sang `app.config.ts` providers và `imports: []` trên `@Component`.
