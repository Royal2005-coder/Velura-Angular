# Spec: CMS Bộ sưu tập / Banner / 5 người mẫu trang chủ — chuẩn production (KAN-116)

Nguồn: yêu cầu owner 2026-11-17 + 6 ảnh chụp màn hình (admin `Marketing / CMS nội dung` tab `Quản lý Banner`, tab `Bộ sưu tập & Lookbook`; storefront trang chủ, `/collections`). Kế thừa nhưng **sửa sai** hai spec cũ `banner-and-collection-management.md` (KAN-108) và `homepage-runway-collections-models-sync.md` (KAN-109): hai spec đó coi `home_hero` là banner ảnh ngang và coi home runway = `models[0]` của 5 bộ sưu tập đầu — cả hai đều là nguyên nhân gốc của lỗi hiện tại (xem §2).

Nhãn bằng chứng: `[V]` = đã đọc code/probe production trực tiếp (2026-11-17); `[INF]` = suy luận, cần xác minh ở bước verify tương ứng. Đường dẫn tương đối repo root (worktree `wt-ux2`, nhánh `feature/KAN-116-ux-flow-cms`). Mọi số dòng là của nhánh này tại thời điểm viết.

---

## 0. Quyết định thiết kế (đã chốt — implementer không tự quyết lại)

| # | Quyết định | Lý do (tóm tắt) |
|---|---|---|
| D1 | **Hero trang chủ = dữ liệu riêng trên bảng `collections`**: thêm cột `home_model_url`, `show_on_home`, `home_sort_order`. Không dùng `banners.placement='home_hero'`. | Mỗi người mẫu trang chủ phải mang đúng *tên bộ sưu tập* của nó và link của nó; một nguồn duy nhất (collection) loại bỏ lệch tên/link. Hero strip 5 ảnh của trang `/collections` (`models`) và 5 người mẫu trang chủ được **tách** thành hai trường độc lập (yêu cầu "tách riêng 5 người mẫu"). |
| D2 | **Combo/set của bộ sưu tập chọn tường minh** qua cột `collections.product_ids UUID[]` (có thứ tự), chỉ nhận sản phẩm `is_combo = true`. Bỏ toàn bộ fallback đoán mò ở storefront. | Hiện tại storefront đoán theo `product.collection === name` rồi theo category rồi `slice` bất kỳ (§2.4) → lẫn lộn, không điều khiển được. Dùng một cột mảng (không bảng nối) để PUT thay thế nguyên tử bằng 1 `UPDATE` qua PostgREST. |
| D3 | **Ảnh bìa (`banner_url`) có chế độ hiển thị rõ ràng**: cột mới `hero_mode TEXT` ∈ {`models`,`cover`}, mặc định `models`. `models` = bố cục hiện tại (gradient + 5 cutout). `cover` = ảnh bìa full-bleed, ẩn 5 cutout. | Ảnh bìa live (`velura_Soft-Ceremony_cover.png` 1672×941) là ảnh lookbook *đã chứa sẵn 5 người mẫu có nền* [V, ảnh đã xem] → chồng 5 cutout lên sẽ trùng người. Mặc định `models` giữ nguyên giao diện user đang thấy. |
| D4 | **Mô tả ngắn = `home_story`; mô tả bên hông chi tiết = `story_desc`.** Hiện `home_story` không bao giờ render (chỉ là fallback chết của `story_desc` bắt buộc). | Khớp từ vựng của owner: "mô tả ngắn" vs "mô tả bên hông chi tiết". |
| D5 | **Banner chỉ còn placement `products_hero`.** `home_hero`, `collections_hero` bị gỡ khỏi API validation, type, admin select. | Chỉ `products_hero` có consumer thật (`product-list.page.ts:695`). Hai placement còn lại cho operator thêm banner mà không hiện đâu cả. Production hiện chỉ có 3 banner, tất cả `products_hero` [V]. |
| D6 | **Mỗi field admin sửa được phải có tác dụng trên storefront hoặc bị gỡ khỏi form.** `label` (không render ở đâu) bị gỡ khỏi form; DB giữ cột, service tự điền `label = name` khi trống. | Tránh "sửa mà không đổi gì". |
| D7 | Test API mới đặt ở `tests/api/*.test.ts` (đây là glob duy nhất `npm run test:api` chạy — `package.json:24`). Hai file test hiện có trong `apps/api/src/{banners,collections}/*.test.ts` **không được chạy bởi `test:api`** [V] → di chuyển. | Không có test nào thực sự bảo vệ hai module này ở CI hiện tại. |

---

## 1. Problem (trích nguyên văn ý owner)

> "quản lý banner và bộ sưu tập chưa hoạt động production chuẩn để cập nhật đó trên bộ sưu tập và hình người trên production trang chủ và admin quản lý tập trung chuẩn verify hoàn thiện chuẩn đồng bộ hoàn chỉnh."
> "Bộ sưu tập thì có thể điều chỉnh ảnh bìa bộ sưu tập, các combo set đó load lên trang bộ sưu tập, và nội dung nhỏ đều có thể thay đổi được theo bố cục chuẩn"
> "tách riêng 5 người mẫu trên trang giao diện trang chủ (giữ nguyên bố cục và chuyển động như vậy, chỉ cần check verify đúng người đã xóa nền, đúng yêu cầu ảnh người mẫu, với tên bộ sưu tập cho riêng 5 người mẫu trên nền chuẩn)"
> "Bộ sưu tập thì configure: ẢNH BỘ SƯU TẬP (cover), tên bộ sưu tập, mô tả ngắn, mô tả bên hông chi tiết, và các card sản phẩm (combo/set) của bộ sưu tập; production verify từng yêu cầu."

Triệu chứng nhìn thấy:
1. Admin tab Banner: card đầu (Timeless Elegance) ảnh đen/vỡ; mỗi card có một hộp xanh lá rỗng đè lên ảnh; footer `Hiển thị 0 - 0 / 0 bài viết` sai ngữ cảnh.
2. Admin tab Bộ sưu tập: không có chỗ sửa ảnh bìa, mô tả ngắn, nút CTA, tiêu đề cụm card, danh sách combo.
3. Trang chủ: 5 người mẫu lấy từ `models[0]` của 5 collection → trùng người (§2.3); tên pill/link gắn với collection, không tách riêng.
4. `/collections`: card "Những thiết kế nổi bật" lấy sản phẩm đoán mò, không điều khiển được; ảnh bìa không xuất hiện.

---

## 2. Current behavior (bằng chứng)

