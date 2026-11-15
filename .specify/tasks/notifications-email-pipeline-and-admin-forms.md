# Task Breakdown: Notifications & Email Pipeline, Admin-ERP Form Validation & Performance Optimization

- [ ] **T1: Database Indexing & Performance Migration**
  - Path: `database/migrations/125_performance_and_notification_indexes.sql`
  - Spec: Composite indexes on `notifications(user_id, is_read, created_at desc)`, `return_exchange(user_id, status, created_at desc)`, `orders(user_id, status, created_at desc)`, `reviews(product_id, is_approved, created_at desc)`.
  - Verification: SQL syntax check and schema verification.

- [ ] **T2: Backend Mailer & Notification Integration for Returns**
  - Path: `apps/api/src/returns/return-email.ts`, `apps/api/src/user/returns-service.ts`, `apps/api/src/returns/return-service.ts`
  - Spec: Add `sendReturnIntakeEmail`, `sendReturnApprovedEmail`. Trigger `createNotification` and email when customer creates return, when admin approves return, and when refund is executed.
  - Verification: Node unit test in `tests/api/returns-notifications.test.ts`.

- [ ] **T3: Backend Mailer & Notification Integration for Orders**
  - Path: `apps/api/src/orders/order-service.ts`, `apps/api/src/orders/order-email.ts`
  - Spec: Trigger `createNotification` and customer email when order status moves to `delivered` or `completed`.
  - Verification: Node unit test in `tests/api/order-notifications.test.ts`.

- [ ] **T4: Storefront PWA Web Push & Notification Bell Enhancements**
  - Path: `apps/user-ng/src/app/core/services/notifications.service.ts`
  - Spec: Web Push API, browser notification triggers, unread badge real-time reactive sync.
  - Verification: Angular unit test in `apps/user-ng/src/app/core/services/notifications.service.spec.ts`.

- [ ] **T5: Admin-ERP Form Validation & Red Asterisks (`*`) Overhaul**
  - Path: `apps/admin-erp-ng/src/styles.scss`, `apps/admin-erp-ng/src/app/features/products/product-editor.component.html`, `apps/admin-erp-ng/src/app/features/promotions/admin-erp-promotions.page.html`, `apps/admin-erp-ng/src/app/features/content/admin-erp-content.page.html`, `apps/admin-erp-ng/src/app/features/accounts/admin-erp-accounts.page.html`, `apps/admin-erp-ng/src/app/features/orders/admin-erp-orders.page.html`, `apps/admin-erp-ng/src/app/features/returns/return-flow.component.html`, `apps/admin-erp-ng/src/app/features/returns/chat-desk.component.html`
  - Spec: Global `.erp-required` (`*`), remove all text `(bắt buộc)`, inline validation error display on touched/dirty/invalid.
  - Verification: Angular specs & `npm run build:admin-erp`.

- [ ] **T6: Image Lazy Loading & Layout Shift (CLS) Optimization**
  - Path: `apps/admin-erp-ng/src/app/...`, `apps/user-ng/src/app/...`
  - Spec: Add `loading="lazy"` and `decoding="async"` across all product, review, campaign, blog, and avatar images.
  - Verification: Template audit and regression build.

- [ ] **T7: Full Test Suite & Build Verification**
  - Path: Full monorepo
  - Spec: `npm run test:api`, `npm run test:admin-erp`, `npm run test:user`, `npm run build:api`, `npm run build:admin-erp`, `npm run build:user`.
  - Verification: All tests pass 100%, 0 build errors.

- [ ] **T8: PR Develop & Production Promotion**
  - Path: GitHub PR & Actions
  - Spec: Commit `KAN-106 why: ...`, open PR to `develop`, verify CI, merge, promote to `main`.
  - Verification: Production deployment healthy.
