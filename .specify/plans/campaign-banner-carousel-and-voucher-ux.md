# Technical Plan: Velura Campaign Banner 5s Infinite Carousel, Voucher Wallet & Admin Banner Studio (`KAN-120`)

## Architecture & Constraints
- **Isolated Docker Contexts**: Storefront helpers stay inside `apps/user-ng`; Admin ERP helpers stay inside `apps/admin-erp-ng`; API logic stays inside `apps/api`.
- **Zero Risky DB Schema Changes**: `promotion` table & `admin_save_recovery_promotion` RPC already persist `banner_image_url` (`varchar(500)`), `highlight_label` (`varchar(60)`), `display_order` (`integer`), `is_featured` (`boolean`), and `description` (`text`). Focal framing coordinates (`posX`, `posY`, `zoom`) serialize cleanly as `#focal=x,y,zoom` on `bannerImageUrl` (accepted by `SAFE_IMAGE_URL = /^(https?:\/\/|\/)/i` and ignored by HTTP servers while parsed client-side).
- **Contract Preservation**: Preserve all existing `OffersPage` signals/methods (`voucherGroups`, `focusedCampaign`, `focusedVouchers`, `cleanTitle`, `useVoucherParams`, `onUseVoucher`) and `AdminErpPromotionsPage` contracts (`expectedVersion`, RBAC `canMutate()`, budget ceiling validation, duplicate folded name check).

## Phased Implementation
1. **T1**: Specification, Technical Plan, Task Ledger, and clean `feature/KAN-120-campaign-banner-carousel-and-voucher-ux` branch.
2. **T2**: API upgrades (`apps/api/src/pricing/pricing-router.ts` image+video upload, `apps/api/src/user/offers.ts` deterministic `is_featured` + `display_order` sort & `media_type` enrichment).
3. **T3**: Storefront `/offers` (`offer.interface.ts`, `offers.page.ts`, `offers.page.html`, `_offers-center.css`, `_voucher-wallet.css`) — 5s infinite-loop rounded campaign banner stage + perforated ticket-stub voucher wallet.
4. **T4**: Admin ERP `/promotions` (`admin-erp-promotions.page.{ts,html,scss}`) — `Bảng` / `Banner Slider` studio, live 5s banner preview, `highlightLabel` + `displayOrder` + `isFeatured` controls, `<app-erp-image-cropper>` image/video framing, and update clear-banner fix.
5. **T5**: Unit tests (`tests/api/offers-card.test.ts`, `offers.page.spec.ts`, `admin-erp-promotions.page.spec.ts`), build/test verification, and full CI/CD rollout to live Production.
