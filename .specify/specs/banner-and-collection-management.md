# Specification: Banner and Collection Lookbook Management System

## 1. Problem Statement & Business Context
Currently in Velura:
1. **Home Runway Hero Banner**: The interactive 3D model runway on the home page (`home.page.ts`) uses a hardcoded array (`HERO_LOOKS`) of 5 models and labels in client TypeScript.
2. **Product Page Banner**: The editorial hero banner on `/products` (`product-list.page.html`) is hardcoded to a single static video (`/assets/videos/hero-bg.mp4`) with static text ("Timeless Elegance"). Marketing operators cannot update campaigns, switch between video or high-resolution photography, or feature a scrolling carousel of featured promotions.
3. **Collections Page & Lookbooks**: The collections showcase on `/collections` (`collections.page.ts`) displays seasonal collections (*Soft Ceremony*, *The Urban Rhythm*, *Weekend Escape*, *Midnight Mirage*, *The Afterglow*) with 5 model cutouts, story blurbs, cursive script titles, and quotes. This is entirely hardcoded in `collection-lookbook.ts`. Operators cannot create new seasonal collections, update story blurbs, or upload new model photos for upcoming fashion seasons.
4. **Admin ERP Content CMS**: Currently only manages Blog posts and Newsletter subscribers. There is no workspace to manage storefront banners (images/videos) or seasonal collection lookbooks with model assets.

## 2. Goals & Success Criteria
1. **Database Schema & Migrations**:
   - Table `banners`: Stores dynamic media banners for placements (`home_hero`, `products_hero`, `collections_hero`) with support for both `image` and `video` types, poster fallback, CTA links, badges, sound settings, and ordering.
   - Table `collections`: Stores seasonal fashion collections with code, title, seasonal label, cursive script, gradient theme, story copy, closing quotes, category links, and an ordered array of lookbook model images.
   - Seed data preserving all existing production aesthetic assets so the site boots seamlessly without regression.
2. **Backend API**:
   - Public GET `/api/v1/banners?placement=<placement>`: Returns active banners ordered by `sort_order`.
   - Admin CRUD `/api/v1/admin/banners`: List, create, update, delete, toggle active, reorder.
   - Public GET `/api/v1/collections`: Returns active collections with model image arrays and story metadata.
   - Admin CRUD `/api/v1/admin/collections`: List, create, update, delete, toggle active, reorder, manage model images.
   - Media upload support via `/api/v1/admin/upload/media` for banner media and model lookbook photos with validation.
3. **Storefront (`user-ng`) Integration**:
   - **Home Page**: Dynamic loading of Runway Hero looks from database with fallback to current aesthetic defaults.
   - **Product List Page**: Transform the static video hero into an interactive, multi-media banner carousel/slider supporting both looping video (with mute/unmute control) and responsive editorial photography.
   - **Collections Page**: Dynamically renders all active collections and tabs from the database, rendering panoramic model stages, story columns, and linked product showcases.
4. **Admin ERP (`admin-erp-ng`) Integration**:
   - Integrated seamlessly into `/content` workspace with unified tabs:
     - `Bài viết` (Existing Blog CMS)
     - `Quản lý Banner` (New Banner Management for Home, Products, Collections)
     - `Bộ sưu tập & Lookbook` (New Seasonal Collections & Model Uploader)
     - `Người đăng ký` (Subscribers)
   - Adheres strictly to `/design-taste-frontend` and Velura brand guidelines: warm ivory background, rose burgundy accents, smooth modals, responsive tables, real-time lookbook model previews, and clean error handling.

