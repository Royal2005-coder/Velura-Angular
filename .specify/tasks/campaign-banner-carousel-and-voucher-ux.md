# Tasks: Velura Campaign Banner 5s Infinite Carousel, Voucher Wallet & Admin Banner Studio (`KAN-120`)

- [x] **T1 — Spec, Design Read (`design-taste-frontend` × `hallmark` Floor) & Clean Branch Setup**
  - Create `feature/KAN-120-campaign-banner-carousel-and-voucher-ux` and `.specify/{specs,plans,tasks}/campaign-banner-carousel-and-voucher-ux.md`.

- [x] **T2 — API Synchronization (`/api/user/offers` & `/api/v1/admin/promotions/banner`)**
  - Allow both image (`JPG`/`PNG`/`WebP`/`GIF`) and motion video (`MP4`/`WebM`) uploads on `POST /api/v1/admin/promotions/banner`.
  - Deterministically sort `/api/user/offers` campaigns by `is_featured` desc → `display_order` asc → `start_date` desc and enrich `media_type` + `display_order`.

- [x] **T3 — Storefront `/offers`: 5s Infinite-Loop Rounded Campaign Banner & Couture Voucher Wallet**
  - Build GPU-accelerated (`translate3d` + `opacity`) 5s auto-sliding unidirectional infinite-loop rounded banner carousel with hover/focus/reduced-motion pause, touch/pointer swipe, keyboard `ArrowLeft`/`ArrowRight`, 5s `scaleX` progress indicators, image + video + `#focal=` framing, inline campaign voucher preview chips, and clear CTAs.
  - Upgrade "Mã giảm giá của bạn" with filter toolbar, perforated couture ticket-stub cards, 1-click code copy, and contextual CTAs.

- [x] **T4 — Admin ERP `/promotions`: Campaign Banner Carousel Studio & Framing Synchronization**
  - Add `Bảng` / `Banner Slider` switcher with live 5s storefront banner preview on `AdminErpPromotionsPage`.
  - Expose `highlightLabel` (with presets), `displayOrder`, `isFeatured`, image/video upload + `<app-erp-image-cropper>` focal framing, and fix banner removal (`""` on update).

- [x] **T5 — Unit Tests, Monorepo Build Gate & Full Production CI/CD Rollout**
  - Expand `offers-card.test.ts`, `offers.page.spec.ts`, and `admin-erp-promotions.page.spec.ts`; verify builds & tests; merge PR → `develop` → `main` → signed digests → `verify-production` & verify live `https://velura.royalai.dev/offers` + `https://admin-erp.royalai.dev/promotions`.
