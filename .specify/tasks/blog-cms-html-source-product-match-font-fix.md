# Implementation Tasks: Blog CMS HTML/Source Mode, AI Product Matching & Font Rendering Fix

**Feature ID**: `FEAT-BLOG-CMS-HTML-SOURCE-PRODUCT-MATCH`  
**Jira/Ticket**: `KAN-106`  
**Status**: APPROVED  

---

## Tasks Breakdown

- [ ] **TASK-1: Upgrade HTML Sanitizer Allowlists (Backend & Admin ERP)**
  - Paths:
    - `apps/api/src/content/blog-html.ts`
    - `apps/admin-erp-ng/src/app/core/admin-erp-blog-html.ts`
    - `apps/admin-erp-ng/src/app/core/admin-erp-blog-html.spec.ts`
  - Acceptance:
    - `ALLOWED_TAGS` includes `article`, `section`, `h1`.
    - `BLOCK_BOUNDARY` and `BLOCK_SELECTOR` include `article|section|h1`.
    - Allowed styles on `img`, `figure`, `figcaption`, `p`, `span`, `div`, `article`, `section`: `display`, `width`, `height`, `max-width`, `max-height`, `object-fit`, `border-radius`, `margin` (shorthand and longhand directional), `padding` (shorthand and longhand directional), `text-align`.
    - Allowed attributes: `style`, `class`, `width`, `height`, `loading`, `src`, `alt`, `title`, `href`, `target`, `rel`.
    - Unit tests in `admin-erp-blog-html.spec.ts` pass, proving `<article><h1>...</h1><figure><img src="..." style="..." width="100%"><figcaption>...</figcaption></figure></article>` retains safe styles and semantic tags while stripping XSS vectors.

- [ ] **TASK-2: Storefront SafeHtmlPipe & Vietnamese Typography / Kerning Fix**
  - Paths:
    - `apps/user-ng/src/app/shared/pipes/safe-html.pipe.ts`
    - `apps/user-ng/src/app/features/content/blog-detail.page.ts`
    - `apps/user-ng/src/app/features/content/blog-detail.page.html`
    - `apps/user-ng/src/styles-velura/pages/_blog.css`
  - Acceptance:
    - `SafeHtmlPipe` created and registered in `BlogDetailPage.imports`.
    - `blog-detail.page.html` binds `[innerHTML]="article.contentHtml | safeHtml"`.
    - In `_blog.css`: all hardcoded `"Playfair Display"` and `"DM Sans"` declarations replaced with `var(--velura-font-display)` and `var(--velura-font-ui)`.
    - `.article-header__title` `letter-spacing: -.035em;` reset to `0` or `-0.015em;`, preventing Vietnamese composite tone marks from splitting (e.g. "tố  i giản" -> "tối giản").

- [ ] **TASK-3: Backend Multi-Status Query & AI Product Suggestion Pipeline**
  - Paths:
    - `apps/api/src/products/product-service.ts`
    - `apps/api/src/products/product-repository.ts`
    - `apps/api/src/content/content-admin-repository.ts`
    - `apps/api/src/content/content-admin-service.ts`
    - `apps/api/src/content/content-admin-router.ts`
  - Acceptance:
    - `product-service.ts` accepts comma-separated status strings (e.g. `on_sale,out_of_stock`).
    - `product-repository.ts` issues PostgREST `status=in.(on_sale,out_of_stock)`.
    - `content-admin-repository.ts` adds `listCandidateProducts(options, accessToken)`.
    - `content-admin-service.ts` implements `suggestBlogProducts`:
      - Requires `content:update` permission.
      - Enforces Unicode NFC normalization on blog drafts.
      - Extracts fashion metadata via Gemini (timeout 8s, `maxRetries: 0`).
      - Grounds against genuine candidate products and synthesizes `match_reason`.
      - Provides `fallbackBlogProductSuggestions` for offline/timeout scenarios.
    - `content-admin-router.ts` handles `POST /api/v1/admin/content/blogs/ai-suggest-products`.

- [ ] **TASK-4: Admin ERP CMS Blog Editor - HTML Source Mode & Product Tab Enhancements**
  - Paths:
    - `apps/admin-erp-ng/src/app/core/admin-erp-api.service.ts`
    - `apps/admin-erp-ng/src/app/features/content/admin-erp-content.page.ts`
    - `apps/admin-erp-ng/src/app/features/content/admin-erp-content.page.html`
    - `apps/admin-erp-ng/src/app/features/content/admin-erp-content.page.scss`
  - Acceptance:
    - `AdminErpApiService` adds `suggestBlogProducts()` and export types `AdminBlogProductMatch`, `AdminBlogProductSuggestionPayload`.
    - Blog Editor Toolbar has `Mã HTML / Source` toggle button.
    - WYSIWYG `#editor` and Source `<textarea>` use `[hidden]` bindings with zero race conditions.
    - Switching modes preserves and synchronizes `draft().contentHtml`.
    - WYSIWYG formatting buttons disabled in Source Mode.
    - Product tab has Category dropdown filter bound to `productCategories()` (fetched from `api.listCategories()`).
    - Product tab has working pagination: `productPage`, `productPageSize = 8`, `productTotal`, `productTotalPages`, with Prev/Next buttons. Changing category or query resets page to 0.
    - `AI Gợi ý Sản phẩm Phù Hợp` button triggers AI suggestion and renders matches with `match_reason` badges, `Đính kèm tất cả gợi ý` button, and individual attach actions.

- [ ] **TASK-5: Verification Suite & Regression Testing**
  - Paths:
    - `tests/api/content-admin.test.ts`
  - Acceptance:
    - API tests for `ai-suggest-products` pass.
    - `npm run typecheck:api` passes.
    - `npm run test:api` passes.
    - `npm run build:api && npm run build:user && npm run build:admin-erp` passes.
