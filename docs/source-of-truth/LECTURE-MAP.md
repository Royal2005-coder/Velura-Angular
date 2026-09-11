# Lecture map — Angular Framework (UEL)

Nguồn: slide *Phát triển web kinh doanh nâng cao — Angular Framework* (GV Nguyễn Quang Phúc).  
Không dán nguyên OCR slide vào Git. Agent đọc **cột Velura**.

## 1. Angular là gì

Slide: framework Google, **front-end**, SPA, TypeScript từ Angular 2.

Velura: hai SPA (`user-ng`, `admin-ng`). Không dùng AngularJS.

## 2. Kiến trúc thành phần

Slide: App → **Module** → Component + Service. User app và Admin app tách.

Velura:

| Slide | Repo |
|---|---|
| User app | `apps/user-ng` |
| Admin app | `apps/admin-ng` |
| Root module | không có — `app.config.ts` |
| Feature module | thư mục `features/<name>/` (đơn vị tổ chức, không `NgModule`) |
| Component = template + class + decorator | `*.page.ts` + `*.page.html` |
| Service = business / HTTP | `core/services/*.ts`, `admin-api.service.ts` |

## 3. Binding

Slide: property, class, style, event, two-way.

Velura: property/event binding trong template; state trên `signal()`; không logic `.filter()` trong HTML.

## 4. Directives

Slide: `ngIf`, `ngSwitch`, `ngFor`.

Velura: `@if`, `@switch`, `@for` (Angular control flow). Cùng trách nhiệm structural directive.

## 5. Component interaction

Slide: `@Input` / `@Output`, parent/child.

Velura: presentational (`product-card`, `admin-pagination`, `admin-icon`) nhận `input()` / `output()`. Page không nhúng HTTP.

## 6. Services + HTTP

Slide: `ng g s product`; HTTP trong service; interface DTO; handle error trong service; component chỉ gọi service.

Velura (bắt buộc):

- `HttpClient` chỉ trong service
- Interceptor: `auth.interceptor.ts`, `admin-auth.interceptor.ts`
- Component `inject(ApiService)` rồi gán `signal`

## 7. Routing

Slide: routes, `router-outlet`, child routes.

Velura: `app.routes.ts` dùng `loadComponent`. Guard: `auth.guard.ts`, `admin-auth.guard.ts`.

## 8. CLI

Slide: `ng g c`, `ng g s`.

Velura: `ng generate` **trong** `apps/user-ng` hoặc `apps/admin-ng`. Standalone mặc định. Không tạo `NgModule`.
