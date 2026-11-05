# Feature Specification: Blog CMS HTML/Source Mode, AI Product Matching & Font Rendering Fix

**Feature ID**: `FEAT-BLOG-CMS-HTML-SOURCE-PRODUCT-MATCH`  
**Jira/Ticket**: `KAN-106`  
**Status**: APPROVED (Post EGM Swarm Adversarial Review)  
**Target Architecture**:
- Admin ERP CMS: Angular 21 Standalone + Signals (`apps/admin-erp-ng/src/app/features/content/`, `apps/admin-erp-ng/src/app/core/`)
- Storefront Frontend: Angular 21 Standalone + Signals (`apps/user-ng/src/app/features/content/`, `apps/user-ng/src/styles-velura/pages/_blog.css`, `apps/user-ng/src/app/shared/pipes/safe-html.pipe.ts`)
- Backend API Gateway: Node.js TypeScript (`apps/api/src/content/content-admin-router.ts`, `apps/api/src/content/content-admin-service.ts`, `apps/api/src/content/content-admin-repository.ts`, `apps/api/src/content/blog-html.ts`, `apps/api/src/products/product-service.ts`, `apps/api/src/products/product-repository.ts`)
- AI Model: Google Gemini API via `apps/api/src/gemini-client.ts`
- Database: Supabase PostgreSQL (`public.blog`, `public.product`, `public.category`)

---

## 1. Executive Summary & Business Intent

Velura Fashion Journal / Blog CMS requires three high-impact enhancements:
1. **Chế độ HTML / Source Mode**: Bổ sung chế độ xem và chỉnh sửa trực tiếp mã nguồn HTML trong CMS Blog Editor (Admin ERP), cho phép chèn các thẻ ngữ nghĩa cao cấp như `<article>`, `<figure>`, `<figcaption>`, `<img>` kèm các style kích thước, tỉ lệ, bo góc chuẩn mực editorial. Hệ thống sanitizer phía client và server được nâng cấp allowlist an toàn để giữ nguyên cấu trúc mẫu mà không bị strip hay vỡ layout.
2. **Quản lý sản phẩm đính kèm & AI Match**: Cung cấp bộ lọc theo danh mục sản phẩm thời trang (`category`) và phân trang (Pagination) để biên tập viên duyệt và chọn nhanh trong toàn bộ kho sản phẩm mà không phụ thuộc vào ô tìm kiếm. Tích hợp tính năng AI phân tích nội dung bài viết (tiêu đề, tóm tắt, nội dung HTML) để tự động gợi ý danh sách sản phẩm thời trang trong kho phù hợp nhất, cho phép duyệt và đính kèm 1-click.
3. **Sửa lỗi Font tiếng Việt trên giao diện Blog**: Khắc phục triệt để hiện tượng vỡ dấu, tách khoảng trắng ở các từ có dấu tiếng Việt (ví dụ: "tố  i giản") trên tiêu đề và nội dung bài viết trên Storefront do xung đột font `Playfair Display`/`Georgia` và negative letter-spacing quá đà.

---

## 2. EGM Swarm Audit Resolutions

### 2.1 [B-01] Database Schema & Product Query Contract
- Đổi toàn bộ các tham chiếu bảng số nhiều sang số ít chuẩn PostgREST: `public.product` và `public.category`.
- Trong `apps/api/src/products/product-service.ts` (`parseListFilters`), hỗ trợ `status` đa giá trị phân tách bằng dấu phẩy (ví dụ `status=on_sale,out_of_stock`). Mỗi token được kiểm tra hợp lệ trong `PRODUCT_STATUSES`.
- Trong `apps/api/src/products/product-repository.ts`, map mảng status thành PostgREST query `in.(on_sale,out_of_stock)`.
- Tham số category trong `listProducts` chuẩn hóa là `categoryId` (UUID).
- Trong `apps/admin-erp-ng`, tái sử dụng triệt để `AdminErpApiService.listProducts` và `AdminErpApiService.listCategories()`.

### 2.2 [B-02] Two-Stage Grounded AI Product Suggestion Pipeline
- Không truyền toàn bộ catalog vào prompt Gemini (tránh kịch trần 30.000 ký tự và tránh rủi ro hallucinate UUID / giá tiền).
- **Quy trình 3 bước**:
  1. **Bước 1 (LLM Extraction)**: Trích xuất plain text bài viết (`blogPlainText(sanitizeBlogHtml(contentHtml)).slice(0, 3000)`), Gemini phân tích và trả về metadata thời trang: `{ keywords: string[], categories: string[], styleVibe: string }`.
  2. **Bước 2 (Database Grounding)**: Backend query top sản phẩm từ bảng `public.product` (`status in ('on_sale', 'out_of_stock')`) khớp với từ khóa / danh mục / phong cách.
  3. **Bước 3 (Synthesize & Enrich)**: Trả về dữ liệu sản phẩm thật từ database (ID, tên, slug, giá, ảnh thật), kèm lý do phù hợp `match_reason`.
- Cấu hình timeout 8 giây kèm hàm fallback nội bộ `fallbackBlogProductSuggestions` (tìm kiếm candidate products theo title/tags) để biên tập viên không bao giờ bị nghẽn quy trình khi AI bận hoặc mất mạng.

