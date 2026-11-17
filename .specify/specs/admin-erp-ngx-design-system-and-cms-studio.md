# Specification: Velura Admin ERP Design System Overhaul & Interactive CMS Studio (`KAN-116`)

## 0. Design Read & Taste Calibration (`design-taste-frontend` + `ngx-admin`)

> **Design Read:** *"Reading this as: an enterprise e-commerce operations console & editorial CMS studio (`apps/admin-erp-ng` + Storefront CMS consumers) for daily Vietnamese retail operators and merchandisers, with a crisp CoreUI / `akveo/ngx-admin` structural language in Velura's signature Velvet Rose & Slate palette, leaning toward high-legibility `Be Vietnam Pro` + `JetBrains Mono` tabular typography, tactile zero-code visual controls, and predictable single-CTA hierarchy."*

- **`DESIGN_VARIANCE: 3`** — Symmetric `ngx-admin` workspace anatomy (`Page Header` → `KPI Strip` → `Unified Panel [Header + View Switcher + Subtabs → Filter Band → Data Table / Card Grid → Pagination]`), predictable operator action placement.
- **`MOTION_INTENSITY: 3`** — Crisp `120ms–160ms` transform/opacity feedback, tactile `-1px` active press, zero looping decorative animations, `prefers-reduced-motion` respected.
- **`VISUAL_DENSITY: 6`** — Balanced daily-operations density: generous breathing room in modals/forms, compact scannable tables with sticky headers and tabular numerals.

---

## 1. Problem Statement & Visual Evidence

Audit of live production (`admin-erp.royalai.dev` and `velura.royalai.dev`) and operator screenshots revealed five concrete UX/UI defects:

1. **Cover & Banner Images Chop Off Models' Heads (`media_1794939241092_40858363.jpg`)**:
   - Uploading a cover image (`banner_url` in Collections or `media_url`/`poster_url` in Banners) provides no drag-to-pan (`kéo lên kéo xuống, qua trái qua phải`) or zoom/crop (`cắt ra cắt vô`) adjustment.
   - Admin preview used `16:9` while Storefront `.collection-hero` renders at panoramic `~3:1` (`clamp(260px, 32vw, 400px)`) with `object-fit: cover; object-position: center` (`50% 50%`), severing all 5 models' heads at the chin on `Midnight Mirage`.
   - Similarly, `product-list.page.html` hardcoded inline `style="object-fit: cover; object-position: center;"` overriding editorial framing.
2. **`Thẻ | Bảng` View Toggle & Search Filter Broken on Banner & Collection Tabs (`media_1794939358193_15604715.jpg`)**:
   - Operators expect `Thẻ | Bảng` and search filtering to work on `Quản lý Banner` and `Bộ sưu tập & Lookbook` just like `Bài viết`, allowing rapid tabular inspection, sorting order verification, and one-click toggle/edit/delete.
3. **Redundant Persistent Inline Notice (`"Đã cập nhật bộ sưu tập thành công."`) & Raw Browser `confirm()` (`media_1794939358193_15604715.jpg`)**:
   - `AdminErpContentPage` wrote mutation confirmations into `this.notice`, rendering a permanent blue `.content-banner--info` across tab switches instead of transient toasts via `AdminErpToastService`, and used blocking `window.confirm()` instead of `AdminErpConfirmService`.
4. **Confusing Raw CSS Gradient Input, Manual Slug Friction & Clipped Meta Fields (`media_1794939482063_20342c80.png`)**:
   - Exposing `linear-gradient(115deg, #716C6B 0%, #A79B95 48%, #5D5657 100%)` directly confuses merchandisers.
   - Collection `code` (slug) required manual entry on create and showed a bulky disabled input on edit; Blog `slug` required clicking `"Lấy từ tiêu đề"` manually.
   - `.content-form__grid--meta` used `repeat(4, minmax(0, 1fr))` for a 3-field row in Collection modal, clipping `COLLECTION 04 · AFTER-HOURS MUSE` into `COLLECTION 04 · AFTER-HOURS MU`.
