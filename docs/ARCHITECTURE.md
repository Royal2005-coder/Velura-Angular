# Kiến trúc dự án + cây thư mục + role map (Velura)

**Đọc sau** [GIT-AND-CI.md](./GIT-AND-CI.md) và **trước** khi sửa code theo ticket Jira `KAN-n`.  
Mục tiêu: mỗi thành viên biết **layer nào**, **folder nào**, **file loại nào** thuộc role của mình — không phá MVVM / Clean Architecture đã dựng.

Chuẩn Angular chi tiết: [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md)  
Hợp đồng admin module: [COMPLIANCE.md](./COMPLIANCE.md)  
Pipeline: [HOW-IT-WORKS.md](./HOW-IT-WORKS.md)

---

## 1. Toàn cảnh hệ thống

```
                    ┌─────────────────────────────────────┐
  Browser           │  apps/user-ng     apps/admin-ng     │  Angular 21 SPA
  (HTML/CSS/TS)     │  View → ViewModel → Model (HTTP)    │  Signals + standalone
                    └──────────────┬──────────────────────┘
                                   │ HTTPS JSON
                    ┌──────────────▼──────────────────────┐
  Node API          │  apps/api                            │
  (TypeScript)      │  Router → Service → Repository       │
                    └──────────────┬──────────────────────┘
                                   │ Supabase client / RPC
                    ┌──────────────▼──────────────────────┐
  PostgreSQL        │  database/migrations (SQL + RPC)     │
  (Supabase)        │  RLS · security-definer functions    │
                    └─────────────────────────────────────┘

  CI/CD             .github/workflows/ci.yml  →  deploy/ (nginx, systemd) → VPS
```

| Runtime | Port local | Production |
|---|---|---|
| Storefront `user-ng` | `:4002` | https://velura.royalai.dev/ |
| Admin `admin-ng` | `:4001` | https://admin.royalai.dev/ |
| API `apps/api` | `:8787` | https://velura.royalai.dev/api/ |

**Không** viết HTTP API bằng Angular. **Không** gọi Supabase service-role từ browser.

---

## 2. Cây dự án (ổn định)

```
Velura-Angular/
├── AGENTS.md                 # Hợp đồng agent / Context as Code
├── README.md
├── package.json              # Workspaces: admin-ng, user-ng, api
├── .env.example              # Mẫu env — không commit .env
├── .github/
│   ├── workflows/ci.yml      # GitHub Actions (canonical)
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── .gitlab-ci.yml            # LEGACY — team không dùng
├── apps/
│   ├── user-ng/              # Storefront Angular (KAN-4)
│   ├── admin-ng/             # Admin Angular (KAN-5)
│   └── api/                  # Node TypeScript API
├── database/
│   ├── migrations/           # SQL tuần tự 001…024… (schema + RPC)
│   ├── seed/                 # Seed có chủ đích
│   └── database_user/        # Schema tham chiếu
├── deploy/
│   ├── nginx/                # velura.conf
│   ├── systemd/              # velura-api.service
│   └── scripts/              # bootstrap VPS, git-notes, …
├── tests/
│   └── api/                  # Unit/integration API (Node test runner)
├── docs/                     # Map ổn định (file này, GIT-AND-CI, …)
├── packages/                 # Shared packages (nếu có)
└── scripts/                  # Tooling repo
```

### 2.1 Frontend app (cùng hình cho `user-ng` và `admin-ng`)

```
apps/<app>/src/app/
├── app.ts / app.html / app.routes.ts / app.config.ts
├── theme/                    # Design tokens (colors.ts, typography.scss, icons)
├── core/                     # Model + auth + HTTP interceptors / guards
│   └── *.service.ts          # ApiService / AdminApiService — CHỈ nơi HttpClient
├── layout/                   # Shell (nav, sidebar)
├── shared/                   # Dumb / presentational (pagination, empty state, …)
└── features/<name>/          # Một use-case / màn hình
    ├── <name>.page.ts        # ViewModel (signals, computed, events)
    ├── <name>.page.html      # View (HTML) — không .filter/.map trong template
    ├── <name>.page.scss      # CSS variables / tokens — không hardcode #hex mới
    └── <name>.page.spec.ts   # Test ViewModel — mock Model, không gọi mạng
```

Admin features hiện có (ví dụ): `catalog`, `orders`, `accounts`, `pricing`, `promotions`, `reviews`, `returns`, `logs`, `dashboard`, `login`, …

### 2.2 Backend API — OOP layers