### 2.3 [B-03] Bounded Inline Style Regex & Angular SafeHtmlPipe
- Mở rộng `ALLOWED_TAGS` trên cả backend (`blog-html.ts`) và frontend (`admin-erp-blog-html.ts`) thêm `article`, `section`, `h1`.
- Cập nhật `BLOCK_BOUNDARY` và `BLOCK_SELECTOR` bao gồm `article,section,h1`.
- Cấu hình `allowedStyles` và frontend `cleanNode` với regex bounded chặt chẽ:
  - `width`, `height`, `max-width`, `max-height`: `/^\d{1,4}(px|%|em|rem|vw|vh)$/`
  - `margin`, `margin-*`, `padding`: `/^(\d{1,3}(px|%|em|rem)\s*){1,4}$|^auto$/`
  - `display`: `/^(block|inline-block|flex|grid|none)$/`
  - `object-fit`: `/^(cover|contain|fill|none|scale-down)$/`
  - `border-radius`: `/^\d{1,3}(px|%|em|rem)$/`
  - `text-align`: `/^(left|right|center|justify)$/`
  - Cấm hoàn toàn ký tự: `(`, `)`, `"`, `'`, `/`, `\\`, `@`, hoặc chuỗi `var`.
- Trên Storefront (`apps/user-ng`), tạo standalone `SafeHtmlPipe` (`DomSanitizer.bypassSecurityTrustHtml`) áp dụng riêng cho `article.contentHtml` (đã được server sanitize qua allowlist), giải quyết triệt để việc Angular mặc định xóa bỏ `style` trong template.

### 2.4 [M-01] Vietnamese Typography & Kerning Fix
- Không import thêm `Playfair Display` hay `DM Sans` vào `index.html` (tránh phình tải font và layout shift).
- Thay thế toàn bộ khai báo `font-family: "Playfair Display", Georgia, serif` và `"DM Sans", sans-serif` trong `_blog.css` bằng font tokens chuẩn của thương hiệu:
  - Heading: `var(--velura-font-display, "Cormorant Garamond", Georgia, serif)`
  - Body: `var(--velura-font-ui, "Inter", sans-serif)`
- Xóa bỏ `letter-spacing: -0.035em;` trên `.article-header__title` (thay bằng `letter-spacing: 0;` hoặc `letter-spacing: -0.015em;`), chấm dứt hoàn toàn hiện tượng ngắt dấu ("tố  i giản").
- Chuẩn hóa Unicode NFC (`title.normalize('NFC')`, `excerpt.normalize('NFC')`, `content.normalize('NFC')`) tại `content-admin-service.ts` trước khi ghi vào database.

### 2.5 [M-02] Đồng bộ trạng thái WYSIWYG & HTML Source Mode
- `draft().contentHtml` là nguồn chân lý phản ứng (single reactive source of truth).
- Khi toggle giữa `Source Mode` (textarea) và `WYSIWYG` (contenteditable):
  - Chuyển sang Source Mode: textarea lấy giá trị từ `draft().contentHtml`.
  - Chuyển về WYSIWYG: gán `#editor.innerHTML = sanitizeEditorHtml(draft().contentHtml)`.
- Khi bấm `Lưu bài viết`: đọc trực tiếp từ `draft().contentHtml` thay vì chỉ đọc DOM `#editor.innerHTML`.
- Disable các nút định dạng `document.execCommand` khi đang ở chế độ Source Mode.

### 2.6 [M-03] Tách biệt Danh mục Sản phẩm & Danh mục Bài viết
- Thêm signal `productCategories = signal<AdminCategoryRow[]>([])`.
- Nạp danh mục sản phẩm từ `this.api.listCategories()` khi mở modal biên tập.
- Dropdown lọc danh mục trong tab `Sản phẩm` liên kết với `productCategories()`.

### 2.7 [M-04] Phân trang & Bộ lọc Phản ứng cho Sản phẩm
- Các signal: `productQuery`, `productCategoryId`, `productPage` (0-indexed), `productPageSize` (8), `productTotalCount`, `productTotalPages = computed(() => Math.max(1, Math.ceil(this.productTotalCount() / 8)))`.
- Khi thay đổi query, category hoặc page -> trigger `api.listProducts({ q, categoryId, status: 'on_sale,out_of_stock', limit: '8', offset: String(page * 8), order: 'updated_at.desc' })`.
- Hiển thị thanh phân trang gồm nút `Trước`, `Trang X/Y`, `Sau`.

---

## 3. Data Contracts & API Specifications

### 3.1 AI Product Suggestion Endpoint
- **Route**: `POST /api/v1/admin/content/blogs/ai-suggest-products`
- **Auth**: Required Bearer Token (`requirePermission(context, "content", "update")`)
- **Request Body**:
```json
{
  "title": "Quiet Luxury: Nghệ thuật mặc đẹp từ sự tối giản",
  "excerpt": "Không cần quá nhiều chi tiết để trở nên nổi bật...",
  "contentHtml": "<article><h1>...</h1></article>",
  "limit": 6
}
```
- **Response Body**:
```json
{
  "suggestedProducts": [
    {
      "product_id": "uuid",
      "name": "Đầm Dạ Hội Lụa Hoàng Gia Velura",
      "slug": "dam-da-hoi-lua-hoang-gia-velura",
      "base_price": 950000,
      "sale_price": null,
      "images": ["https://..."],
      "status": "out_of_stock",
      "match_reason": "Thiết kế lụa tối giản, sang trọng chuẩn phong cách Quiet Luxury"
    }
  ],
  "reasoning": "Bài viết nhấn mạnh phong cách tối giản cao cấp đề cao chất liệu lụa và cotton phom dáng thanh lịch."
}
```

### 3.2 Product Listing
- Tái sử dụng `GET /api/v1/admin/products` với:
  - `q`: string
  - `categoryId`: UUID
  - `status`: `on_sale,out_of_stock`
  - `limit`: number
  - `offset`: number