5. **System-Wide Admin ERP Token, Font & Button Hierarchy Drift (`styles.scss`, `dashboard.css`, `shared/ui/*`, `layout/*`)**:
   - `styles-velura/dashboard.css` injected `'Inter'` ahead of `'Be Vietnam Pro'` in `:root`, degrading Vietnamese diacritics and violating `docs/ADMIN-DESIGN-SYSTEM.md` §3.
   - Missing `:root` CSS variables (`--erp-font-mono`, `--erp-brand`, `--erp-danger-line`, `--erp-success-line`, `--erp-info-line`, `--erp-control-border`, `--erp-rose`).
   - `.sidebar__brand` (`60px`) and `.topbar` (`52px`) misaligned the header divider by `8px`.
   - `app-erp-status-badge` lacked `flex-shrink: 0`, squishing `Đang bật` into `• Đ.` and `• Đang ...` inside flex rows.
   - Secondary `.erp-btn` colored all neutral buttons magenta (`var(--erp-accent)`), while card actions placed solid `#BE185D` (`Sửa`) next to solid `#E11D48` (`Xóa`), making primary edit and destructive delete visually indistinguishable.
   - Form inputs used `1px solid #E2E8F0` on `#FFFFFF` (1.22:1 contrast, below WCAG AA non-text contrast).

---

## 2. Functional Requirements