```
apps/api/src/
├── server.ts                 # Bootstrap HTTP — wire routers
├── types.ts                  # DTO / hợp đồng dùng chung
├── rbac.ts                   # Quyền theo role → allowedPages
├── http.ts / auth-*.ts       # Cross-cutting (parse, session, lockout)
├── supabase.ts               # Client DB
└── <domain>/                 # products | orders | accounts | …
    ├── <domain>-router.ts      # Interface: parse Request → DTO → gọi Service
    ├── <domain>-service.ts     # Application: rule nghiệp vụ, orchestration
    ├── <domain>-repository.ts  # Infrastructure: SQL/RPC/Supabase
    └── <domain>-constants.ts   # Hằng số domain (nếu có)
```

Ví dụ chuẩn: `products/product-router.ts` → `product-service.ts` → `product-repository.ts`.

Một số module storefront còn nằm dưới `user/` (cart, wishlist, …) — khi sửa vẫn **không** nhét business vào router kiểu “god file”; tách service/repository khi đụng KAN lớn.

### 2.3 Database

```
database/migrations/
  001_….sql … 024_….sql     # Thứ tự tăng dần — RPC, RLS, bảng
```

- Schema mới = **migration mới**, không sửa tay production ngoài script.  
- RPC `security definer` (vd. `admin_create_product`) thuộc layer DB — API repository **gọi**, không copy logic SQL vào Angular.

### 2.4 Test / CI / Deploy

| Layer | Ở đâu |
|---|---|
| Test API | `tests/api/*.test.ts` + `npm run test:api` / `typecheck:api` |
| Test Angular | `*.page.spec.ts` cạnh page + `npm run test:ng` |
| CI | `.github/workflows/ci.yml` |
| Deploy artifacts | `deploy/nginx`, `deploy/systemd` → VPS qua job `deploy-production` |

---

## 3. Phân layer OOP (map slide Angular → Velura)

Slide học thuật nói Module + Component + Service. Velura **Angular 21** dùng **standalone** (không `NgModule`) nhưng **cùng ý**:

| Slide / khái niệm | Velura |
|---|---|
| Template (HTML) | `*.page.html` = **View** |
| Component class (TS) | `*.page.ts` = **ViewModel** (signals) |
| Service | `core/*service.ts` = **Model** (HTTP) |
| Styles | `*.page.scss` + `theme/` |
| Backend “API lớp” | Router → Service → Repository |

```
[HTML View]
    triggers event
[TS ViewModel — signals / computed]
    calls
[TS Model — injectable service]
    HttpClient
[API Router] → [API Service] → [API Repository] → [SQL/RPC]
```

**SRP:** một class một trách nhiệm. Router không chứa rule giá; Service không viết SQL thô dài; Page không gọi `HttpClient`.

---

## 4. Role → việc → chỗ sửa code

Lead ghi tên vào bảng team trong [ONBOARDING.md](./ONBOARDING.md). Mỗi người **ưu tiên folder của mình**; đụng contract (DTO/API) thì hai team review.

### 4.1 Storefront (Frontend user) — Epic KAN-4

| Làm gì | Ở đâu |
|---|---|
| Màn hình shop, cart, checkout UI, wishlist, blog UI, … | `apps/user-ng/src/app/features/**` |
| HTML / SCSS màn đó | `*.page.html`, `*.page.scss` |
| State UI (signals) | `*.page.ts` |
| Gọi API | `apps/user-ng/src/app/core/**` (`ApiService`, …) — **không** HTTP trong page |
| Token màu / icon | `apps/user-ng/src/app/theme/**` |
| Test UI | `*.page.spec.ts` (mock Model) |
| **Không** | Sửa `apps/api` schema lớn một mình; không deploy secrets; không PR vào `main` |

### 4.2 Admin (Frontend admin) — Epic KAN-5

| Làm gì | Ở đâu |
|---|---|
| CMS admin: products, orders, accounts, pricing, … | `apps/admin-ng/src/app/features/**` |
| Shell / nav | `apps/admin-ng/src/app/layout/**` |
| Session / RBAC UI / HTTP admin | `apps/admin-ng/src/app/core/**` |
| Shared UI (pagination, empty) | `apps/admin-ng/src/app/shared/**` |
| Test | `*.page.spec.ts` |
| Hợp đồng 8 điểm / màn | [COMPLIANCE.md](./COMPLIANCE.md) |

### 4.3 Backend API (Node) — thường gắn Admin / Lead khi đụng contract

| Làm gì | Ở đâu |
|---|---|
| Endpoint mới / đổi DTO | `*-router.ts` + `types.ts` |
| Rule nghiệp vụ, audit label, validation | `*-service.ts` |
| Supabase query / RPC | `*-repository.ts` |
| RBAC server | `rbac.ts`, `auth-*.ts` |
| Test | `tests/api/*.test.ts` |
| **Không** | Logic nghiệp vụ trong `server.ts` bloat; không `@ts-nocheck`; không `any` |