### 2.1 Schema & API
- `database/migrations/127_banners_and_collections_management.sql`: bảng `banners` (placement VARCHAR(50) **không có CHECK**, `media_type` CHECK image/video, `media_url TEXT NOT NULL`, `poster_url`, `metadata JSONB`), bảng `collections` (`collection_id`, `code UNIQUE`, `name`, `label NOT NULL`, `banner_url`, `decor_url`, `home_story`, `col_number`, `script`, `hero_gradient`, `badge`, `kicker`, `story_headline`, `story_desc`, `story_paragraphs JSONB`, `explore_cta`, `category_link`, `products_sub`, `products_title`, `closing_quote`, `quote`, `models JSONB`, `styling_metadata JSONB`, `is_active`, `sort_order`). Migration **không có RLS/GRANT** [V: grep rỗng]; truy cập qua service key của API. Migration mới nhất trong repo: `131_exchange_order_handover_syncs_return.sql`.
- `apps/api/src/collections/collection-repository.ts:4` `COLLECTION_SELECT` liệt kê 27 cột; `listCollections` `order: "sort_order.asc,created_at.asc"` (:19-20); `updateCollection` (:76-…) ánh xạ từng field rõ ràng (whitelist).
- `apps/api/src/collections/collection-service.ts`: `createCollection` (:34) chỉ kiểm `name`, `code`, `story_desc` rỗng + code trùng (409); `updateCollection` (:60) **không validate gì** ngoài trùng `code` — không kiểm độ dài, URL, `category_link`, `hero_gradient`, `models`.
- `apps/api/src/collections/collection-router.ts:17-26` public `GET /api/v1/collections` và `/api/content/collections` → `listPublicCollections()` (chỉ `is_active=true`); admin CRUD tại `/api/v1/admin/collections` và `/api/v1/admin/content/collections[/:id]` (:28-…).
- Banner: `apps/api/src/banners/banner-service.ts:5` `VALID_PLACEMENTS = ["home_hero","products_hero","collections_hero"]`; create kiểm `TITLE_REQUIRED`, `MEDIA_URL_REQUIRED`, `INVALID_PLACEMENT`.
- **Phân quyền**: `server.ts:419-420` chỉ `requireAdmin(context)` cho mọi `/api/v1/admin/*` rồi `mutationLimiter` (:422). `banner-router.ts`/`collection-router.ts`/`media-upload.ts` **không gọi `requirePermission(context,"content",…)`** [V: grep]. Trong khi `rbac.ts:7-9` `rolePages` chỉ cho `super_admin` trang `content`, `roleModules` (`rbac.ts:19-28`) chỉ `super_admin: ["*"]` có module này, capability `content: ["create","update"]` (`rbac.ts:56`); UI admin gate bằng `session.can('read'|'create'|'update','content')` (`admin-erp-content.page.ts:224-226`). → **mọi role admin khác** (`admin_operator_*`, `admin_viewer`) qua được `requireAdmin` và gọi trực tiếp API CRUD banner/collection/upload dù UI ẩn trang. Lỗ hổng RBAC [INF về khả năng khai thác thực tế, chưa gọi thử bằng token operator]; xem FR-S1.
- Upload: `apps/api/src/content/media-upload.ts:26-37` route `POST /api/v1/admin/content/upload-media?category=` (và `/admin/upload/media`); `category` ∈ `banner`→prefix `banners`, `collection`→`collections`, còn lại `cms-media`. `ALLOWED_MEDIA_TYPES = IMAGE_MIME_TYPES ∪ VIDEO_MIME_TYPES` (:13) → **cả ảnh `collection` cũng nhận video**; ảnh ≤ 10MB (`storage.ts:12 MAX_IMAGE_BYTES`), video ≤ 50MB (:13). **Không kiểm kích thước pixel, không kiểm alpha** → không có gì bảo đảm "đã xóa nền". `sharp ^0.35.5` đã có trong `apps/api/package.json:14` (đang dùng ở `products/product-ai-studio.ts:5`).

### 2.2 Admin — field nào sửa được (tab Bộ sưu tập)
Form modal `admin-erp-content.page.html:926-1190`. Handler field: `onCollectionField('code'|'name'|'label'|'col_number'|'script'|'badge'|'kicker'|'story_headline'|'story_desc'|'category_link'|'closing_quote'|'hero_gradient'|'sort_order'|'is_active')` + upload/xóa ảnh `models` (`onCollectionModelUploaded` ts:732, `removeCollectionModel` ts:756).

| Field | Sửa được ở admin? | Render ở storefront? |
|---|---|---|
| `banner_url` (ảnh bìa) | **KHÔNG** có input (grep `banner_url` trong html/ts admin: 0) | **KHÔNG** (grep `lookbook.banner`: 0). Chỉ được seed |
| `home_story` (mô tả ngắn) | KHÔNG | Chỉ fallback chết ở `home.page.ts:274` (`col.storyDesc || col.homeStory`) |
| `explore_cta` | KHÔNG (chỉ default `ts:638`) | Có (`collections.page.html:64`) |
| `products_sub`, `products_title` | KHÔNG (default `ts:640-641`) | Có (`html:73-74`) |
| `quote` | KHÔNG (html:1080 chỉ đọc `closing_quote || quote`) | Không |
| `decor_url`, `story_paragraphs`, `styling_metadata` | KHÔNG | Không (không có trong view) |
| `label` | Có | **Không** render |
| `name`, `script`, `col_number`, `badge`, `kicker`, `story_headline`, `story_desc`, `category_link`, `closing_quote`, `hero_gradient`, `is_active`, `sort_order`, `models` | Có | Có |
| Danh sách combo/set | **KHÔNG có UI** | Đoán mò, §2.4 |
| 5 người mẫu trang chủ | **KHÔNG có UI riêng** (suy ra từ `models[0]`) | §2.3 |

`AdminCollectionRow` (`core/admin-erp-api.service.ts:26-51`) không có `styling_metadata` và sẽ cần các cột mới (§5).

### 2.3 Trang chủ — 5 người mẫu
- `features/home/home.page.ts:31` `HERO_LOOKS` (tĩnh, 5 phần tử, id `soft-ceremony`, `weekend-escape`, `in-bloom`, `urban-rhythm`, `midnight-mirage`; ảnh `model_cutout_1..5.png` theo thứ tự) là seed/fallback; `heroLooks = signal(HERO_LOOKS)` (:137).
- `loadHome()` (:247) gọi `catalog.getCollections()`; **nếu `collections.length >= 3`** (:259) lấy `slice(0, 5)` (:261) → map: `image = col.models[0]` (fallback `model_cutout_${(idx%5)+1}.png`), `title = col.storyHeadline`, `eyebrow` **cố định `'VELURA'`**, `season = colNumber`, `description = storyDesc || homeStory`, `looksCount = col.kicker`, `link = col.categoryLink` (:269-281).
- **Dữ liệu production** `GET /api/v1/collections` (probe 2026-11-17): `models[0]` của 5 collection theo `sort_order` = `model_cutout_1, _1, _1, _5, _2` ⇒ **trang chủ hiển thị `model_cutout_1.png` 3 lần** (Soft Ceremony, The Urban Rhythm, Weekend Escape) [V]. Đây là lỗi "đúng người" owner thấy.
- Hệ quả khác: deactivate/đổi `sort_order` một collection làm mất/đổi người mẫu trang chủ (ghép cứng 1-1); >5 collection active thì collection thứ 6+ bị bỏ im lặng; 3-4 collection → runway 3-4 người (CSS có đủ vị trí `is-left-2…is-right-2`, `_home.css`, nhưng "center = index 2" `home.page.ts:138` không còn đối xứng).
- Quan sát lệch: ảnh chụp owner có pill `The Urban Rhythm` ở trạng thái hiển thị đầu, trong khi code với dữ liệu live khởi tạo `activeModelIndex = 2` ⇒ `weekend-escape` [INF: bundle deploy khác nhánh này hoặc owner đã bấm]. Verify ở §9 V-6 trên bản deploy sau khi build.
- Ảnh cutout (`/assets/images/models/model_cutout_1..5.png` trên storefront): đều RGBA 768×1376, 4 góc alpha = 0, 67-79% pixel trong suốt [V, probe PIL] ⇒ **5 file hiện có đạt chuẩn "đã xóa nền"**. `model_main.png` (auth) 279×492 cũng RGBA.

### 2.4 Trang `/collections`
- `features/collections/collections.page.ts:29-60` `groups`: (1) `row.collection === lookbook.name` — **không lọc `is_combo`**; (2) nếu rỗng thì lọc theo `categoryLink.includes(category_slug)` + bảng điều kiện hard-code theo id `soft-ceremony`/`the-urban-rhythm`/…(:38-45); (3) `allProducts.slice(index*3, index*3+5)` (:48); (4) `slice(0,5)` (:51); rồi `items.slice(0,5)`. Thứ tự = thứ tự API.
- Production `GET /api/user/products` (60 s probe): `collection` × `is_combo` × `status` = `Soft Ceremony` combo 5; `The Afterglow` combo 5; `Midnight Mirage` combo 5; `The Urban Rhythm` combo 5 + **không-combo 17**; `Weekend Escape` combo 5 + **không-combo 27 on_sale + 1 out_of_stock**; `Velura Atelier`/`(để trống)` 2+2 [V]. ⇒ Với Urban Rhythm/Weekend Escape, 5 card hiển thị là 5 phần tử đầu *bất kỳ* của 22/33 sản phẩm, **không phải combo/set**. Soft Ceremony/Afterglow/Midnight hiển thị đúng chỉ vì vừa đủ 5 combo.
- Admin product editor cho sửa `collection` là text tự do (`features/products/product-editor.component.html:58-60`); đổi tên bộ sưu tập ở CMS **không** cập nhật `product.collection` → liên kết ngầm vỡ im lặng.
- Hero: `collections.page.html:41-60` nền `heroGradient` + `<span class="collection-hero__script">` (script, vd `in bloom`) + 5 `<img class="collection-model model-N">` lấy `lookbook.models[i]` fallback `model_cutout_{i}` (`getModelCutout`, ts:86-95) + `colNumber` + `name`. **Không có `<img>` ảnh bìa.**
- Cột chuyện: `kicker`, `storyHeadline`, `storyDesc`, link `categoryLink`/`exploreCta` (:60-65); cột sản phẩm: `productsSub`, `productsTitle`, cards (nút "Mua ngay"/"Chi tiết"), `closingQuote` (:73-120). Style desktop 5 cột (`_collections.css:340-344`), mobile 2 cột (:578).
- Khi API lỗi/rỗng: dùng `COLLECTION_LOOKBOOKS` tĩnh (`core/models/collection-lookbook.ts:60`), `catalog.service.ts` `getCollections()` catch → `of(COLLECTION_LOOKBOOKS)` (fallback im lặng, không báo lỗi).
- Caching: public collections không đặt `Cache-Control` (Cloudflare `cf-cache-status: DYNAMIC`, probe) [V]; `/api/user/products` `no-store` (`user/products.ts:37`). Storefront không có service worker (không có `ngsw-config.json`) [V]. **Không phát hiện lỗi cache phía API**. Rủi ro còn lại: file ảnh upload trùng tên bị CDN giữ — storage dùng tên duy nhất (`storage.ts:95 storageName`) nên URL đổi mỗi lần upload [V].