### FR-1: Interactive Focal-Point & Zoom Cropper (`<app-erp-image-cropper>`) & End-to-End Framing Persistence
- **FR-1.1 Component (`apps/admin-erp-ng/src/app/shared/ui/admin-image-cropper.ts`)**:
  - Standalone Signal component accepting:
    - `src: string` (resolved image URL)
    - `aspectRatio: string` (e.g. `'3 / 1'` for Collection panoramic hero, `'3.5 / 1'` for Product hero banner, `'16 / 9'` for standard cards)
    - `posX: number` (`0`–`100`, horizontal focal percentage)
    - `posY: number` (`0`–`100`, vertical focal percentage)
    - `zoom: number` (`1`–`2.4`, step `0.05`, scale multiplier)
    - `defaultPosY: number` (default `16` for fashion lookbooks, `28` for banners)
    - `hint: string` (optional contextual guidance)
  - Emits `framingChange` with `{ posX: number; posY: number; zoom: number }`.
  - **Pointer Panning (`kéo lên kéo xuống, qua trái qua phải`)**:
    - Supports mouse & touch via Pointer Events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel` with `setPointerCapture`).
    - Dragging pulls the image naturally behind the frame (`nextX = clamp(round(startX - (dx / width) * (100 / zoom) * 1.35), 0, 100)`, `nextY = clamp(round(startY - (dy / height) * (100 / zoom) * 1.35), 0, 100)`).
    - Displays a subtle rule-of-thirds composition grid overlay (`3×3`) and live coordinate badge (`X: 50% · Y: 16% · 115%`) while dragging or hovering.
  - **Zoom / Crop Controls (`cắt ra cắt vô`) & Presets**:
    - Range slider (`100%`–`240%`, step `5%`) with `−` / `+` step buttons.
    - Quick framing preset buttons: `Ưu tiên đầu mẫu` (`50%, 14%`), `1/3 trên` (`50%, 28%`), `Chính giữa` (`50%, 50%`), `Chân ảnh` (`50%, 82%`), and `Đặt lại` (`50%, defaultPosY, 1.0x`).
    - Keyboard accessibility on the viewport (`ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight` nudge by `2%`, `+`/`-` adjust zoom by `0.05`).
- **FR-1.2 CSS Rendering Contract (1:1 Parity Across Admin & Storefront)**:
  - Any framed image applies:
    - `object-fit: cover`
    - `object-position: ${posX}% ${posY}%`
    - `transform-origin: ${posX}% ${posY}%`
    - `transform: zoom > 1.001 ? scale(${zoom}) : none`
- **FR-1.3 Zero-Migration JSONB Persistence & API Validation**:
  - **Collections (`public.collections.styling_metadata`)**:
    - Keys: `cover_x` (`0..100`, integer/float rounded to 1 decimal), `cover_y` (`0..100`), `cover_zoom` (`1..2.4`).
    - `apps/api/src/collections/collection-service.ts` validates and sanitizes `styling_metadata` when provided (rejecting non-object payloads with `400 FIELD_INVALID`, clamping/validating numeric focal keys, and merging with existing `styling_metadata` on `updateCollection` so other styling keys are never lost).
    - `apps/user-ng/src/app/core/models/collection-lookbook.ts` normalizes `coverX` (default `50`), `coverY` (default `16` — top-weighted fashion framing so existing covers like `Midnight Mirage` immediately preserve models' heads!), and `coverZoom` (default `1`).
    - `apps/user-ng/src/app/features/collections/collections.page.{ts,html}` and `_collections.css` bind `.collection-hero__cover` to `coverX`, `coverY`, `coverZoom` (with CSS fallback `object-position: 50% 16%`).
  - **Banners (`public.banners.metadata`)**:
    - Keys: `focal_x` (`0..100`), `focal_y` (`0..100`), `focal_zoom` (`1..2.4`), alongside existing `autoplay` (`boolean`) and `sound_default` (`boolean`).
    - `apps/api/src/banners/banner-service.ts` validates and sanitizes `metadata` when provided (preserving existing `metadata` keys on partial updates).
    - `apps/user-ng/src/app/core/models/banner.interface.ts` types `focal_x?: number`, `focal_y?: number`, `focal_zoom?: number` on `BannerSummary['metadata']`.
    - `apps/user-ng/src/app/features/products/product-list.page.{ts,html}` removes hardcoded `style="object-fit: cover; object-position: center;"` and binds hero `<img>` (and `<video>` `object-position` when configured) using `focal_x ?? 50`, `focal_y ?? 28`, `focal_zoom ?? 1`.
  - **Admin ERP Cards & Previews**:
    - Banner cards (`.cms-card__media > img`) and Collection cover cards render with the exact saved `object-position` and `transform`!

### FR-2: Working `Thẻ | Bảng` Dual View & Contextual Search on All CMS Tabs
- **FR-2.1 View Mode Toggle (`Thẻ` / `Bảng`)**:
  - Visible on all visual/editorial tabs: `all`, `draft`, `published`, `archived`, `banners`, and `collections` (hidden only on `subscribers`, which is strictly tabular).
  - Styled as a clean `ngx-admin` segmented control (`.erp-segmented`).
  - On `banners`:
    - `viewMode() === 'cards'` renders the 3-column visual banner card grid.
    - `viewMode() === 'table'` renders `<app-erp-data-table>` with `bannerColumns` (`Banner` with `16:9` thumb + title, `Định dạng` badge `VIDEO`/`ẢNH`, `Nhãn kicker`, `Liên kết CTA`, `Thứ tự` mono right-aligned, `Trạng thái` `Đang bật`/`Tắt`) and `rowActions` (`Bật`/`Tắt`, `Sửa`, `Xóa`), plus row click opening `openEditBanner`.
  - On `collections`:
    - `viewMode() === 'cards'` renders the visual collection lookbook card grid.
    - `viewMode() === 'table'` renders `<app-erp-data-table>` with `collectionColumns` (`Bộ sưu tập` with `16:9` cover/first-model thumb + name, `Mã slug` mono, `Chế độ Hero` badge, `Trang chủ` slot label, `Combo/Set` count mono right-aligned, `Thứ tự` mono right-aligned, `Trạng thái` `Đang bật`/`Tắt`) and `rowActions` (`Bật`/`Tắt`, `Sửa`, `Xóa`), plus row click opening `openEditCollection`.
- **FR-2.2 Contextual Search Filter Bar (`<app-erp-filter-bar>`)**:
  - Displayed across all 7 tabs with tab-aware field label & placeholder:
    - Blogs (`all`/`draft`/`published`/`archived`): `Tìm bài viết` — `Tiêu đề hoặc slug (VD: áo lụa)…` (server-side `q`).
    - Banners (`banners`): `Tìm nhanh banner` — `Tiêu đề, nhãn tag hoặc đường dẫn CTA…` (client-side instant filter over `banners()`, since banners list is unpaginated).
    - Collections (`collections`): `Tìm bộ sưu tập` — `Tên bộ sưu tập, mã slug hoặc kỳ phát hành…` (client-side instant filter over `collectionsList()`, unpaginated).
    - Subscribers (`subscribers`): `Tìm người nhận tin` — `Địa chỉ email hoặc nguồn đăng ký…` (client-side filter over loaded rows or server query).
  - Blog & Subscriber tabs keep `<app-erp-pagination>`; `banners` and `collections` remain unpaginated (`showPagination()` false on `banners` & `collections`).

### FR-3: Toast-Only Write Feedback & Unified Confirmation Dialogs
- **FR-3.1 Eliminate Persistent `notice()` Banner**:
  - Remove `<div class="content-banner content-banner--info" role="status">{{ notice() }}</div>` from the workspace panel in `admin-erp-content.page.html`.
  - Inject `AdminErpToastService` in `AdminErpContentPage`:
    - `saveBanner`, `deleteBanner`, `toggleBannerActive`, `saveCollection`, `deleteCollection`, `toggleCollectionActive`, and `save` (blog) call `this.toast.success(...)` on success and `this.toast.error(...)` on non-field failure (when modal is closed).
    - Keep contextual inline error/conflict messages inside open modals (`bannerError()`, `collectionError()`, `conflict()`).
- **FR-3.2 Replace Raw `window.confirm()`**:
  - Inject `AdminErpConfirmService` in `AdminErpContentPage`.
  - `deleteBanner` and `deleteCollection` open `this.confirmSvc.ask({ title, message, confirmLabel: 'Xóa banner' | 'Xóa bộ sưu tập', tone: 'danger' })` instead of native `confirm()`.

### FR-4: Visual Gradient Studio, Effortless Auto-Slug UX & Balanced Modal Grids
- **FR-4.1 Visual Gradient Picker (`<app-erp-gradient-picker>`)**:
  - Standalone Signal component in `apps/admin-erp-ng/src/app/shared/ui/admin-gradient-picker.ts`.
  - Displays 8 curated Velura editorial swatches (`Pastel Soft`, `Urban Taupe`, `Sage Mist`, `Midnight Slate`, `Rose Afterglow`, `Velvet Wine`, `Champagne Silk`, ` Pearl Minimal`) as visual swatch tiles with active checkmark ring.
  - Provides 3 native color pickers (`Màu đầu`, `Màu chuyển`, `Màu cuối`) + 4 direction pills (`Chéo 115°`, `Ngang 90°`, `Chéo sâu 135°`, `Dọc 180°`) that parse any standard 2- or 3-stop hex `linear-gradient(...)` and synthesize a valid `linear-gradient(${angle}deg, ${c1} 0%, ${c2} 48%, ${c3} 100%)` string in real time.
  - Raw CSS text input is hidden by default behind a subtle `"Tùy chỉnh CSS nâng cao"` toggle so non-technical users never face raw code unless they ask for it.
  - When `hero_mode === 'cover'`, the gradient section collapses into a compact secondary note (`"Đang dùng Ảnh bìa — màu nền chỉ dùng làm lớp lót khi tải ảnh"`) expandable on click.
- **FR-4.2 Automatic Slug / Code Generation**:
  - **Collection Modal**:
    - On **Create**: typing `Tên bộ sưu tập` (`Soft Ceremony`) automatically generates `code` (`soft-ceremony`) in real time unless the operator clicks `"Tùy chỉnh mã"` (or manually edits the code input). Displays a clean live URL preview chip: `Đường dẫn: /collections#soft-ceremony`.
    - On **Edit**: since `code` is immutable once created, replace the bulky disabled `<input>` with a compact read-only metadata bar (`Mã định danh: soft-ceremony · Không đổi sau khi tạo để giữ liên kết SEO`), keeping `[data-testid="collection-code"]` accessible if needed or cleanly testable.
  - **Blog Modal**:
    - On **Create**: typing `Tiêu đề` automatically populates `slug` until the user manually types into the `Slug` input; `"Tạo lại từ tiêu đề"` button stays available to resync anytime.