## 3. Detailed Data Models
### 3.1. Banners Table (`banners`)
- `banner_id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `placement`: VARCHAR(50) NOT NULL (`home_hero`, `products_hero`, `collections_hero`)
- `title`: VARCHAR(255) NOT NULL
- `subtitle`: TEXT
- `tag_label`: VARCHAR(100) -- e.g. "VELURA ATELIER", "POWERED BY TRESEMMÉ"
- `media_type`: VARCHAR(20) NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video'))
- `media_url`: TEXT NOT NULL
- `poster_url`: TEXT -- poster image for video
- `button_text`: VARCHAR(100) DEFAULT 'Khám phá ngay'
- `link_url`: TEXT DEFAULT '/products'
- `is_active`: BOOLEAN NOT NULL DEFAULT true
- `sort_order`: INTEGER NOT NULL DEFAULT 0
- `metadata`: JSONB DEFAULT '{"autoplay": true, "sound_default": false}'::jsonb
- `created_at`: TIMESTAMPTZ DEFAULT NOW()
- `updated_at`: TIMESTAMPTZ DEFAULT NOW()

### 3.2. Collections Table (`collections`)
- `collection_id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
- `code`: VARCHAR(100) UNIQUE NOT NULL -- e.g. 'soft-ceremony'
- `name`: VARCHAR(255) NOT NULL -- e.g. 'Soft Ceremony'
- `label`: VARCHAR(255) NOT NULL -- e.g. 'Thanh lịch & Kiêu sa'
- `col_number`: VARCHAR(100) NOT NULL -- e.g. 'COLLECTION 01 · SPRING / SUMMER'
- `script`: VARCHAR(100) NOT NULL -- e.g. 'in bloom'
- `hero_gradient`: TEXT NOT NULL DEFAULT 'linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)'
- `badge`: VARCHAR(50) DEFAULT 'ELEGANT'
- `kicker`: VARCHAR(255) DEFAULT 'THE ART OF SOFTNESS'
- `story_headline`: VARCHAR(255) DEFAULT 'Dịu dàng, có chủ ý.'
- `story_desc`: TEXT NOT NULL
- `story_paragraphs`: JSONB DEFAULT '[]'::jsonb -- string[]
- `explore_cta`: VARCHAR(100) DEFAULT 'Khám phá bộ sưu tập'
- `category_link`: VARCHAR(255) DEFAULT '/products?category=dam-vay'
- `products_sub`: VARCHAR(100) DEFAULT 'SELECTED FOR YOU'
- `products_title`: VARCHAR(255) DEFAULT 'Những thiết kế nổi bật'
- `closing_quote`: TEXT DEFAULT 'Một chút lãng mạn, vừa đủ cho riêng bạn.'
- `quote`: TEXT -- banner quote
- `models`: JSONB NOT NULL DEFAULT '[]'::jsonb -- string[] of 5 cutout model image URLs
- `is_active`: BOOLEAN NOT NULL DEFAULT true
- `sort_order`: INTEGER NOT NULL DEFAULT 0
- `created_at`: TIMESTAMPTZ DEFAULT NOW()
- `updated_at`: TIMESTAMPTZ DEFAULT NOW()

## 4. API Endpoints
- `GET /api/v1/banners?placement=<home_hero|products_hero|collections_hero>` -> `{ success: true, data: Banner[] }`
- `GET /api/v1/admin/banners` -> `{ success: true, data: Banner[] }`
- `POST /api/v1/admin/banners` -> `{ success: true, data: Banner }`
- `PUT /api/v1/admin/banners/:id` -> `{ success: true, data: Banner }`
- `DELETE /api/v1/admin/banners/:id` -> `{ success: true }`
- `GET /api/v1/collections` -> `{ success: true, data: Collection[] }`
- `GET /api/v1/admin/collections` -> `{ success: true, data: Collection[] }`
- `POST /api/v1/admin/collections` -> `{ success: true, data: Collection }`
- `PUT /api/v1/admin/collections/:id` -> `{ success: true, data: Collection }`
- `DELETE /api/v1/admin/collections/:id` -> `{ success: true }`
- `POST /api/v1/admin/upload/media` -> `{ success: true, url: string, mimeType: string }`

## 5. Non-Functional Requirements & Anti-Slop Guidelines
- **Resilience**: Client applications must never render blank pages if the database query fails; gracefully fall back to local constants.
- **Accessibility & UX**: Video banners must support pause, mute/unmute toggle, ARIA labels, and proper contrast ratios.
- **Responsive Layouts**: Fixed aspect-ratio containers (`aspect-[21/9]` or `aspect-[16/9]` on mobile `aspect-[4/3]`) to prevent layout shifts (CLS = 0).
- **Security**: Admin endpoints guarded by RBAC (`requireRole(['admin', 'super_admin'])`), sanitization of inputs and secure storage bucket paths.
