# Technical Plan: Admin ERP Visual & Operator Ergonomics Overhaul

Tickets: KAN-106
Target branch: `develop` → promote `main`
Architecture standard: Standalone Components, Angular Signals, Zero `any`, Zero `HttpClient` in page components, WCAG 2.1 AA Contrast.

---

## 1. Architecture & Impact Analysis

### 1.1 Affected Modules & Files
1. `apps/admin-erp-ng/src/app/features/reviews/`:
   - `admin-erp-reviews.page.ts`: Update `reviewColumns`, add `productThumb`, `mediaCount`, `reviewRowActions` (approve/hide quick actions).
   - `admin-erp-reviews.page.html`: Bind `[rowActions]`, enhance drawer with customer attachments gallery.
   - `admin-erp-reviews.page.scss`: Add styling for media thumbnail badge and review preview.
   - `admin-erp-reviews.page.spec.ts`: Update tests to cover new columns and quick actions.

2. `apps/admin-erp-ng/src/app/features/promotions/`:
   - `admin-erp-promotions.page.ts`: Add `image` resolver in `campaignColumns`, truncate long campaign names.
   - `admin-erp-promotions.page.spec.ts`: Verify test suite remains green.

3. `apps/admin-erp-ng/src/app/features/content/`:
   - `admin-erp-content.page.ts`: Add `image` resolver (`image_url || og_image_url`) in `columns`, add `truncate` on title and slug.
   - `admin-erp-content.page.spec.ts`: Verify test suite remains green.

4. `apps/admin-erp-ng/src/app/features/members/`:
   - `admin-erp-members.page.html`: Clean up subtitle and eliminate `<p class="member-hint">` developer schema text.
   - `admin-erp-members.page.spec.ts`: Verify tests pass.

5. `apps/admin-erp-ng/src/app/layout/`:
   - `admin-erp-shell.scss`: Style `.brand img` with crisp white background (`#ffffff`), padding, and subtle shadow for sharp contrast against the dark cocoa sidebar.

6. `apps/admin-erp-ng/src/app/features/dashboard/`:
   - `admin-erp-dashboard.page.ts`: Add `syncingAnalytics` signal and `syncAnalytics()` method calling `api.refreshDashboard()`.
   - `admin-erp-dashboard.page.html`:
     * Add "Đồng bộ số liệu ngay" button in the warning banner.
     * Replace empty state in Q3 with structured payment gateways grid (COD, VNPAY, MoMo, ZaloPay, Stripe) and error indicators.
     * Replace empty state in B5 with structured returns breakdown by reason and link to Returns queue.
   - `admin-erp-dashboard.page.spec.ts`: Ensure tests pass.

---

## 2. Implementation Strategy & Safeguards

- **No Breakage of API Contracts**: All UI enhancements consume existing properties from `AdminReviewRow`, `AdminPromotionRow`, `AdminBlogRow`, `AdminDashboardSummary`.
- **Keyboard Navigation & Accessibility**:
  - All tables maintain ArrowUp/ArrowDown selection and Enter key navigation.
  - Image thumbnails have empty alt text `alt=""` and lazy loading `loading="lazy"`.
  - Truncated cells have `title` attribute for full content preview on hover and keyboard focus.
- **Double-Submit Prevention**:
  - The "Đồng bộ số liệu ngay" button is disabled while `syncingAnalytics()` is true, preventing 429 throttling.
