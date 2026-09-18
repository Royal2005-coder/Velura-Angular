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
| API TypeScript an toàn | `apps/api` `strict` + `noImplicitAny`; không `@ts-nocheck`; không `any` |
| Tests Angular trên CI | `test:angular` → `ng test --watch=false` |
| Page ViewModel specs | `*.page.spec.ts` cạnh page; mock Model, không gọi mạng |
| Lazy routes | `loadComponent` trong `apps/admin-ng` và `apps/user-ng` `app.routes.ts` |
| Admin đổi mật khẩu | `POST /api/auth/change-password`; không stub local |
| Pipeline Jira key | branch/PR `KAN-n`; feature → develop → main |
| Trace version | `git log --show-notes --grep=KAN-n` + PR `## Why` + CI `pr-trace.md` |
| CODEOWNERS | `.github/CODEOWNERS` |

## Cố ý không làm (không phải thiếu)

| Ý tưởng sai | Lý do |
|---|---|
| Viết API bằng Angular | Angular không chạy server HTTP production của Velura |
| Đổi `apps/api` sang Python FastAPI ngay | TinyBigCorp academic stack; Velura đang live Node + Supabase. Xem [ADR 0002](./adr/0002-node-api-javascript.md) |
| Đưa NgModule trở lại “cho giống slide” | Trái Angular 21 + TinyBigCorp |
| Đợi API TypeScript rồi mới test page | Page test mock `ApiService`. API đã TypeScript trên Node ([ADR 0003](./adr/0003-node-api-typescript.md)) |

## Admin module map (Vendure IA → Velura)

Không lắp Vendure/Medusa/Strapi. `apps/api` `rbac.ts` `rolePages` là canonical. Admin Angular Vendure đã deprecated; đây chỉ là catalog phân hệ.

| Phân hệ chuẩn | Velura `admin-ng` | API | Ghi chú |
|---|---|---|---|
| Catalog | `/products` | `/api/v1/admin/products` | CRUD, variant, tồn kho, CSV |
| Orders | `/orders` | `/api/v1/admin/orders` | Máy trạng thái + đối soát thanh toán |
| Customers / Staff | `/accounts` | `/api/v1/admin/accounts` | List server-paged; tách IA hoãn |
| Marketing | `/pricing`, `/promotions` | `/api/v1/admin/pricing`, `promotions`, `vouchers` | Giá tách khỏi catalog (đúng contract API) |
| Reviews | `/reviews` | `/api/v1/admin/reviews` | Thế mạnh Velura |
| Returns / CSKH | `/returns` | `/api/v1/admin/returns`, chat-sessions | Thế mạnh Velura |
| Audit | `/logs` + tab mỗi module | `/api/v1/admin/*audit-logs` | Nhật ký theo phân hệ |
| Content / Settings | — | `/api/content/*` (public read) | Hoãn: không phải lỗ của 9 trang hiện tại |

## Hợp đồng mỗi module admin (8 điểm)

1. **List:** filter + phân trang server (`limit`/`offset`); signal `loading` / `loadError` / empty riêng.
2. **Detail:** drawer hoặc modal — đủ entity (variant, dòng đơn, lịch sử).
3. **Mutation:** DTO + `expectedVersion`; API `requirePermission`; UI ẩn nút ghi nếu role không được ghi (`AdminSessionService.canMutate`).
4. **Audit:** tab nhật ký của module đó.
5. **RBAC một nguồn:** `allowedPages` từ `/api/auth/me`. Frontend không nhân bản `rolePages`.
6. **MVVM:** ViewModel = page signals; HTTP chỉ `AdminApiService`; không filter trong template.
7. **Lazy route:** `loadComponent` trong `apps/admin-ng` và `apps/user-ng` `app.routes.ts`.
8. **Test:** empty / error / filter trên `*.page.spec.ts`; mock Model, không gọi mạng.

## Gap (ticket / MR tiếp)

| Gap | Việc | Jira |
|---|---|---|
| Empty/error UI storefront | cart, wishlist, checkout | [KAN-8](https://webadvance.atlassian.net/browse/KAN-8) |
| Pricing derived filters | `discount` / `invalid` / `missing` vẫn lọc trên trang hiện tại — API giá không có các status đó | KAN-4 |
| Log KPI kết quả | success/fail/blocked/security đếm trên trang hiện tại — API audit không filter theo kết quả | KAN-4 |
| Chat CSKH sidebar | list cap 50 (API max 100); filter `handoffStatus` server-side | Đã làm |
| CSKH KPI ưu tiên cao | API ticket không filter `priority`; hiện = phiếu đổi/trả pending + ticket `open` | KAN-5 |
| Tách Customers vs Staff | một trang `/accounts` | Hoãn có chủ đích |
| GitLab MCP 404 (legacy) | Team dùng GitHub; GitLab archive | [KAN-11](https://webadvance.atlassian.net/browse/KAN-11) |
| Admin CMS write / media / store settings | editor blog/policy/page, media library, shipping/tax | Hoãn có chủ đích |
| Cổng thanh toán MoMo/VNPay | checkout chỉ ghi nhãn; chưa create-intent + HMAC IPN | Hoãn (cần khóa merchant) |
| SMS OTP provider | local OTP shortcut chỉ khi `NODE_ENV !== production` | Hoãn (cần nhà mạng) |
| Biểu đồ doanh thu | dashboard dùng RPC thật; cột CSS, chưa chart lib | Hoãn |
