# Technical Plan: Banner and Collection Lookbook Management System

## 1. Architectural Strategy
We implement a unified, resilient, full-stack CMS architecture for Storefront Banners and Seasonal Collections:
1. **Database Layer (PostgreSQL / Supabase Migration)**:
   - Migration `127_banners_and_collections_management.sql`.
   - Tables: `banners` and `collections` with proper indexes, constraints, and audit columns.
   - Comprehensive seed data matching the current production design (5 seasonal collections, home runway looks, product video & photo hero banners).
2. **Backend Services & API (`apps/api`)**:
   - `apps/api/src/banners/`: `banner-types.ts`, `banner-repository.ts`, `banner-service.ts`, `banner-router.ts`.
   - `apps/api/src/collections/`: `collection-types.ts`, `collection-repository.ts`, `collection-service.ts`, `collection-router.ts`.
   - Media upload route: `/api/v1/admin/upload/media` accepting images and videos with multipart streaming and validation.
   - Route registration in `apps/api/src/server.ts` for both public `/api/v1/banners`, `/api/v1/collections` and admin `/api/v1/admin/banners`, `/api/v1/admin/collections`.
3. **Storefront Frontend (`apps/user-ng`)**:
   - `CatalogService`: methods `getBanners(placement?: string)` and `getCollections()`.
   - `HomePage`: Dynamic runway hero looks loaded via signals with fallback to `HERO_LOOKS`.
   - `ProductListPage`: Dynamic video & image carousel/slider supporting autoplay, sound toggle, slide indicators, and pause on hover.
   - `CollectionsPage`: Dynamic collections list and category tabs loaded via signals with fallback to `COLLECTION_LOOKBOOKS`.
4. **Admin ERP Frontend (`apps/admin-erp-ng`)**:
   - Expand `AdminErpContentPage` with tabs:
     - `blogs` (Bài viết)
     - `banners` (Quản lý Banner: Trang chủ, Sản phẩm, Bộ sưu tập)
     - `collections` (Quản lý Bộ sưu tập & Upload ảnh người mẫu theo kỳ)
     - `subscribers` (Người đăng ký)
   - Add Banner Table & Modal (Upload media, preview, reorder, active toggle).
   - Add Collection Table & Modal (Story copy, script, gradient, multi-model image uploader with interactive 5-model runway preview).
   - Strict adherence to `/design-taste-frontend` and Angular 21 Standalone + Signals.

## 2. Risk Mitigation & Edge Cases
- **Database/Network Failure**: Fallback constants (`HERO_LOOKS`, `COLLECTION_LOOKBOOKS`, default video hero) ensure 0% storefront downtime.
- **Media Uploads**: Validate MIME types (MP4, WebM, JPEG, PNG, WebP) and size limits (10MB for photos, 50MB for videos).
- **CLS (Cumulative Layout Shift)**: Rigid CSS aspect ratios (`aspect-[21/9]` desktop, `aspect-[16/9]` tablet, `aspect-[4/3]` mobile) prevent layout jumping during video/image load.
- **Audio Autoplay Policies**: Browsers block unmuted video autoplay; video slides must initialize as `muted=true` with an explicit user toggle button.
