# Tasks: Velura Admin ERP Design System Overhaul & Interactive CMS Studio (`KAN-116`)

- [x] **T1 — Backend API JSONB Framing & Subscriber Search (`apps/api` + `tests/api`)**
  - Validate & shallow-merge `styling_metadata` (`cover_x`, `cover_y`, `cover_zoom`) in `collection-service.ts`.
  - Validate & shallow-merge `metadata` (`focal_x`, `focal_y`, `focal_zoom`, `autoplay`, `sound_default`) in `banner-service.ts` + preserve explicit `null` CTA fields in `banner-repository.ts`.
  - Add `q` search filtering to `content-admin-service.ts#listSubscribers`.
  - Add unit tests in `tests/api/collection-service.test.ts` and `tests/api/banner-service.test.ts`; verify `npm run typecheck:api` & `npm run test:api`.

- [x] **T2 — Storefront Cover & Banner Framing Parity (`apps/user-ng`)**
  - Normalize `coverX` (`50`), `coverY` (`16`), `coverZoom` (`1`) in `collection-lookbook.ts` + `collectionCoverFraming()` helper; bind on `collections.page.{ts,html}` and set default `object-position: 50% 16%` in `_collections.css` (fixing `Midnight Mirage` cropped heads).
  - Add `bannerMediaFraming()` (`50`, `28`, `1`) in `banner.interface.ts`; remove hardcoded `object-position: center` in `product-list.page.html` and bind framing on hero `<img>` & `<video>`.
  - Add unit tests in `collections.page.spec.ts` / `product-list.page.spec.ts`; verify `npm run build:user` & `npm run test:user`.

- [x] **T3 — Velura Admin ERP Design System, Typography & Shared UI Primitives (`apps/admin-erp-ng`)**
  - Standardize `:root` tokens in `styles.scss` (`Be Vietnam Pro`, `JetBrains Mono`, `Cormorant Garamond` brand-only, WCAG AA `--erp-control-border: #8492A6`, semantic line tokens, `--erp-topbar-h: 56px`, `.erp-btn`, `.erp-btn--danger-outline`, `.erp-segmented`); strip `'Inter'` & `'DM Sans'` from `styles-velura/dashboard.css`; sync `docs/ADMIN-DESIGN-SYSTEM.md`.
  - Align `56px` sidebar/topbar divider & active nav-link indicator bar in `admin-erp-shell.scss`.
  - Upgrade `overlay-stack.ts`, `admin-modal.ts`, `admin-confirm.ts` (`z-index: 120`, reactive `inert`, stale `reason` reset), `admin-status-badge.ts` (`flex-shrink: 0`), `admin-tabs.ts` (scrollable nowrap), `admin-kpi-card.ts`, and `admin-data-table.ts` (`outline` / `danger-outline` row actions, `.cell-media` overflow box).

- [x] **T4 — Interactive CMS Studio Components (`<app-erp-image-cropper>` & `<app-erp-gradient-picker>`)**
  - Build standalone `apps/admin-erp-ng/src/app/shared/ui/admin-image-cropper.ts` (pointer-capture drag pan at `0.1%` precision, `100%–240%` zoom slider + step buttons, rule-of-thirds grid, 4 framing presets + reset, keyboard nudges, `image` & `video` support) + unit spec.
  - Build standalone `apps/admin-erp-ng/src/app/shared/ui/admin-gradient-picker.ts` (8 curated Velura swatches, `#rgb`→`#rrggbb` 3-stop color pickers, 4 angle pills, collapsible raw CSS, `cover`-mode compact state) + unit spec.

- [x] **T5 — Admin ERP Content Studio Overhaul & Workspace Integration (`admin-erp-content`)**
  - Update `AdminCollectionRow` & `admin-erp-content.ts` (`styling_metadata`, `computeMediaFraming`, `collectionCodeFromName`, `CMS_COLLECTION_LINK_MAX = 255`, edit gradient/link validation) + `admin-erp-content.spec.ts`.
  - Upgrade `admin-erp-content.page.{ts,html,scss}`: working `Thẻ | Bảng` (`bannerColumns`, `collectionColumns`, quick actions) + contextual `<app-erp-filter-bar>` across all 7 tabs, `AdminErpToastService` + `AdminErpConfirmService` (removing persistent `"Đã cập nhật bộ sưu tập thành công."` banner), `<app-erp-image-cropper>`, `<app-erp-gradient-picker>`, live auto-slug, 3-column `.cms-meta-grid`, RBAC guards, `[dirty]`/`[busy]` modal guards, and SCSS budget `< 25kB` (plus button order alignment in `admin-erp-promotions.page.html`).
  - Update & expand `admin-erp-content.page.spec.ts`; verify `npm run build:admin-erp`, `npm run test:admin-erp`, `npm run build:admin`, `npm run test:admin`.

- [ ] **T6 — Full Convergence, PR -> `develop` -> `main` Signed Digests -> Production Verification**
  - Reconcile all FRs & EGM findings (`/speckit-converge`), commit with `KAN-116 why: ...`, open PR to `develop`, drive CI + promotion PRs (`develop` → `main` → `deploy-production` → `promote-images` → `main` → `verify-production`), and verify live production (`velura.royalai.dev` & `admin-erp.royalai.dev`).
