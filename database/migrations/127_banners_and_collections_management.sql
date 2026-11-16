-- Migration 127: Banners and Collections Lookbook Management System
-- Provides dynamic banners (video/image carousel) and seasonal fashion collections with lookbook models

CREATE TABLE IF NOT EXISTS public.banners (
    banner_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    placement VARCHAR(50) NOT NULL, -- 'home_hero', 'products_hero', 'collections_hero'
    title VARCHAR(255) NOT NULL,
    subtitle TEXT,
    tag_label VARCHAR(100),
    media_type VARCHAR(20) NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
    media_url TEXT NOT NULL,
    poster_url TEXT,
    button_text VARCHAR(100) DEFAULT 'Khám phá ngay',
    link_url TEXT DEFAULT '/products',
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{"autoplay": true, "sound_default": false}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_banners_placement_active_order 
    ON public.banners (placement, is_active, sort_order ASC);

CREATE TABLE IF NOT EXISTS public.collections (
    collection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    label VARCHAR(255) NOT NULL,
    banner_url TEXT,
    decor_url TEXT,
    home_story TEXT,
    col_number VARCHAR(100) NOT NULL,
    script VARCHAR(100) NOT NULL,
    hero_gradient TEXT NOT NULL,
    badge VARCHAR(50) DEFAULT 'ELEGANT',
    kicker VARCHAR(255) DEFAULT 'THE ART OF SOFTNESS',
    story_headline VARCHAR(255) DEFAULT 'Dịu dàng, có chủ ý.',
    story_desc TEXT NOT NULL,
    story_paragraphs JSONB NOT NULL DEFAULT '[]'::jsonb,
    explore_cta VARCHAR(100) DEFAULT 'Khám phá bộ sưu tập',
    category_link VARCHAR(255) DEFAULT '/products?category=dam-vay',
    products_sub VARCHAR(100) DEFAULT 'SELECTED FOR YOU',
    products_title VARCHAR(255) DEFAULT 'Những thiết kế nổi bật',
    closing_quote TEXT DEFAULT 'Một chút lãng mạn, vừa đủ cho riêng bạn.',
    quote TEXT,
    models JSONB NOT NULL DEFAULT '[]'::jsonb,
    styling_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_collections_active_order 
    ON public.collections (is_active, sort_order ASC);

-- Seed Data: Initial Banners for Products (Video & Image Carousel)
INSERT INTO public.banners (
    placement, title, subtitle, tag_label, media_type, media_url, poster_url, button_text, link_url, is_active, sort_order, metadata
) VALUES
(
    'products_hero',
    'Timeless Elegance',
    'Những lựa chọn tinh tế dành cho nhịp sống và phong cách riêng của bạn.',
    'POWERED BY TRESEMMÉ / SR CELEBRATING LOCAL PRIDE 9',
    'video',
    '/assets/videos/hero-bg.mp4',
    '/assets/images/auth/model_main.png',
    'Khám phá bộ sưu tập',
    '/collections',
    true,
    0,
    '{"autoplay": true, "sound_default": false}'::jsonb
),
(
    'products_hero',
    'Velura Silk & Satin Atelier',
    'Chất liệu lụa satin thượng hạng ôm trọn từng đường nét kiêu sa, tỏa sáng trong mọi khoảnh khắc dạ tiệc.',
    'HAUTE COUTURE 2027',
    'image',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_The-Afterglow_cover.png',
    NULL,
    'Xem sản phẩm mới',
    '/products?category=dam-vay',
    true,
    1,
    '{}'::jsonb
),
(
    'products_hero',
    'Urban Rhythm · Minimal Muse',
    'Phom dáng tinh gọn, chất liệu thoáng nhẹ sẵn sàng cho nhịp sống hiện đại từ văn phòng đến dạo phố cuối tuần.',
    'EVERYDAY ICONS',
    'image',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/Velura_urban-rythm_cover.png',
    NULL,
    'Khám phá Set đồ',
    '/products?category=set-do',
    true,
    2,
    '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- Seed Data: 5 Collections with Lookbook Models & Cover Banners
INSERT INTO public.collections (
    code, name, label, banner_url, decor_url, home_story, col_number, script, hero_gradient, badge, kicker,
    story_headline, story_desc, explore_cta, category_link, products_sub,
    products_title, closing_quote, quote, models, story_paragraphs, is_active, sort_order
) VALUES
(
    'soft-ceremony',
    'Soft Ceremony',
    'Thanh lịch & Kiêu sa',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Soft-Ceremony_cover.png',
    '/assets/images/collections/soft-ceremony-decor.png',
    'Những thiết kế mềm mại, tinh tế cho những dịp tiệc nhẹ, hẹn hò và các buổi gặp gỡ đặc biệt — sang trọng, hiện đại, dễ ứng dụng.',
    'COLLECTION 01 · SPRING / SUMMER',
    'in bloom',
    'linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)',
    'ELEGANT',
    'THE ART OF SOFTNESS',
    'Dịu dàng, có chủ ý.',
    'Những chuyển động mềm như lụa, sắc hoa phai và phom dáng thanh thoát. Cho những dịp đặc biệt — và cả những ngày rất đỗi bình thường.',
    'Khám phá bộ sưu tập',
    '/products?category=dam-vay',
    'SELECTED FOR YOU',
    'Những thiết kế nổi bật',
    'Một chút lãng mạn, vừa đủ cho riêng bạn.',
    'Thanh lịch không phải là nổi bật, mà là biết cách tôn lên chính mình.',
    '["/assets/images/models/model_cutout_1.png", "/assets/images/models/model_cutout_2.png", "/assets/images/models/model_cutout_4.png", "/assets/images/models/model_cutout_3.png", "/assets/images/models/model_cutout_5.png"]'::jsonb,
    '["Soft Ceremony là bộ sưu tập dành cho những dịp cần sự chỉn chu hơn thường ngày như tiệc nhẹ, hẹn hò, chụp ảnh hay những buổi gặp gỡ đặc biệt.", "Lấy cảm hứng từ vẻ đẹp nữ tính và thanh lịch, các thiết kế được xây dựng với phom dáng mềm mại, đường cắt tinh tế cùng những điểm nhấn vừa đủ.", "Với bảng màu trung tính, ấm và dịu, bộ sưu tập mang đến cảm giác sang trọng, hiện đại và dễ ứng dụng trong nhiều hoàn cảnh."]'::jsonb,
    true,
    0
),
(
    'the-urban-rhythm',
    'The Urban Rhythm',
    'Năng động & Thời thượng',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/Velura_urban-rythm_cover.png',
    '/assets/images/collections/the-urban-rhythm-decor.png',
    'Phom dáng hiện đại, đường cắt sắc sảo — bảng màu beige, charcoal, olive dễ mix-and-match cho cả ngày làm việc bận rộn lẫn buổi dạo phố cuối tuần.',
    'COLLECTION 02 · EVERYDAY ICONS',
    'city muse',
    'linear-gradient(115deg, #C9C2B8 0%, #E4DDD3 48%, #BBB7AD 100%)',
    'CASUAL',
    'MADE FOR THE CITY',
    'Tự tin trong nhịp riêng.',
    'Phom dáng tinh gọn, bảng màu dịu mắt và những lớp phối linh hoạt — để nàng luôn chỉn chu mà vẫn là chính mình.',
    'Xem các thiết kế',
    '/products?category=set-do',
    'CITY-READY WARDROBE',
    'Chuyển động cùng thành phố',
    'Từ buổi sáng đầu tiên đến cuộc hẹn cuối ngày.',
    'Nhịp sống hiện đại đẹp nhất khi sự tự tin luôn vừa vặn với từng chuyển động.',
    '["/assets/images/models/model_cutout_1.png", "/assets/images/models/model_cutout_5.png", "/assets/images/models/model_cutout_3.png", "/assets/images/models/model_cutout_2.png", "/assets/images/models/model_cutout_1.png"]'::jsonb,
    '["The Urban Rhythm dành cho những quý cô hiện đại yêu thích sự linh hoạt giữa môi trường công sở và nhịp sống phố thị.", "Các thiết kế tập trung vào phom dáng hiện đại, đường cắt sắc sảo và tính ứng dụng cao để tôn lên thần thái độc lập.", "Bảng màu beige ấm, xám charcoal, trắng kem và xanh olive giúp từng set đồ dễ mix-match nhưng vẫn giữ nét sang trọng."]'::jsonb,
    true,
    1
),
(
    'weekend-escape',
    'Weekend Escape',
    'Tự do & Phóng khoáng',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Weekend-Escape_cover.png',
    '/assets/images/collections/weekend-escape-decor.png',
    'Phom dáng nhẹ nhàng, chất liệu thoáng mát — dạo phố, cà phê hay du lịch đều thoải mái, thanh lịch trong mọi hành trình.',
    'COLLECTION 03 · OFF-DUTY EASE',
    'slow days',
    'linear-gradient(115deg, #E1D9C9 0%, #F1E9DD 48%, #D8E0D5 100%)',
    'TRAVEL',
    'A LITTLE ROOM TO BREATHE',
    'Cuối tuần thật thảnh thơi.',
    'Chất liệu thoáng nhẹ, phom dáng tự do cùng gam màu lấy cảm hứng từ thiên nhiên. Mặc đẹp mà không cần cố gắng.',
    'Tìm cảm hứng dạo phố',
    '/products?category=set-do',
    'MADE FOR SLOW MORNINGS',
    'Mặc nhẹ tênh, đi muôn nơi',
    'Gói ghém một ngày tự do theo cách của bạn.',
    'Một cuối tuần đẹp bắt đầu từ cảm giác nhẹ nhàng trong chính bộ đồ mình chọn.',
    '["/assets/images/models/model_cutout_1.png", "/assets/images/models/model_cutout_2.png", "/assets/images/models/model_cutout_3.png", "/assets/images/models/model_cutout_4.png", "/assets/images/models/model_cutout_1.png"]'::jsonb,
    '["Weekend Escape lấy cảm hứng từ những chuyến đi cuối tuần và những ngày thư giãn trọn vẹn.", "Bộ sưu tập đề cao sự thoải mái nhưng vẫn giữ vẻ thanh lịch với phom dáng nhẹ nhàng và chất liệu thoáng mát.", "Dù là dạo phố, cà phê cuối tuần hay du lịch ngắn ngày, các set đồ đều hướng tới sự tự tin và linh hoạt."]'::jsonb,
    true,
    2
),
(
    'midnight-mirage',
    'Midnight Mirage',
    'Cá tính & Đường phố',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Midnight-Mirage_cover.png',
    '/assets/images/collections/midnight-mirage-decor.png',
    'Street style Hàn Quốc — Grunge, Campus Girl, Y2K Minimal. Bảng màu trung tính pha pastel, trẻ trung và dễ phối đồ mọi ngày.',
    'COLLECTION 04 · AFTER-HOURS MUSE',
    'after dark',
    'linear-gradient(115deg, #716C6B 0%, #A79B95 48%, #5D5657 100%)',
    'STREET',
    'THE NIGHT IS YOURS',
    'Lấp lánh theo cách riêng.',
    'Đường cắt mềm, chất liệu bắt sáng vừa đủ và sắc độ nữ tính tạo nên dấu ấn không thể nhầm lẫn.',
    'Chọn thiết kế dự tiệc',
    '/products?category=dam-vay',
    'A MOMENT IN THE SPOTLIGHT',
    'Sắc đêm, nét kiêu kỳ',
    'Để khoảnh khắc của nàng trở thành tâm điểm.',
    'Cá tính không cần ồn ào, chỉ cần đủ rõ để người mặc thấy mình trong đó.',
    '["/assets/images/models/model_cutout_5.png", "/assets/images/models/model_cutout_4.png", "/assets/images/models/model_cutout_3.png", "/assets/images/models/model_cutout_5.png", "/assets/images/models/model_cutout_4.png"]'::jsonb,
    '["Midnight Mirage lấy cảm hứng từ thời trang đường phố Hàn Quốc, kết hợp nét cá tính, tối giản và hiện đại.", "Các outfit mang nhiều sắc thái như Grunge, Soft Neutral, Campus Girl, Street Prep và Y2K Minimal.", "Tổng thể bộ sưu tập trẻ trung, linh hoạt, dễ phối và phù hợp cho đi học, đi làm, dạo phố hoặc cà phê cuối tuần."]'::jsonb,
    true,
    3
),
(
    'the-afterglow',
    'The Afterglow',
    'Dư âm Vương giả',
    'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_The-Afterglow_cover.png',
    '/assets/images/collections/the-afterglow-decor.png',
    'Dư âm vương giả — lụa satin, corset tinh tế và sắc hồng tulle cùng xanh Sapphire tôn vinh vẻ đẹp kiêu sa, lộng lẫy như một tiểu thư vương giả.',
    'COLLECTION 05 · MOMENTS TO KEEP',
    'softly, forever',
    'linear-gradient(115deg, #E7CFCA 0%, #F1E2DC 48%, #D8D9D0 100%)',
    'COUTURE',
    'A MEMORY IN EVERY THREAD',
    'Khoảnh khắc còn vương mãi.',
    'Một tuyển tập dành cho những dịp đáng nhớ: nữ tính, mềm mại và tinh tế đến từng chi tiết.',
    'Khám phá sắc hồng',
    '/products?category=dam-vay',
    'THE FINAL TOUCH',
    'Dành cho ngày đặc biệt',
    'Giữ lại ánh nhìn, lưu lại cảm xúc.',
    'Có những khoảnh khắc không cần phô diễn, chỉ cần lưu lại như một vệt sáng rất riêng.',
    '["/assets/images/models/model_cutout_2.png", "/assets/images/models/model_cutout_3.png", "/assets/images/models/model_cutout_5.png", "/assets/images/models/model_cutout_4.png", "/assets/images/models/model_cutout_2.png"]'::jsonb,
    '["The Afterglow lấy cảm hứng từ ánh hoàng hôn diễm lệ và vẻ đẹp kiêu sa, lãng mạn.", "Những chất liệu mềm mại, corset tinh tế và sắc màu từ hồng tulle đến xanh Sapphire tạo nên cảm giác vương giả.", "Khi kết hợp cùng phụ kiện lấp lánh, mỗi set đồ trở thành một dấu ấn nữ tính, nổi bật nhưng vẫn đầy tiết chế."]'::jsonb,
    true,
    4
)
ON CONFLICT (code) DO NOTHING;
