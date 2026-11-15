# Specification: Admin ERP Visual & Operator Ergonomics Overhaul (Reviews, Promotions, Content, Dashboard & Brand)

Tickets: KAN-106 (admin ERP visual & operator ergonomics).
Target branch: `develop` → promote `main`.
Governing contract: `AGENTS.md` (Standalone + Signals, zero `any`, zero `HttpClient` in page components, JSDoc on public APIs, commit `KAN-n why`, PR template Default).

---

## 1. Problem Statement & User Findings

Based on actual operator feedback and live dashboard screenshots:
1. **Reviews Queue (`/reviews`)**:
   - The "ĐÁNH GIÁ" table column stretches unconstrained (single line text over 1,000px), pushing all other columns off-screen and creating an awkward horizontal scroll.
   - Missing rating stars, missing product thumbnail, and user-uploaded review attachments/photos are not shown in the list.
   - Operators cannot quickly distinguish high-priority issues or preview media without digging into individual rows.

2. **Campaigns & Promotions (`/promotions`)**:
   - Marketing campaigns have configured banner images in the database/API (`banner_url`), but the overview table only displays plain text names without thumbnail previews.

3. **Content & Blog Management (`/content`)**:
   - Blog posts have cover images and excerpts, but the article table is purely text-based (Title, Slug, Category).
   - Slugs and long titles wrap awkwardly without truncation, lacking the visual card/thumbnail aesthetics of modern admin CMS templates (CoreUI / ngx-admin).

4. **Technical Leaks & Clutter in UI (`/members`)**:
   - The Members & Loyalty page exposes internal database schema implementation notes in operator-facing headers and footers:
     - `subtitle="Ví điểm đọc trực tiếp từ loyalty_account và loyalty_ledger..."`
     - `<p class="member-hint">Số dư lấy từ loyalty_account (milli-point); mỗi bút toán là một dòng loyalty_ledger. Cột users.loyalty_points của production không được dùng vì luôn bằng 0.</p>`
   - These confusing developer notes must be removed and replaced with clean, operator-focused business copy.

5. **Sidebar Brand Logo Contrast**:
   - The Velura red flower icon sits inside a dark brown container on top of a dark cocoa sidebar (`#3A2622`), making the emblem almost invisible.
   - Operators requested a clean white background (`#FFFFFF`) for the logo icon badge to make the brand mark pop out sharply and legibly.

6. **Dashboard Gaps & Operator Sync (`/dashboard`)**:
   - Widgets Q3 (Payment Gateways & Reconciliation) and B5 (Returns & Product Quality) display hardcoded empty state messages ("Chưa có nguồn dữ liệu cho mục này. API chưa trả...").
   - When analytics star schema is not yet synced, the business tab shows unverified warning without a direct one-click "Đồng bộ số liệu ngay" (Sync Analytics) button to trigger `POST /api/v1/admin/dashboard/refresh`.

---

## 2. Requirements & User Stories

### US-1: Reviews Table Formatting & Attachment Previews
- **AS AN** operations / CSKH operator,
- **I WANT** the reviews table to clamp long comments to a reasonable width (with ellipsis and tooltip), show the product thumbnail, display rating stars, and highlight user-uploaded photos,
- **SO THAT** I can scan, moderate, and prioritize customer feedback within seconds.
- **Acceptance Criteria**:
  1. Product column renders product thumbnail image (34x34px) + product name.
  2. Rating column renders visual stars (e.g. `5 ★` or filled star icons) with semantic color (5★ green, 1-2★ red/danger).
  3. Review comment column is clamped (`truncate: '320px'`) with hover tooltip showing full content.
  4. Media column shows user photo thumbnails (or badge indicating number of photos attached).
  5. Row quick-actions: "Duyệt" (Approve) and "Ẩn" (Hide) directly accessible on the row.

### US-2: Marketing Campaigns Banner Visuals
- **AS A** marketing manager,
- **I WANT** marketing campaigns in the overview list to show their banner image thumbnails,
- **SO THAT** I can visually recognize ongoing sales campaigns and seasonal promotions at a glance.
- **Acceptance Criteria**:
  1. `campaignColumns` provides `image: (row) => row.banner_url || ...`.
  2. When no banner is set, a graceful brand campaign placeholder icon is displayed.

### US-3: Content & Blog Visual Presentation
- **AS A** content editor,
- **I WANT** the blog article table to display article cover thumbnails and truncated slugs,
- **SO THAT** the content list is visually organized like modern CMS tools (ngx-admin / CoreUI).
- **Acceptance Criteria**:
  1. Post column displays article cover image thumbnail (`image_url` or `og_image_url`).
  2. Slugs are truncated (`truncate: '180px'`) with font mono.
  3. Action to view / edit draft opens smoothly.

### US-4: Elimination of Developer / Schema Notes
- **AS AN** enterprise administrator,
- **I WANT** all operator screens to use professional, customer-centric terminology and have zero developer implementation notes,
- **SO THAT** the interface looks polished, confidential, and production-ready.
- **Acceptance Criteria**:
  1. Remove `users.loyalty_points luôn bằng 0` hint from `/members`.
  2. Replace technical subtitle with `"Quản lý thành viên, tài khoản ví điểm và lịch sử tích lũy Velura Loyalty."`.
  3. Audit other modules for similar technical leaks.

### US-5: Sidebar Logo High-Contrast Presentation
- **AS AN** operator,
- **I WANT** the brand logo in the sidebar to have a clean white background,
- **SO THAT** the red Velura flower emblem is prominent, crisp, and high-contrast.
- **Acceptance Criteria**:
  1. `.brand img` styled with `background: #ffffff`, padding, subtle border-radius, and crisp shadow.

### US-6: Dashboard Graceful Presentation & One-Click Sync
- **AS A** store executive,
- **I WANT** the dashboard to provide a direct "Đồng bộ số liệu ngay" button when analytics need refreshing, and present Q3 (Payment Gateways) and B5 (Returns & Quality) with structured cards rather than raw empty-state error messages,
- **SO THAT** I have actionable operational visibility at all times.
- **Acceptance Criteria**:
  1. Add "Đồng bộ số liệu ngay" button calling `POST /api/v1/admin/dashboard/refresh`.
  2. Q3 renders structured gateway status cards (VNPAY, MoMo, ZaloPay, COD, Stripe) showing payment error counts and direct link to Orders / Finance.
  3. B5 renders return reasons breakdown linked to open return tickets.