### 4.4 Database / RPC / function

| Làm gì | Ở đâu |
|---|---|
| Bảng, index, RLS, RPC | `database/migrations/0xx_….sql` (số mới) |
| Seed | `database/seed/` |
| **Không** | Sửa DB production bằng tay trên dashboard rồi quên migration |

Thứ tự feature có DB: **migration → repository/API → Angular Model → page**.

### 4.5 HTML / CSS (trong Angular)

| Làm gì | Ở đâu |
|---|---|
| Markup semantic, a11y cơ bản | `*.page.html` / layout html |
| Style theo token | `theme/` + `*.page.scss` |
| **Không** | Inline style loạn; hex cứng trong SCSS mới; logic `@if` phức tạp thay cho `computed` |

### 4.6 TypeScript (cả FE + API)

| FE | API |
|---|---|
| Signals, `inject()`, JSDoc public API | Class/function typed, DTO trong `types.ts` |
| Cấm `any` | Cấm `any` / `@ts-nocheck` |

### 4.7 Test

| Role | Chạy trước khi push |
|---|---|
| FE | `npm run test:ng` (hoặc test workspace app mình) |
| API | `npm run typecheck:api && npm run test:api` |
| Trước promote | Cả hai + `npm run build` |

CI chạy cùng lệnh — local đỏ thì đừng mở PR “để CI xem”.

### 4.8 CI/CD + Deploy (Lead)

| Làm gì | Ở đâu |
|---|---|
| Workflow | `.github/workflows/ci.yml` |
| Docs vận hành | `docs/GIT-AND-CI.md`, `docs/HOW-IT-WORKS.md` |
| Nginx / systemd | `deploy/` |
| Secrets | GitHub Environment **production** (không phải Deploy keys) |
| Promote | PR `develop` → `main` sau khi integration ổn |

Dev thường **không** cần SSH secrets để code.

---

## 5. Ticket KAN → chỗ đụng code (cách đọc)

1. Mở Jira `KAN-n` — đọc acceptance / epic (KAN-4 storefront vs KAN-5 admin).  
2. `git log --oneline --grep=KAN-n` + `git show --stat` — xem version cũ đụng file nào.  
3. Phân loại thay đổi:

| Nếu ticket nói… | Layer ưu tiên |
|---|---|
| “Thêm cột / nút trên trang X” | FE: `features/.../*.page.html` + `.ts` (+ `.scss`) |
| “Gọi API / lỗi 403 / DTO” | Model FE `core/*` **và/hoặc** API `*-router/service` |
| “Lưu DB / RPC / RLS” | `database/migrations` → `*-repository` |
| “Phân quyền role” | `rbac.ts` + session FE + có thể migration |
| “Test thiếu” | `*.page.spec.ts` hoặc `tests/api` |
| “Deploy / nginx / CI” | `deploy/`, `.github/` — Lead |

4. Một PR có thể đụng nhiều layer — **mô tả rõ trong `## Why` / `## What`**: FE / API / DB.  
5. Không tạo `docs/KAN-n.md`.

### Ví dụ nhanh

| Ví dụ | Files điển hình |
|---|---|
| ADM-PRD: tạo SP + audit | `admin-ng/.../catalog/*`, `api/products/*`, migration RPC nếu thiếu |
| Cart storefront | `user-ng/.../features/cart/*`, `api/user/cart.ts` (hoặc service tách) |
| Dashboard KPI | `admin-ng/.../dashboard/*`, `api/dashboard*.ts`, migration OLAP nếu có |

---

## 6. Checklist trước khi mở PR feature

- [ ] Biết epic (KAN-4 / KAN-5) và folder mình được phép sửa chính  
- [ ] Đã xác định layer: View / ViewModel / Model / Router / Service / Repository / SQL  
- [ ] Không để `HttpClient` trong page; không SQL trong Angular  
- [ ] Có test tương ứng layer (page spec và/hoặc `tests/api`)  
- [ ] Title `KAN-n` + body `## Why`  
- [ ] Đã đọc [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md) nếu đụng UI  

---

## 7. Liên kết nhanh

| Nhu cầu | Doc |
|---|---|
| Git + Actions gate | [GIT-AND-CI.md](./GIT-AND-CI.md) |
| Ngày 1 | [ONBOARDING.md](./ONBOARDING.md) |
| Angular MVVM chi tiết | [ANGULAR-STANDARDS.md](./ANGULAR-STANDARDS.md) |
| Admin 8 điểm | [COMPLIANCE.md](./COMPLIANCE.md) |
| Slide ↔ repo | [SOURCE-OF-TRUTH.md](./SOURCE-OF-TRUTH.md) |