### 2.5 Admin tab Banner — ba lỗi hiển thị
Template `admin-erp-content.page.html:121-163` (card), SCSS `admin-erp-content.page.scss:863-915`.
1. **Hộp xanh rỗng đè ảnh**: `<span class="blog-card__status" [class.is-published]="b.is_active" style="position:absolute; bottom:8px; right:8px;">` (html:135). SCSS `.blog-card__status` đã có `position:absolute; top:10px; right:10px` (scss:898-902) và `.is-published` nền `#e8f5e9` (:909). Inline `bottom:8px` + SCSS `top:10px` ⇒ hộp bị **kéo giãn gần hết chiều cao 160px** của khối media, che ảnh; chữ `Đang bật` nằm góc trên nên nhìn như hộp xanh rỗng [INF cho phần "chữ nhỏ không thấy", cơ chế stretch là [V] từ hai khai báo xung đột].
2. **Ảnh đen/vỡ**: card 1 là `media_type='video'`, `media_url='/assets/videos/hero-bg.mp4'` (48 MB), `poster_url='/assets/images/auth/model_main.png'` [V, admin API]. Template render `<video [src] muted playsinline [poster]>` (html:124-125) trong khối `background:#1a1416`. `model_main.png` là **PNG trong suốt** (alpha 66%) ⇒ poster hiện như vệt tối trên nền #1a1416, còn video không tự phát/không `preload` ⇒ khung đen [INF]. Hai file `/assets/videos/hero-bg.mp4` và `/assets/images/auth/model_main.png` trả 200 trên `admin.royalai.dev` [V]; nhưng `https://admin.royalai.dev/assets/images/models/model_cutout_1.png` trả **404** [V] — mọi URL tương đối `/assets/...` đang được trình duyệt giải theo origin **admin**, không phải storefront (đồng thời `onModelImgError` hard-code `https://velura.royalai.dev`, ts:769). Bản repo có copy trong `apps/admin-erp-ng/public/assets/images/models/` (KAN-109) nhưng bản deploy production chưa có ⇒ ảnh thumbnail strip vỡ trên admin [V cho 404; không biết lúc nào deploy].
3. **Chọn video vs ảnh trong list**: không nên nhúng `<video>` 48MB trong lưới card (tốn băng thông, đen khi chưa decode).
- Banner thật (production): 1) `Timeless Elegance` video `link_url=/collections`; 2-3) ảnh jsdelivr `.../velura_The-Afterglow_cover.png`, `.../velura-urban-rythm_cover.png`. Hai ảnh này nằm trên repo GitHub bên thứ ba qua `cdn.jsdelivr.net` (1.8-1.9 MB mỗi cái) — phụ thuộc ngoài, không do admin upload.

### 2.6 Footer sai `Hiển thị 0 - 0 / 0 bài viết`
`admin-erp-content.page.html:299` `<app-erp-pagination … [label]="rangeLabel()">` nằm **sau** chuỗi `@if (tab()==='banners') … @else if collections … @else if subscribers … @else`, ngoài mọi nhánh ⇒ render trên cả tab `banners`/`collections`. `rangeLabel` (`ts:243-244`) = `adminRangeLabel(this.total(), …, tab==='subscribers' ? 'người đăng ký' : 'bài viết')`; `total` là tổng bài viết (=0 vì tab banner không `reload()`), `adminRangeLabel` (`admin-erp-http.ts:192`) trả `Hiển thị 0 - 0 / 0 bài viết` khi total=0. Ngoài ra `setTab` (ts:459) gọi `loadBanners()`/`loadCollectionsList()` mà không đặt lại `total`.
Quan sát phụ (ngoài phạm vi, chỉ ghi): 4 KPI card đầu trang (`html:32-36`) cũng là số bài viết/đăng ký và hiện trên tab Banner/Bộ sưu tập.

---

## 3. Requirements

### 3.A Collection — contract chỉnh sửa end-to-end
- **FR-1 (Ảnh bìa)**: Admin upload/thay/xóa ảnh bìa (`banner_url`) với preview. Storefront `/collections` render ảnh bìa khi `hero_mode='cover'` (full-bleed `object-fit: cover`; vẫn hiện `col_number`, `name`, `script`; **không render** 5 cutout). Khi `hero_mode='models'` hoặc `banner_url` rỗng: bố cục hiện tại (gradient + 5 cutout). `hero_mode='cover'` mà `banner_url` rỗng ⇒ API từ chối 400 `COVER_REQUIRED`.
- **FR-2 (Tên)**: `name` sửa được, 1-80 ký tự, hiển thị trên hero `/collections`, tab lọc, pill trang chủ. Đổi tên **không** được làm vỡ liên kết combo (liên kết đi theo `product_ids`, không theo tên — FR-5).
- **FR-3 (Mô tả ngắn)**: `home_story`, tùy chọn, ≤ 160 ký tự. Render: (a) mô tả dưới tên ở hero trang chủ, (b) một dòng lede `<p class="collection-hero__lede">` dưới `name` trong hero `/collections`. Rỗng ⇒ trang chủ dùng `story_desc` cắt 160 ký tự (ellipsis), `/collections` ẩn lede.
- **FR-4 (Mô tả bên hông chi tiết)**: `story_desc` (bắt buộc, 1-600 ký tự, giữ xuống dòng `white-space: pre-line`) render ở cột chuyện bên hông; cùng nhóm sửa được: `kicker` (≤60), `story_headline` (≤120), `explore_cta` (≤40), `category_link` (CTA đích), `products_sub` (≤40), `products_title` (≤80), `closing_quote` (≤200), `script` (≤40), `col_number` (≤60), `badge` (≤30), `hero_gradient`.
- **FR-5 (Combo/set)**: Admin chọn tối đa **10** sản phẩm `is_combo=true`, sắp xếp được, lưu vào `product_ids`. Storefront hiển thị đúng danh sách theo thứ tự đó (ánh xạ qua `product_id` với `GET /api/user/products`), lọc bỏ sản phẩm không còn trong catalog; **xóa toàn bộ fallback đoán mò** (§2.4 mục 2-4). Danh sách rỗng ⇒ empty-state sẵn có (`collections.page.html:77-81`) + link `categoryLink`.
- **FR-6 (5 người mẫu hero `/collections`)**: giữ `models[]` đúng 5 ảnh (khi `hero_mode='models'`); admin upload/xóa/sắp xếp từng ô 1-5 với preview thực tế. Lưu <5 ảnh được (bản nháp) nhưng `is_active=true` + `hero_mode='models'` yêu cầu đủ 5 (`MODELS_REQUIRED`).
- **FR-7 (Kích hoạt/thứ tự)**: `is_active`, `sort_order` giữ nguyên ý nghĩa; storefront `/collections` sắp theo `sort_order.asc,created_at.asc` (đã là thứ tự API).

