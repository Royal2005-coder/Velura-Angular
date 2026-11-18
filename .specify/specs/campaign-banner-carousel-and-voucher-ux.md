# Specification: Velura Campaign Banner 5s Infinite Carousel, Couture Voucher Wallet & Admin Banner Studio (`KAN-120`)

## Design Read & Anti-Slop Floor (`design-taste-frontend` × `hallmark`)
- **Design Read**: *"Reading this as: redesign of a luxury Vietnamese womenswear promotional campaign & voucher wallet showcase (`/offers` on Velura Storefront) paired with an operator-first campaign banner studio in Velura Admin ERP (`/promotions`), with an editorial fashion-atelier language leaning toward Velura's Cormorant Garamond + Inter token system, tactile GPU-only (`transform` + `opacity`) 5-second infinite-loop rounded banner choreography, and perforated couture ticket-stub voucher cards."*
- **Dials**: `DESIGN_VARIANCE: 7`, `MOTION_INTENSITY: 6`, `VISUAL_DENSITY: 4`.
- **Hard Floor Rules**:
  1. GPU-only motion (`transform: translate3d / scale / scaleX`, `opacity`); zero `transition: all`, zero layout-thrashing `width`/`left` animations.
  2. Full `prefers-reduced-motion: reduce` fallback (disables auto-advance & motion transforms).
  3. Consistent corner-radius hierarchy (`28px` outer stage, `20px` inset media, `16px` ticket cards, `999px` interactive pills); single-line high-contrast WCAG AA+ CTAs; zero emojis or fake metrics.

## Functional Requirements
- **FR-01 (5s Rounded Infinite-Loop Campaign Banner Stage on `/offers`)**:
  - Replace stacked vertical `.offer-banner-row` cards + pagination with a rounded (`28px`) infinite-loop carousel (`[lastClone, ...campaigns, firstClone]`) that auto-advances every `5000ms` (`5s`) unidirectionally, pauses on hover/focus/drag/reduced-motion, supports pointer/touch swipe + keyboard `ArrowLeft`/`ArrowRight` + glass prev/next buttons + 5s `scaleX` progress dots + quick-jump campaign pills, and renders both image and video (`mp4`/`webm`) banners with `#focal=x,y,zoom` framing.
  - Each slide displays campaign highlight badge, countdown pill, title, description, inline linked voucher preview chips, and single-line CTAs (`Nhận N mã ưu đãi` focusing `#offer-focused` below + `Mua sắm ngay` → `/products`).
  - Deep-link `?offer=<promo_id>` opens directly on the matching slide and pins its vouchers at `#offer-focused`.
- **FR-02 (Couture Perforated Voucher Wallet Below on `/offers`)**:
  - Upgrade "Mã giảm giá của bạn" with filter pills (`Tất cả`, `Dùng được ngay`), perforated couture ticket-stub cards (left discount tier stub + top/bottom punch notches, 1-click `Sao chép` code pill with toast, condition/category chips, and contextual right-side CTA: `Dùng mã`, `Cập nhật hồ sơ`, or `Đăng nhập`).
- **FR-03 (Synchronized Admin ERP Campaign Banner Studio & API Media Support)**:
  - Upgrade `POST /api/v1/admin/promotions/banner` to accept both images (`JPG`/`PNG`/`WebP`/`GIF`) and motion videos (`MP4`/`WebM`), and sort `/api/user/offers` campaigns by `is_featured` desc → `display_order` asc → `start_date` desc with `media_type` metadata.
  - Upgrade `AdminErpPromotionsPage` (`apps/admin-erp-ng`) with a `Bảng` / `Banner Slider` view switcher (including live 5s rounded banner preview), expose `highlightLabel`, `displayOrder`, and `isFeatured` in the Campaign Modal & Drawer, integrate `<app-erp-image-cropper>` (`image` + `video` framing via `#focal=x,y,zoom`), and fix banner removal on update (`""` instead of `null`).