- **FR-4.3 Modal Grid & Card Action Ergonomics**:
  - Fix Collection meta row (`.cms-meta-grid`) to `grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 0.8fr)` so `Kỳ / phiên bản` (`COLLECTION 04 · AFTER-HOURS MUSE`) has ample width and never clips.
  - Differentiate CMS card actions: `[Tắt/Bật]` = neutral outline (`.erp-btn`), `[Sửa]` = primary/secondary clear action, `[Xóa]` = `.erp-btn--danger-outline` (subtle rose-red outline that fills on hover, never competing visually with primary `Sửa`).

### FR-5: System-Wide Velura Admin ERP Design System & Typography Alignment (`ngx-admin` Standard)
- **FR-5.1 Unified `:root` Tokens & Font Discipline (`styles.scss` & `styles-velura/dashboard.css`)**:
  - Remove `'Inter'` from `styles-velura/dashboard.css` (`--font` and `--font-sans` point to `var(--erp-font)` = `'Be Vietnam Pro', system-ui, -apple-system, sans-serif`).
  - Define complete `:root` tokens in `styles.scss`:
    - `--erp-font`: `'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
    - `--erp-display`: `'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
    - `--erp-font-mono`: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    - `--erp-brand`: `'Cormorant Garamond', Georgia, serif` (strictly for `.brand__copy strong` wordmark)
    - `--erp-control-border`: `#CBD5E1` (`--erp-control-border-hover`: `#94A3B8`) for WCAG-compliant crisp inputs/selects
    - `--erp-success-line`: `#A7F3D0`, `--erp-warning-line`: `#FDE68A`, `--erp-danger-line`: `#FECDD3`, `--erp-info-line`: `#BFDBFE`, `--erp-rose`: `#E11D48`
    - `--erp-topbar-h`: `56px`