### 3.B Trang chủ — 5 người mẫu tách riêng (giữ nguyên bố cục + chuyển động)
- **FR-8**: Mỗi collection có `home_model_url` (ảnh cutout riêng cho trang chủ), `show_on_home` (bool), `home_sort_order` (int). Runway trang chủ = các collection `is_active AND show_on_home AND home_model_url<>''`, sắp theo `home_sort_order.asc, sort_order.asc`, lấy **đúng 5**.
- **FR-9**: Mỗi người mẫu mang **tên bộ sưu tập của chính nó** (`look.collectionName = name`, pill `.runway-model … <span>{{look.collectionName}}</span>` html:139) và link `category_link`. Văn bản hero giữ mapping hiện có (`title=story_headline`, `season=col_number`, `badge`, `looksCount=kicker`, `description = home_story || story_desc`); **`eyebrow` 'VELURA' giữ hằng số** (thương hiệu, không phải nội dung CMS).
- **FR-10**: Chỉ khi có đúng 5 phần tử hợp lệ mới thay `HERO_LOOKS` (bỏ ngưỡng `>= 3`). Khác 5 (kể cả API lỗi/rỗng) ⇒ giữ `HERO_LOOKS` tĩnh và admin hiển thị cảnh báo (FR-14). Bố cục/animation/CSS runway **không đổi** (không đụng `_home.css`, `home-carousel.ts`, `HERO_LOOKS` shape).
- **FR-11 (Chuẩn ảnh người mẫu — "đã xóa nền")**: upload cho `home_model_url` và `models[i]` đi qua category `collection-model` với validate server (sharp): PNG hoặc WebP; có kênh alpha; 4 góc ảnh alpha ≤ 10/255; ≥ 15% pixel trong suốt (nền đã xóa) **và** ≥ 5% pixel đục (có người); rộng ≥ 600px; tỉ lệ cao/rộng ∈ [1.2, 2.4]; ≤ 10 MB. Vi phạm ⇒ 422 với mã `MODEL_ALPHA_REQUIRED` / `MODEL_DIMENSIONS_INVALID` / `MODEL_FORMAT_INVALID` kèm thông điệp tiếng Việt. (5 cutout hiện có đều đạt: alpha-góc 0, trong suốt 67-79%, 768×1376.)
- **FR-12 (Ràng buộc 5 slot)**: lưu collection với `show_on_home=true` làm số collection (`is_active ∧ show_on_home`) > 5 ⇒ 409 `HOME_SLOTS_FULL`. `show_on_home=true` mà `home_model_url` rỗng ⇒ 400 `HOME_MODEL_REQUIRED`. `home_sort_order` trùng nhau được (tie-break `sort_order`).
- **FR-13 (Backfill)**: migration điền để giữ giao diện tĩnh gốc và hết trùng người: `soft-ceremony`→`model_cutout_1.png` (order 0), `weekend-escape`→`_2` (1), `the-afterglow`→`_3` (2, tâm), `the-urban-rhythm`→`_4` (3), `midnight-mirage`→`_5` (4); `show_on_home=true` cho cả năm. Mapping này lấy từ `HERO_LOOKS` (`home.page.ts:31-70`: id→ảnh).
- **FR-14 (Cảnh báo admin)**: trên tab Bộ sưu tập hiện chip "Trang chủ: n/5 người mẫu" (xanh khi =5, vàng khác 5) + liệt kê collection thiếu `home_model_url`.