- **FR-5.2 Shell, Navigation & Shared UI Components (`ngx-admin` Polish)**:
  - `admin-erp-shell`: align `.sidebar__brand` (`height: var(--erp-topbar-h)`) and `.topbar` (`height: var(--erp-topbar-h)`) to `56px` so the horizontal header border forms a single unbroken line; add a 3px left accent indicator bar on `.nav-link.is-active`; refine `.topbar__search` (`⌘K` command bar) and user card.
  - `styles.scss` buttons & inputs: `.erp-btn` uses crisp neutral ink (`var(--erp-ink)`) with `--erp-control-border`, reserving brand accent for `.erp-btn--primary`, soft rose for `.erp-btn--soft`, and danger outline for `.erp-btn--danger-outline`; `.erp-input` / `.erp-select` / `.erp-textarea` use `--erp-control-border` and hover state.
  - `admin-status-badge.ts`: `:host { flex-shrink: 0; }` + explicit semantic line borders so status pills never crush to `• Đ.`.
  - `admin-tabs.ts`: horizontal scroll safety (`max-width: 100%; overflow-x: auto; scrollbar-width: none`) + `flex-shrink: 0; white-space: nowrap` on `.tabs__item` + tabular mono count badges.
  - `admin-kpi-card.ts`: subtle top/left semantic accent hairline + `JetBrains Mono` tabular numerals.
  - `admin-data-table.ts`: fix undefined `var(--erp-rose)` focus outline to `var(--erp-accent)`, refine sticky header typography (`11.5px` uppercase, `Be Vietnam Pro 600`), subtle row hover (`var(--erp-accent-soft)` at 35% mix).
  - **Cross-Module Consistency**: Standardize header button ordering (`Làm mới` / secondary tools on left, primary `+ Thêm...` CTA on right) and panel header spacing across workspaces while keeping every component's SCSS well under the `16kB` warning / `32kB` error budget.

---

## 3. Non-Goals & Constraints
- **Zero Database Schema Migration Needed**: `collections.styling_metadata` (`JSONB`) and `banners.metadata` (`JSONB`) already exist in production PostgreSQL; all framing coordinates store cleanly inside those columns with backward-compatible defaults.
- **Strict Architecture Compliance (`AGENTS.md`)**:
  - Standalone Angular 21 + Signals (`OnPush`), zero `NgModule`, zero `any`, zero `HttpClient` in page components, JSDoc on all public interfaces/methods.
  - Router → Service → Repository separation in `apps/api`.
  - `anyComponentStyle` budget strictly `< 32kB` (target `< 22kB` for `admin-erp-content.page.scss`).
  - Full CI/CD rollout via `feature/KAN-116-*` → `develop` → `main` → signed container digests → Flux CD reconciliation → live production verification.