### 3.C Banner
- **FR-15**: Placement chỉ còn `products_hero` (D5). API từ chối placement khác (`INVALID_PLACEMENT`); admin select placement bị gỡ (cố định), bộ lọc placement bị gỡ.
- **FR-16**: Card banner admin: không còn hộp xanh xuyên ảnh; badge `Đang bật`/`Tắt` dùng `app-erp-status-badge` (`label`, `tone`) trong thân card (mẫu: `admin-erp-promotions.page.html:273`); khối media **không** nhúng `<video>`: video hiển thị `poster_url` (hoặc placeholder "Chưa có ảnh poster") + nhãn VIDEO; ảnh hiển thị `<img>`; nền khối media sáng trung tính (không #1a1416) để PNG trong suốt vẫn đọc được; lỗi tải ảnh ⇒ placeholder, không khung đen.
- **FR-17**: Mọi URL tương đối `/assets/...` của dữ liệu CMS trong admin được giải theo **origin storefront** qua một hàm thuần duy nhất `resolveStorefrontAsset(url)` (thêm `storefrontUrl` vào `environment*.ts`), thay mọi chỗ `src="/assets/..."` thô và hard-code `velura.royalai.dev` (ts:769). URL `http(s)://` và `data:` giữ nguyên.
- **FR-18**: Khi người dùng đang ở tab Banner/Bộ sưu tập, **không** hiển thị `app-erp-pagination` (footer `Hiển thị … bài viết`). Tab khác không đổi. KPI card bài viết: giữ nguyên (ngoài phạm vi).
- **FR-19**: Form banner validate: `title` 1-120, `subtitle` ≤240, `button_text` ≤40, `link_url` rỗng hoặc bắt đầu bằng `/` (không `//`) hoặc `https://`; `media_url` bắt buộc (đã có); `poster_url` rỗng/URL hợp lệ; `sort_order` nguyên ≥ 0. Server áp cùng luật (`INVALID_LINK_URL`, `FIELD_TOO_LONG`).

### 3.D Bảo mật / upload / quyền
- **FR-S1 (RBAC)**: Thêm `requirePermission(context, "content", action)` (`rbac.ts:323`) trong `banner-router.ts` và `collection-router.ts` cho nhánh admin (GET→`read`; POST→`create`; PUT/PATCH→`update`; DELETE→`update` — vì `content: ["create","update"]` (`rbac.ts:56`) **không có capability `delete`**), và trong `handleAdminMediaUpload` (`create`). Test `tests/api/` xác nhận `admin_operator_sanpham` và `admin_viewer` bị 403 `RBAC_DENIED` khi ghi, `super_admin` được. *Rủi ro*: hiện chỉ `super_admin` có module `content` nên không role hợp lệ nào bị chặn nhầm; nhưng nếu runbook vận hành dùng token operator gọi API trực tiếp thì sẽ gãy — xác nhận trước khi merge.
- **FR-S2 (Upload categories)**: `category` hợp lệ: `banner`, `collection-cover`, `collection-model`, `media` (mặc định, giữ nguyên cho blog). `collection` cũ bị gỡ (cutover sạch: sửa `uploadCmsMedia` + mọi caller). Video chỉ hợp lệ với `banner`; `collection-*` nhận ảnh. Prefix lưu: `banners`, `collections/covers`, `collections/models`. `collection-cover`: JPEG/PNG/WebP, rộng ≥ 1280px, tỉ lệ rộng/cao ∈ [1.5, 2.4], ≤ 10 MB (cover live 1672×941 = 1.78 đạt). Category lạ ⇒ 400 `INVALID_UPLOAD_CATEGORY`.
- **FR-S3 (URL ảnh được lưu)**: `banner_url`, `home_model_url`, `models[i]`, `poster_url`, `media_url` phải là: `https://…` (bất kỳ host — hiện tại có `cdn.jsdelivr.net`) hoặc đường dẫn bắt đầu `/assets/`; chặn `javascript:`, `data:`, `//host`. Tối đa 500 ký tự.

---

## 4. Edge cases & failure modes

| # | Tình huống | Hành vi bắt buộc |
|---|---|---|
| E1 | Collection `show_on_home` bị tắt/`is_active=false` khiến còn 4 | Trang chủ giữ `HERO_LOOKS` tĩnh; admin chip vàng "4/5". Không render 4 người. |
| E2 | `home_model_url` 404 (file bị xóa trong storage) | `onModelImgError` (home.page.ts:235) hiện fallback `model_cutout_1.png` ⇒ trùng người. Đổi fallback thành `model_cutout_{index+1}.png` theo vị trí (cần truyền index); không thay đổi `HeroLook`. |
| E3 | Hai collection dùng chung một `home_model_url` | Cho phép (không unique); chip cảnh báo vàng "ảnh trùng" ở admin; không chặn lưu (đã từng có dữ liệu như vậy). |
| E4 | `product_ids` chứa sản phẩm đã xóa/ẩn/không phải combo nữa | Lưu: service re-validate toàn bộ id (tồn tại + `is_combo`) ⇒ 400 `PRODUCT_NOT_COMBO` / `PRODUCT_NOT_FOUND` (không lọc im lặng). Đọc: storefront bỏ id không có trong catalog; không báo lỗi. |
| E5 | Sản phẩm combo hết hàng | Vẫn hiển thị, nút "Mua ngay" khóa như `isOutOfStock` hiện có (`collections.page.ts:120`). |
| E6 | `product_ids` trùng id | Service dedupe giữ thứ tự xuất hiện đầu. |
| E7 | Đổi `code` sau khi tạo | **Cấm** (`code` read-only trong form khi sửa; API `CODE_IMMUTABLE` 400) vì `code` là anchor `#id` và key `track`. Đổi tên dùng `name`. |
| E8 | Xóa collection đang `show_on_home` | `DELETE` thành công; chip cảnh báo cập nhật; trang chủ về `HERO_LOOKS` nếu còn ≠5. Admin hỏi xác nhận (đã có `confirm`). Xóa không cascade product. |
| E9 | Upload 2 file song song / mất mạng giữa chừng | Mỗi ô upload có state riêng (`uploading` theo ô), lỗi hiển thị cạnh ô, `finalize` luôn tắt spinner; không ghi `models[]` khi lỗi. |
| E10 | Ảnh upload có alpha nhưng không phải người (PNG logo) | Validator không phát hiện được — chấp nhận; ghi nhận rủi ro R2. |
| E11 | WebP/PNG trong suốt nhưng góc có viền mờ (anti-alias) | Ngưỡng góc ≤ 10/255 + lấy mẫu vùng 4×4 px ở mỗi góc (không chỉ 1 pixel). |
| E12 | API collections lỗi/rỗng | Storefront dùng `COLLECTION_LOOKBOOKS` (hiện hành) nhưng **không còn** fallback sản phẩm đoán mò; `/collections` hiển thị empty-state cho cụm combo. |
| E13 | Banner `products_hero` rỗng sau khi tắt hết | `product-list.page.ts:695-703` giữ `DEFAULT_HERO_BANNERS` tĩnh (`Timeless Elegance`) — hành vi giữ nguyên; admin hiển thị ghi chú "Không có banner bật → trang sản phẩm dùng banner mặc định". |
| E14 | Banner video 48 MB | Không tải trong admin list (FR-16). Storefront giữ nguyên. |
| E15 | Hai admin sửa cùng collection | Last-write-wins (không có `version` cột) — chấp nhận, ghi R5. |
| E16 | Migration chạy trên production | Production read-only theo mặc định (`scripts/run-migrations.mjs` yêu cầu `--environment=production --owner-approved-production <số>`; xem `tests/api/migration-owner-approval.test.ts`). Cần owner phê duyệt; xem R1. |
| E17 | Dev/test không có cột mới (migration chưa chạy) | Repo chọn cột mới ⇒ PostgREST 400 ⇒ API 5xx cho `/api/v1/collections`; `catalog.service.ts:60` `getCollections()` catch ⇒ storefront dùng `COLLECTION_LOOKBOOKS`/`HERO_LOOKS` tĩnh; không crash. |

---

## 5. Data / API contract (chính xác)

### 5.1 Migration `database/migrations/132_collections_cms_production_fields.sql`
(Kiểm số trống ngay trước khi tạo: `ls database/migrations | sort | tail -3` — spec song song `ux-flow-fixes-orders-returns-payments.md` có thể dùng 132+; nếu trùng, lấy số kế tiếp và cập nhật tên file/Task T1.)

```sql
-- KAN-116: collection cover mode, separate homepage runway model, explicit combo list.
begin;
alter table public.collections
  add column if not exists hero_mode        varchar(10) not null default 'models'
    check (hero_mode in ('models','cover')),
  add column if not exists home_model_url   text,
  add column if not exists show_on_home     boolean not null default false,
  add column if not exists home_sort_order  integer not null default 0,
  add column if not exists product_ids      uuid[] not null default '{}';

-- Backfill homepage runway from HERO_LOOKS (apps/user-ng/.../home.page.ts:31): distinct cutouts, centre = the-afterglow.
update public.collections set home_model_url='/assets/images/models/model_cutout_1.png', show_on_home=true, home_sort_order=0 where code='soft-ceremony'    and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_2.png', show_on_home=true, home_sort_order=1 where code='weekend-escape'   and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_3.png', show_on_home=true, home_sort_order=2 where code='the-afterglow'    and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_4.png', show_on_home=true, home_sort_order=3 where code='the-urban-rhythm' and home_model_url is null;
update public.collections set home_model_url='/assets/images/models/model_cutout_5.png', show_on_home=true, home_sort_order=4 where code='midnight-mirage'  and home_model_url is null;

-- Backfill combo list from today's implicit match (collection name + is_combo + on_sale), max 10, stable order by sku.
update public.collections c
   set product_ids = coalesce((
         select array_agg(x.product_id order by x.sku)
           from (select p.product_id, p.sku
                   from public.product p
                  where p.collection = c.name and p.is_combo = true and p.status = 'on_sale'
                  order by p.sku limit 10) x), '{}')
 where c.product_ids = '{}';
commit;
```
Không thêm RLS (đồng bộ với 127). Không đụng `product.collection`. Bảng `banners`: **không đổi schema**.

### 5.2 Public `GET /api/v1/collections` (và alias `/api/content/collections`)
Response `{ success: true, data: Collection[] }`. `Collection` (`apps/api/src/collections/collection-types.ts:3`) thêm:
```ts
hero_mode: "models" | "cover";
home_model_url: string | null;
show_on_home: boolean;
home_sort_order: number;
product_ids: string[];          // thứ tự hiển thị; chỉ id, không nhúng sản phẩm
```
`COLLECTION_SELECT` (`collection-repository.ts:4`) thêm 5 cột. Không đổi path/method/Cache-Control.

### 5.3 Admin `POST/PUT /api/v1/admin/(content/)collections[/:id]`
`CreateCollectionInput` / `UpdateCollectionInput` (`collection-types.ts:33`, `:60`) thêm cùng 5 trường (tùy chọn khi update). Validation (service, mã lỗi `HttpError(400|409|422, code, VN message)`):

| Trường | Luật | Mã lỗi |
|---|---|---|
| `name` | trim, 1-80 | `NAME_REQUIRED` / `FIELD_TOO_LONG` |
| `code` | tạo: `^[a-z0-9]+(-[a-z0-9]+)*$` sau chuẩn hóa hiện có, ≤60; sửa: không đổi | `CODE_REQUIRED`, `CODE_INVALID`, `CODE_ALREADY_EXISTS` (409), `CODE_IMMUTABLE` |
| `story_desc` | trim, 1-600 | `STORY_DESC_REQUIRED` |
| `home_story` | ≤160 hoặc null | `FIELD_TOO_LONG` |
| `kicker` ≤60, `story_headline` ≤120, `explore_cta` ≤40, `products_sub` ≤40, `products_title` ≤80, `closing_quote` ≤200, `script` ≤40, `col_number` ≤60, `badge` ≤30 | độ dài | `FIELD_TOO_LONG` |
| `category_link` | bắt đầu `/` (không `//`) hoặc `https://`; ≤500 | `INVALID_LINK_URL` |
| `hero_gradient` | khớp `^linear-gradient\([^;{}]{1,300}\)$` | `INVALID_GRADIENT` |
| `banner_url`, `home_model_url`, `models[i]` | FR-S3; `models.length ≤ 5` | `INVALID_MEDIA_URL`, `MODELS_TOO_MANY` |
| `hero_mode='cover'` | cần `banner_url` | `COVER_REQUIRED` |
| `is_active=true ∧ hero_mode='models'` | cần `models.length===5` | `MODELS_REQUIRED` |
| `show_on_home=true` | cần `home_model_url`; tổng (`is_active ∧ show_on_home`) ≤ 5 (loại chính nó) | `HOME_MODEL_REQUIRED`, `HOME_SLOTS_FULL` (409) |
| `product_ids` | mảng uuid, ≤10, dedupe; mỗi id tồn tại và `is_combo=true` (một truy vấn `selectRows("product", {product_id:"in.(…)", select:"product_id,is_combo"})`) | `PRODUCT_IDS_INVALID`, `PRODUCT_NOT_FOUND`, `PRODUCT_NOT_COMBO` |
| `sort_order`, `home_sort_order` | nguyên 0-9999 | `INVALID_SORT_ORDER` |
| `label` | optional; trống ⇒ `= name` (cột NOT NULL) | — |

`updateCollection` phải **validate trên bản ghép** (record hiện có + patch) để các luật chéo (`COVER_REQUIRED`, `MODELS_REQUIRED`, `HOME_*`) đúng khi patch từng phần. Validate nằm trong `collection-service.ts` (router → service → repository); repository chỉ ánh xạ cột (thêm 5 cột vào `updateCollection` và `createCollection`, :76-…).
Service nhận thêm phụ thuộc đọc sản phẩm: thêm `findComboProductIds(ids: string[]): Promise<Map<string, boolean>>` vào `CollectionRepository` (không import `product-repository` vào service).

### 5.4 Banner (`apps/api/src/banners`)
- `BannerPlacement = "products_hero"` (`banner-types.ts:3`); `VALID_PLACEMENTS = ["products_hero"]` (`banner-service.ts:5`). Migration không cần (cột không có CHECK; dữ liệu live toàn `products_hero` [V]). Nếu có hàng placement khác ở môi trường khác: `listPublicBanners` chỉ lọc theo placement truy vấn nên vô hại.
- Thêm validation FR-19 vào `createBanner`/`updateBanner` (mã `INVALID_LINK_URL`, `FIELD_TOO_LONG`, `INVALID_MEDIA_URL`).
- Client types: `apps/admin-erp-ng/src/app/core/admin-erp-api.service.ts:8` `AdminBannerRow.placement: 'products_hero'`; `apps/user-ng/src/app/core/models/banner.interface.ts:1` `BannerPlacement = 'products_hero'`.

### 5.5 Upload `POST /api/v1/admin/content/upload-media?category=<banner|collection-cover|collection-model|media>`
Response đổi **không**: `{ success, url, fileName, mimeType, mediaType }`. Thêm mã lỗi 422 như FR-11/FR-S2. Validator ảnh đặt trong file mới `apps/api/src/content/media-image-rules.ts` (thuần, nhận `Buffer`, trả `{ok:true}` hoặc ném `HttpError`) để unit test không cần storage.

### 5.6 Admin client (`core/admin-erp-api.service.ts`)
- `AdminCollectionRow`: thêm `hero_mode: 'models' | 'cover'; home_model_url?: string | null; show_on_home: boolean; home_sort_order: number; product_ids: string[]` (+ giữ các field cũ).
- `uploadCmsMedia(file, category: 'banner' | 'collection-cover' | 'collection-model')` (thay `'collection'`).
- Reuse `listProducts({ isCombo: 'true', q, limit: '20', offset })` (`admin-erp-api.service.ts:2021`; server đọc `isCombo` tại `apps/api/src/products/product-service.ts:785`) cho picker combo; **không thêm endpoint mới**. Không truyền `status` (giá trị hợp lệ chưa xác minh) — lọc `status ∈ {on_sale,out_of_stock}` phía client.

### 5.7 Storefront model (`apps/user-ng/src/app/core/models/collection-lookbook.ts`)
`CollectionLookbook` (interface đầu file) thêm: `heroMode: 'models'|'cover'; homeModel: string; showOnHome: boolean; homeSortOrder: number; productIds: string[]`. `normalizeCollectionLookbook` (:26) ánh xạ snake→camel, mặc định `heroMode:'models'`, `productIds:[]`, `showOnHome:false`. `COLLECTION_LOOKBOOKS` (:60) bổ sung giá trị mặc định cho các trường mới (fallback tĩnh; `productIds: []`). Home dùng `homeModel`; `collections.page` dùng `banner`, `heroMode`, `productIds`.

---

## 6. UI behavior

### 6.1 Admin tab Bộ sưu tập
- Card (list, `html:170-232`): thumbnail = ảnh bìa nếu có, ngược lại strip 5 cutout hiện có (giữ); thêm dòng nhỏ "Trang chủ: Có/Không · Combo: n". Badge Bật/Tắt: `app-erp-status-badge`. Nút Tắt/Sửa/Xóa giữ nguyên. Chip tổng "Trang chủ n/5" (FR-14) ở header tab.
- Modal (`html:926-1190`) chia nhóm có tiêu đề (dùng cấu trúc `content-form__grid` sẵn có):
  1. **Nhận diện**: `name`* , `code`* (read-only khi sửa), `col_number`, `badge`, `script`, `is_active`, `sort_order`. (Gỡ input `label`.)
  2. **Ảnh bìa & hero** (`/collections`): radio `hero_mode` (Bố cục 5 người mẫu / Ảnh bìa); nút Tải ảnh bìa / Xóa; preview 16:9 thật (nền sáng, `object-fit: cover`); `hero_gradient` (3-4 preset hiện có + hiển thị swatch); khi `hero_mode='models'`: 5 ô người mẫu cố định (ô 1-5, mỗi ô có nút Tải/Xóa/Đổi, preview nền caro để thấy trong suốt) — thay danh sách + nút "Tải ảnh người mẫu" nối đuôi hiện nay.
  3. **Nội dung**: `home_story` (counter /160), `kicker`, `story_headline`, `story_desc`* (counter /600, textarea), `explore_cta`, `category_link`, `products_sub`, `products_title`, `closing_quote`. Mỗi input có `maxlength` và hiển thị lỗi inline `role="alert"` ngay khi blur (không chờ submit); dấu `*` đỏ theo chuẩn hiện hành (`<span class="erp-required" aria-hidden="true">*</span>`).
  4. **Combo/set của bộ sưu tập**: ô tìm combo (debounce 300ms, `isCombo=true`), kết quả có thumbnail/giá/trạng thái, nút "Thêm"; danh sách đã chọn có nút ↑ ↓ Xóa, đếm "n/10"; sản phẩm không có trong catalog hiển thị "Sản phẩm không khả dụng" kèm nút Xóa.
  5. **Trang chủ**: checkbox `show_on_home`, ô ảnh `home_model_url` (Tải/Xóa, preview nền caro), `home_sort_order`; chip live "Hiện có n/5 người mẫu trên trang chủ"; preview mini 5 vị trí runway (dùng lại khối "Mô phỏng Runway", `html:1142-1160`, nhưng lấy `home_model_url` của collection đang sửa ở đúng vị trí).
- Lưu: nút Lưu `disabled` khi có lỗi validate client hoặc đang upload/lưu; khi lưu lỗi hiện thông điệp server (mã → câu VN từ `adminErrorMessage`); đóng modal chỉ khi thành công rồi `loadCollectionsList()`.
- Mọi ảnh dùng `resolveStorefrontAsset` (FR-17).

### 6.2 Admin tab Banner
- Card theo FR-16; header tab bỏ select placement (D5); nút "Thêm banner mới" giữ; footer `Hiển thị…` ẩn (FR-18). Spinner thay chữ "Đang tải…" nếu đã có component loader dùng chung trong trang (không thêm mới).

### 6.3 Storefront trang chủ
- Không đổi markup/CSS/animation runway (`home.page.html:98-140`). Chỉ đổi nguồn dữ liệu (FR-8..10) và fallback ảnh lỗi theo vị trí (E2).

### 6.4 Storefront `/collections`
- `.collection-hero`: thêm (khi `heroMode==='cover' && banner`) `<img class="collection-hero__cover" [src]="banner" alt="" loading="lazy">` (absolute inset 0, `object-fit: cover`, z dưới `__shade`) và **không render** `.collection-model` x5; (khi `models`) như cũ. Lede `home_story` dưới `name` (`.collection-hero__lede`, 1-2 dòng, màu theo `__shade`; ẩn khi rỗng). Responsive: cover giữ `aspect-ratio` hero hiện có ở mobile (`_collections.css:560-575`).
- Cột sản phẩm: render theo `productIds` (FR-5). `cardIndex`, "Mua ngay"/"Chi tiết", empty-state, `closing_quote` giữ.
- `story_desc` thêm `white-space: pre-line`.

---

## 7. Files to change

**DB**: `database/migrations/132_collections_cms_production_fields.sql` (mới).

**API** (`apps/api/src`):
- `collections/collection-types.ts`, `collections/collection-repository.ts` (SELECT, create/update mapping, `findComboProductIds`), `collections/collection-service.ts` (validation §5.3), `collections/collection-router.ts` (RBAC).
- `banners/banner-types.ts`, `banners/banner-service.ts` (placement + FR-19), `banners/banner-router.ts` (RBAC).
- `content/media-upload.ts` (categories, rules), `content/media-image-rules.ts` (mới).
- Test: move/rewrite `apps/api/src/collections/collection-service.test.ts` → `tests/api/collection-service.test.ts`; `apps/api/src/banners/banner-service.test.ts` → `tests/api/banner-service.test.ts` (sửa import `../../apps/api/src/...js`); mới `tests/api/media-image-rules.test.ts`, `tests/api/cms-admin-rbac.test.ts`.

**Admin ERP** (`apps/admin-erp-ng/src`):
- `app/core/admin-erp-api.service.ts` (types, `uploadCmsMedia`), `app/core/admin-erp-content.ts` (+ `resolveStorefrontAsset`, validators thuần), `environments/environment.ts` & `environment.prod.ts` (`storefrontUrl`).
- `app/features/content/admin-erp-content.page.html` / `.ts` / `.scss` / `.spec.ts`.

**Storefront** (`apps/user-ng/src`):
- `app/core/models/collection-lookbook.ts`, `app/core/models/banner.interface.ts`, `app/core/services/catalog.service.ts` (không đổi nếu `normalize` đủ).
- `app/features/home/home.page.ts` (+ `home.page.spec.ts`), `app/features/collections/collections.page.{ts,html}` (+ `collections.page.spec.ts`), `styles-velura/pages/_collections.css`.

Không sửa: `_home.css`, `home-carousel.ts`, `HERO_LOOKS` shape, `product-list.page.*` ngoài kiểu `BannerPlacement`.

---

## 8. Test plan (hẹp, chỉ module này)

API (`node --import tsx --test tests/api/<file>.test.ts`):
1. `collection-service.test.ts`: tạo/sửa với mỗi luật §5.3 (mỗi mã lỗi ≥ 1 case); patch từng phần vẫn đúng luật chéo; `product_ids` dedupe + từ chối không-combo/không-tồn-tại (repo mock `findComboProductIds`); `HOME_SLOTS_FULL` khi có 5 slot active; `CODE_IMMUTABLE`; `label` tự điền; `listPublicCollections` trả field mới. (Giữ 3 test hiện có.)
2. `banner-service.test.ts`: `home_hero` ⇒ `INVALID_PLACEMENT`; `link_url` `javascript:` ⇒ `INVALID_LINK_URL`; giữ test cũ (cập nhật placement của các case dùng `home_hero`).
3. `media-image-rules.test.ts`: dùng `sharp({create:…})` tạo buffer: (a) PNG RGBA 800×1400 nền trong suốt + khối đục giữa ⇒ ok; (b) PNG RGB (không alpha) ⇒ `MODEL_ALPHA_REQUIRED`; (c) RGBA nhưng góc đục ⇒ `MODEL_ALPHA_REQUIRED`; (d) 400×700 ⇒ `MODEL_DIMENSIONS_INVALID`; (e) JPEG ⇒ `MODEL_FORMAT_INVALID`; (f) cover 1672×941 JPEG ok, 800×800 ⇒ `MODEL_DIMENSIONS_INVALID`; (g) video với category `collection-cover` ⇒ 400/415 mã được chọn trong T4.
4. `cms-admin-rbac.test.ts`: dựng `AuthContext` giả (mẫu có sẵn trong các test `tests/api/*` gọi router với context, ví dụ `tests/api/content-admin.test.ts`) — `admin_viewer` POST collection/banner/upload ⇒ 403 `RBAC_DENIED`; role có `content` ⇒ 2xx.
5. Migration: không có test DB cục bộ; thêm assert đọc file SQL (regex) kiểm tra 5 cột + `if not exists` + không `drop`.

Admin (`npm run test -w @velura/admin-erp-ng -- --watch=false`, `admin-erp-content.page.spec.ts` + spec mới cho `admin-erp-content.ts`):
6. Tab banners/collections ⇒ không có `app-erp-pagination` / không chứa text `Hiển thị`; tab all/subscribers vẫn có.
7. Card banner: không có `<video>`; có `app-erp-status-badge` (text `Đang bật`/`Tắt`); không phần tử con `.blog-card__status` có `style` chứa `bottom`.
8. `resolveStorefrontAsset`: `/assets/x.png`→`${storefrontUrl}/assets/x.png`; `https://a/b` giữ; `data:` giữ; rỗng→`''`.
9. Modal collection: không có input `label`; có upload ảnh bìa (gọi `uploadCmsMedia(file,'collection-cover')`); 5 ô người mẫu; picker gọi `listProducts` với `isCombo:'true'`; thêm/xóa/↑↓ đổi `product_ids`; `show_on_home` không có ảnh ⇒ lỗi inline và nút Lưu disabled; payload `updateCollection` chứa 5 trường mới.

Storefront (`npm run test -w @velura/user-ng -- --watch=false`):
10. `home.page.spec.ts`: 5 collection `showOnHome` hợp lệ ⇒ `heroLooks` đúng thứ tự `homeSortOrder`, ảnh = `homeModel` (5 ảnh khác nhau), `collectionName` = `name`; 4 hợp lệ ⇒ giữ `HERO_LOOKS`; 6 hợp lệ ⇒ chỉ 5 đầu theo order; collection `showOnHome` mà thiếu `homeModel` bị loại.
11. `collections.page.spec.ts`: `productIds` quyết định cards và thứ tự; sản phẩm không combo cùng `collection` name **không** xuất hiện; id không có trong catalog bị bỏ; `productIds` rỗng ⇒ empty-state; `heroMode='cover'` ⇒ có `.collection-hero__cover`, không `.collection-model`; `heroMode='models'` ⇒ 5 `.collection-model`; lede ẩn khi `homeStory` rỗng.

Production verification (sau deploy, §9 T14): xem V-1..V-9 ở dưới.

---

## 9. Task breakdown (có thứ tự, mỗi task một owner-file set; không cần quyết định thiết kế)

| ID | Việc | File chính | Phụ thuộc |
|---|---|---|---|
| T1 | Tạo migration 132 đúng §5.1 (kiểm số trống trước) | `database/migrations/132_*.sql` | — |
| T2 | `Collection`/`Create`/`Update` types + `COLLECTION_SELECT` + repo create/update mapping + `findComboProductIds` | `collections/collection-types.ts`, `collection-repository.ts` | T1 |
| T3 | Validation đầy đủ §5.3 trong service (validate trên bản ghép), `label` default, `CODE_IMMUTABLE` | `collections/collection-service.ts` | T2 |
| T4 | `media-image-rules.ts` + categories mới trong `media-upload.ts` (FR-S2, FR-11); chốt mã lỗi video-sai-category = `400 VIDEO_NOT_ALLOWED` | `content/media-*.ts` | — |
| T5 | RBAC: `requirePermission` trong 3 router (FR-S1); xác minh `roleModules` trước | `banners/banner-router.ts`, `collections/collection-router.ts`, `content/media-upload.ts` | T4 (cùng file upload) |
| T6 | Banner: placement còn `products_hero`, validation FR-19 | `banners/banner-types.ts`, `banner-service.ts` | — |
| T7 | Di chuyển + viết test API (§8 mục 1-5) | `tests/api/*.test.ts` | T2-T6 |
| T8 | Admin: types/`uploadCmsMedia`/`storefrontUrl`/`resolveStorefrontAsset`/validators thuần + spec | `core/admin-erp-api.service.ts`, `core/admin-erp-content.ts`, `environments/*` | T2 (types) |
| T9 | Admin: sửa footer (FR-18), card banner (FR-16), gỡ select placement (FR-15) | `features/content/*.html/.scss/.ts` | T6, T8 |
| T10 | Admin: modal collection nhóm 1-5 + chip n/5 + picker combo (§6.1) | `features/content/*.html/.ts/.scss` | T8, T9 |
| T11 | Admin spec §8 mục 6-9 | `admin-erp-content.page.spec.ts` | T9, T10 |
| T12 | Storefront model + `normalizeCollectionLookbook` + `COLLECTION_LOOKBOOKS` mặc định + `BannerPlacement` | `core/models/collection-lookbook.ts`, `banner.interface.ts` | T2 |
| T13 | Home: 5 người mẫu từ `showOnHome/homeModel` (FR-8..10), fallback ảnh theo vị trí (E2) + spec | `features/home/home.page.ts`, `home.page.spec.ts` | T12 |
| T14 | `/collections`: hero cover/lede, cards theo `productIds`, xóa fallback đoán mò, `pre-line` + spec | `features/collections/collections.page.{ts,html,spec.ts}`, `_collections.css` | T12 |
| T15 | Chạy: `npm run test:api` (hoặc từng file `tests/api/…`), `npm run test:admin-erp`, `npm run test:user`; `npm run build` cho admin-erp-ng và user-ng; commit `KAN-116 …` (+ `## Why`) | — | tất cả |
| T16 | Deploy theo thứ tự: (1) owner chạy migration 132 production với `--owner-approved-production 132`; (2) deploy API; (3) deploy admin + storefront; sau đó chạy §V | — | T15 |

Thứ tự deploy bắt buộc (E17): migration → API → clients. API mới chọn cột mới nên chạy trước migration sẽ làm `/api/v1/collections` 400 trên production ⇒ storefront rơi về fallback tĩnh.

---

## 10. Verification trên production (checklist "verify từng yêu cầu")

| V | Bước | Kỳ vọng |
|---|---|---|
| V-1 | `curl https://velura.royalai.dev/api/v1/collections \| jq '.data[]\|{code,hero_mode,home_model_url,show_on_home,home_sort_order,n:(.product_ids\|length)}'` | 5 collection, `home_model_url` 5 giá trị khác nhau, `show_on_home` 5 true, `product_ids` 5 mỗi cái (backfill) |
| V-2 | Admin → Bộ sưu tập → Sửa Soft Ceremony: tải ảnh bìa mới (1672×941), chọn `Ảnh bìa`, Lưu; mở `/collections` | Hero hiện ảnh bìa mới, không có 5 cutout; đổi lại `Bố cục 5 người mẫu` ⇒ gradient + 5 cutout |
| V-3 | Sửa tên + `home_story` + `story_desc` + `kicker` + `explore_cta` + `category_link` | `/collections` hiển thị đúng từng chuỗi (hero lede, cột bên hông, nút CTA tới đúng đích); trang chủ pill đổi tên theo |
| V-4 | Chọn 5 combo (thêm, đổi thứ tự, xóa 1) | `/collections` đúng danh sách + thứ tự; không còn sản phẩm không-combo (kiểm Weekend Escape / Urban Rhythm, vốn có 27/17 không-combo) |
| V-5 | Tải PNG không trong suốt vào ô người mẫu / ô trang chủ | Bị từ chối `MODEL_ALPHA_REQUIRED`; PNG cutout đạt chuẩn được nhận |
| V-6 | Trang chủ (hard reload): 5 người mẫu | 5 ảnh khác nhau, nền trong suốt trên stage hồng, pill đúng tên bộ sưu tập từng người, bấm người ngoài tâm đưa về giữa, chuyển động như cũ; đổi `home_model_url` ở admin ⇒ F5 thấy đổi |
| V-7 | Admin tab Banner | Không hộp xanh đè; badge Bật/Tắt nằm trong thân card; ảnh/poster không đen; không có footer `Hiển thị…`; tab Tất cả bài viết vẫn có phân trang |
| V-8 | Admin tab Bộ sưu tập: thumbnail strip & preview | Ảnh hiển thị (không 404 trên admin origin) |
| V-9 | RBAC: đăng nhập role không có `content` (hoặc `admin_viewer`) gọi `POST /api/v1/admin/collections` bằng token | 403 `RBAC_DENIED` |
| V-10 | Tắt `show_on_home` 1 collection | Admin chip "4/5" vàng; trang chủ về bộ 5 tĩnh (không còn 4 người); bật lại ⇒ 5 |

---

## 11. Rủi ro & điểm cần reviewer đối kháng soi

| R | Rủi ro | Giảm thiểu / quyết định |
|---|---|---|
| R1 | Migration production **bị khóa mặc định** (cần owner opt-in); nếu API deploy trước migration ⇒ `/api/v1/collections` 400 trên production. | Thứ tự T16; E17 fallback; cân nhắc API đọc cột mới bằng `select=*`? **Không** — giữ whitelist SELECT, bắt buộc thứ tự deploy. |
| R2 | Validator alpha chỉ chứng minh "có nền trong suốt", không chứng minh "đúng người". "Đúng yêu cầu ảnh người mẫu" (nội dung) cần người duyệt. | Preview nền caro trong admin + V-5/V-6 thủ công; không hứa kiểm tự động nội dung. |
| R3 | Thêm 5 cột + `product_ids` là mở rộng schema (D1/D2/D3). Phương án rẻ hơn đã cân nhắc và loại: dùng `banners.placement='home_hero'` (2 nguồn sự thật, tên bộ sưu tập tách khỏi collection); bảng nối `collection_product` (cần RPC để thay thế nguyên tử qua PostgREST). | Giữ như spec; reviewer có thể phản biện D2 (mảng không có FK ⇒ id mồ côi; đã xử lý E4 ở cả hai đầu). |
| R4 | `hero_mode` thêm bề mặt UI để xử lý việc cover đã chứa 5 người mẫu. Nếu owner muốn **cover luôn thay hero** thì có thể bỏ `hero_mode`. | Mặc định `models` giữ nguyên giao diện hiện tại; câu hỏi mở cho owner (Q1). |
| R5 | Không có optimistic locking ⇒ last-write-wins (E15). | Chấp nhận; nếu cần thêm `updated_at` precondition sau. |
| R6 | RBAC siết (FR-S1) có thể chặn một role đang vô tình dùng được. | Kiểm `roleModules` trước (T5); có test cả hai chiều. DELETE dùng `update` vì thiếu capability `delete` cho `content`. |
| R7 | Cutover sạch xóa fallback đoán mò ⇒ collection **không có** `product_ids` sẽ hiện empty-state thay vì "tạm có hàng". Đây chính là hành vi đúng nhưng nhìn thấy khác ngay sau deploy nếu backfill lỡ (vd. tên `product.collection` lệch). | V-1 kiểm `n=5`; backfill khớp theo tên đúng như dữ liệu live đã probe (5/5/5/5/5). |
| R8 | `story_paragraphs`, `decor_url`, `quote`, `styling_metadata`, `label` thành cột "mồ côi" trong DB. | Ngoài phạm vi xóa cột (không rủi ro); ghi sổ để dọn sau. |
| R9 | Ảnh bìa/banner live nằm ở `cdn.jsdelivr.net` (GitHub repo bên thứ ba, 1.8 MB). Mất repo ⇒ ảnh vỡ. | FR-S3 vẫn cho phép https bất kỳ; khuyến nghị operator upload lại qua admin (không bắt buộc). Fallback ảnh: nền `hero_gradient`. |
| R10 | Bằng chứng `[INF]`: nguyên nhân ảnh đen (poster PNG trong suốt + video không decode) và việc admin production chưa có `/assets/images/models/*`. | V-7/V-8 trên bản deploy mới; FR-16/FR-17 vô hiệu hóa cả hai nguyên nhân bất kể xác nhận. |
| R11 | Số migration 132 có thể va chạm với spec song song. | Bước kiểm số trong T1. |
| R12 | Câu hỏi mở: (Q1) cover có thay hoàn toàn hero? (Q2) 5 người mẫu trang chủ có phải đúng 5 collection hiện có (ràng buộc 1-1 qua `show_on_home`) hay owner muốn thêm "người mẫu không thuộc collection nào"? Spec chọn 1-1. | Nếu Q2 = không 1-1 thì cần bảng riêng; để owner xác nhận trước T13. |

---

## 12. Non-goals
Không đổi layout/animation runway; không đổi trang `/products` ngoài kiểu placement; không tạo editor kéo-thả; không xóa cột DB cũ; không đổi KPI card bài viết; không thêm video cho bộ sưu tập; không thêm cache layer mới.
