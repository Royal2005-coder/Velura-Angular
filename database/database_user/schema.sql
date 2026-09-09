-- ============================================================
--  VELURA DATABASE SCHEMA â€” PostgreSQL
--  Dá»±a trÃªn thiáº¿t káº¿ ERD (PhÃ¡t triá»ƒn web.pdf)
--  Generated: 2026-06-18
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('guest', 'member', 'admin');

CREATE TYPE admin_role_type AS ENUM (
  'admin_viewer',
  'admin_operator_sanpham',
  'admin_operator_donhang',
  'admin_operator_cskh_dt',
  'admin_operator_gia_km',
  'admin_operator_danhgia_review',
  'super_admin'
);

CREATE TYPE body_shape AS ENUM ('Hourglass', 'Pear', 'Apple', 'Rectangle', 'Inverted Triangle');

CREATE TYPE skin_tone AS ENUM ('Warm', 'Cool', 'Neutral');

CREATE TYPE budget_range AS ENUM ('under_300k', '300k_700k', '700k_1.5m', 'above_1.5m');

CREATE TYPE product_status AS ENUM ('on_sale', 'hidden', 'out_of_stock', 'discontinued');

CREATE TYPE order_status AS ENUM (
  'pending', 'confirmed', 'preparing',
  'shipping', 'delivered', 'failed_delivery',
  'cancelled', 'completed'
);

CREATE TYPE payment_method AS ENUM ('COD', 'ONLINE_PAYMENT');

CREATE TYPE payment_status AS ENUM (
  'pending', 'paid', 'failed',
  'refunded', 'refund_pending', 'discrepancy'
);

CREATE TYPE promo_type AS ENUM (
  'flash_sale', 'combo_discount', 'product_discount',
  'bulk_discount', 'seasonal_sale'
);

CREATE TYPE discount_type AS ENUM ('fixed_amount', 'percentage', 'free_shipping');

CREATE TYPE applicable_user_group AS ENUM (
  'new_user', 'loyal_user', 'churn_risk_user', 'all_users'
);

CREATE TYPE return_type AS ENUM ('exchange', 'refund');

CREATE TYPE return_status AS ENUM (
  'pending', 'approved', 'shipping_back',
  'received', 'completed', 'rejected'
);

CREATE TYPE condition_check AS ENUM ('passed', 'minor_damage', 'major_damage');

CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high');

CREATE TYPE ticket_status AS ENUM ('open', 'processing', 'resolved', 'closed');

CREATE TYPE ai_source AS ENUM ('for_you_feed', 'chatbot', 'search', 'direct');

CREATE TYPE ai_log_type AS ENUM ('chatbot_session', 'recommendation_event', 'quiz_result');

CREATE TYPE trigger_type AS ENUM ('system', 'manual');

CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete', 'approve', 'reject', 'lock', 'unlock');


-- ============================================================
-- 1. USERS & STYLE PROFILE
-- (khÃ´ng phá»¥ thuá»™c báº£ng nÃ o khÃ¡c)
-- ============================================================

CREATE TABLE users (
  user_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             VARCHAR(255) UNIQUE,
  phone             VARCHAR(15)  UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  full_name         VARCHAR(100) NOT NULL,
  date_of_birth     DATE,
  gender            VARCHAR(20),
  avatar            VARCHAR(255),
  role              user_role    NOT NULL DEFAULT 'member',
  admin_role        admin_role_type,
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  -- Báº£o máº­t
  otp_code          VARCHAR(10),
  otp_expires_at    TIMESTAMP,
  login_fail_count  SMALLINT     NOT NULL DEFAULT 0,
  locked_until      TIMESTAMP,
  -- Äá»‹a chá»‰ lÆ°u dáº¡ng JSON array
  saved_addresses   JSONB        NOT NULL DEFAULT '[]',
  social_accounts   JSONB        NOT NULL DEFAULT '{}',
  -- Wishlist lÆ°u trá»±c tiáº¿p trÃªn users, khÃ´ng táº¡o báº£ng wishlist riÃªng
  wishlist          JSONB        NOT NULL DEFAULT '[]',
  -- ThÃ nh viÃªn
  tier              VARCHAR(20)  NOT NULL DEFAULT 'Standard',
  loyalty_points    INT          NOT NULL DEFAULT 0,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_email_or_phone CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE guest_session (
  session_id        VARCHAR(100) PRIMARY KEY,
  -- Khi Guest Ä‘Äƒng kÃ½ thÃ nh tÃ i khoáº£n, lÆ°u láº¡i user_id Ä‘á»ƒ há»£p nháº¥t dá»¯ liá»‡u
  converted_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        TIMESTAMP NOT NULL
);

CREATE TABLE style_profile (
  profile_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  height_cm           SMALLINT,
  weight_kg           SMALLINT,
  chest_cm            SMALLINT,
  waist_cm            SMALLINT,
  hip_cm              SMALLINT,
  body_shape          body_shape,
  skin_tone           skin_tone,
  style_tags          VARCHAR(50)[],
  preferred_occasions VARCHAR(50)[],
  favorite_brands     VARCHAR(100)[],
  budget_range        budget_range,
  age_group           VARCHAR(20),
  favorite_colors     VARCHAR(20)[],
  quiz_completed_at   TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 2. CATEGORY & PRODUCT
-- (category khÃ´ng phá»¥ thuá»™c ai; product phá»¥ thuá»™c category)
-- ============================================================

CREATE TABLE category (
  category_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  parent_id     UUID REFERENCES category(category_id) ON DELETE SET NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  display_order INT          NOT NULL DEFAULT 0
);

CREATE TABLE product (
  product_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                  VARCHAR(50)   UNIQUE NOT NULL,
  is_combo             BOOLEAN       NOT NULL DEFAULT false,
  name                 VARCHAR(200)  NOT NULL,
  slug                 VARCHAR(200)  UNIQUE NOT NULL,
  description          TEXT,
  category_id          UUID          NOT NULL REFERENCES category(category_id),
  brand                VARCHAR(100)  DEFAULT 'Velura',
  base_price           DECIMAL(12,0) NOT NULL,
  sale_price           DECIMAL(12,0) NOT NULL,
  images               VARCHAR(255)[] NOT NULL DEFAULT '{}',
  style_tags           VARCHAR(50)[],
  color_tone           skin_tone,
  occasions            VARCHAR(50)[],
  suitable_body_shapes body_shape[],
  status               product_status NOT NULL DEFAULT 'on_sale',
  is_featured          BOOLEAN        NOT NULL DEFAULT false,
  collection           VARCHAR(100),
  seo_title            VARCHAR(255),
  seo_description      TEXT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE variant (
  variant_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID         NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  color               VARCHAR(50)  NOT NULL,
  color_hex           VARCHAR(7),
  size                VARCHAR(10)  NOT NULL,
  size_measurements   JSONB,
  stock_quantity      INT          NOT NULL DEFAULT 0,
  reserved_quantity   INT          NOT NULL DEFAULT 0,
  low_stock_threshold INT          NOT NULL DEFAULT 5,

  UNIQUE (product_id, color, size)
);

CREATE TABLE combo_item (
  combo_item_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_product_id     UUID NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  component_product_id UUID NOT NULL REFERENCES product(product_id) ON DELETE RESTRICT,
  component_variant_id UUID REFERENCES variant(variant_id) ON DELETE RESTRICT,
  quantity             INT  NOT NULL DEFAULT 1
);


-- ============================================================
-- 3. KHUYáº¾N MÃƒI & VOUCHER
-- (promotion â†’ users; voucher â†’ promotion, users)
-- Pháº£i táº¡o TRÆ¯á»šC orders vÃ¬ orders FK â†’ voucher
-- ============================================================

CREATE TABLE promotion (
  promo_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_name            VARCHAR(200)  NOT NULL,
  promo_type            promo_type    NOT NULL,
  applicable_categories JSONB,
  start_date            TIMESTAMP     NOT NULL,
  end_date              TIMESTAMP     NOT NULL,
  is_active             BOOLEAN       NOT NULL DEFAULT true,
  budget_limit          DECIMAL(12,0),
  max_vouchers_allowed  INT,
  total_discount_issued DECIMAL(12,0) NOT NULL DEFAULT 0,
  created_by            UUID          NOT NULL REFERENCES users(user_id)
);

CREATE TABLE voucher (
  voucher_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id              UUID REFERENCES promotion(promo_id) ON DELETE SET NULL,
  code                  VARCHAR(50)  UNIQUE NOT NULL,
  name                  VARCHAR(200) NOT NULL,
  discount_type         discount_type NOT NULL,
  discount_value        DECIMAL(12,2) NOT NULL,
  max_discount_amount   DECIMAL(10,0),
  min_order_value       DECIMAL(10,0) NOT NULL DEFAULT 0,
  usage_limit_total     INT,
  usage_limit_per_user  INT          NOT NULL DEFAULT 1,
  used_count            INT          NOT NULL DEFAULT 0,
  applicable_categories JSONB,
  applicable_user_group applicable_user_group NOT NULL DEFAULT 'all_users',
  start_date            TIMESTAMP    NOT NULL,
  end_date              TIMESTAMP    NOT NULL,
  is_active             BOOLEAN      NOT NULL DEFAULT true,
  created_by            UUID         NOT NULL REFERENCES users(user_id)
);

CREATE TABLE promotion_product (
  promo_id       UUID NOT NULL REFERENCES promotion(promo_id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  discount_type  discount_type NOT NULL,
  discount_value DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (promo_id, product_id)
);

CREATE TABLE price_history (
  price_history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID          NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  variant_id       UUID          REFERENCES variant(variant_id) ON DELETE CASCADE,
  old_base_price   DECIMAL(12,0) NOT NULL,
  new_base_price   DECIMAL(12,0) NOT NULL,
  old_sale_price   DECIMAL(12,0) NOT NULL,
  new_sale_price   DECIMAL(12,0) NOT NULL,
  changed_by       UUID          NOT NULL REFERENCES users(user_id),
  changed_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason           TEXT
);


-- ============================================================
-- 4. ÄÆ N HÃ€NG
-- (orders â†’ users, voucher â€” cáº£ 2 Ä‘Ã£ tá»“n táº¡i)
-- ============================================================

CREATE TABLE orders (
  order_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID           NOT NULL REFERENCES users(user_id),
  order_date       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status           order_status   NOT NULL DEFAULT 'pending',
  shipping_name    VARCHAR(100)   NOT NULL,
  shipping_phone   VARCHAR(15)    NOT NULL,
  shipping_address TEXT           NOT NULL,
  shipping_fee     DECIMAL(10,0)  NOT NULL DEFAULT 0,
  voucher_id       UUID           REFERENCES voucher(voucher_id) ON DELETE RESTRICT,
  discount_amount  DECIMAL(10,0)  NOT NULL DEFAULT 0,
  subtotal         DECIMAL(12,0)  NOT NULL,
  total_amount     DECIMAL(12,0)  NOT NULL,
  payment_method   payment_method NOT NULL,
  ai_source        ai_source,
  tracking_code    VARCHAR(100),
  internal_note    TEXT,
  cancelled_reason TEXT,
  delivered_at     TIMESTAMP,
  created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_item (
  item_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID          NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  variant_id       UUID          NOT NULL REFERENCES variant(variant_id),
  product_name     VARCHAR(200)  NOT NULL,
  product_image    VARCHAR(255),
  applied_promo_id UUID          REFERENCES promotion(promo_id) ON DELETE SET NULL,
  quantity         INT           NOT NULL CHECK (quantity > 0),
  unit_price       DECIMAL(12,0) NOT NULL,
  subtotal_item    DECIMAL(12,0) NOT NULL
);

CREATE TABLE order_status_history (
  history_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID         NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  old_status   order_status NOT NULL,
  new_status   order_status NOT NULL,
  trigger_type trigger_type,
  changed_by   UUID         NOT NULL REFERENCES users(user_id),
  changed_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note         TEXT
);


-- ============================================================
-- 5. THANH TOÃN
-- (payment â†’ orders)
-- ============================================================

CREATE TABLE payment (
  payment_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                UUID           NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  payment_method          payment_method NOT NULL,
  payment_provider        VARCHAR(50),
  amount                  DECIMAL(12,0)  NOT NULL,
  payment_status          payment_status NOT NULL DEFAULT 'pending',
  payment_channel         VARCHAR(50),
  gateway_transaction_ref VARCHAR(100),
  gateway_response_code   VARCHAR(10),
  paid_at                 TIMESTAMP,
  refund_amount           DECIMAL(12,0),
  refund_reason           TEXT,
  refund_at               TIMESTAMP,
  has_discrepancy         BOOLEAN        NOT NULL DEFAULT false,
  created_at              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 6. GIá»Ž HÃ€NG
-- (cart â†’ users, guest_session)
-- ============================================================

CREATE TABLE cart (
  cart_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  session_id VARCHAR(100) UNIQUE REFERENCES guest_session(session_id) ON DELETE CASCADE,
  items      JSONB     NOT NULL DEFAULT '[]',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_cart_owner CHECK (
    (user_id IS NOT NULL AND session_id IS NULL) OR
    (user_id IS NULL AND session_id IS NOT NULL)
  )
);


-- ============================================================
-- 7. ÄÃNH GIÃ Sáº¢N PHáº¨M
-- (review â†’ product, users, orders)
-- ============================================================

CREATE TABLE review (
  review_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID          NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  user_id           UUID          NOT NULL REFERENCES users(user_id),
  order_id          UUID          NOT NULL REFERENCES orders(order_id),
  rating            SMALLINT      NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment           TEXT,
  images            VARCHAR(255)[],
  review_tags       VARCHAR(100)[],
  status            review_status NOT NULL DEFAULT 'pending',
  rejection_reason  TEXT,
  admin_reply       TEXT,
  moderated_by      UUID          REFERENCES users(user_id),
  is_flagged_urgent BOOLEAN       NOT NULL DEFAULT false,
  submitted_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  moderated_at      TIMESTAMP
);


-- ============================================================
-- 8. Äá»”I TRáº¢ & CSKH
-- (return_exchange â†’ orders, users)
-- (return_item â†’ return_exchange, order_item)
-- ============================================================

CREATE TABLE return_exchange (
  return_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               UUID          NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  user_id                UUID          NOT NULL REFERENCES users(user_id),
  return_type            return_type   NOT NULL,
  description            TEXT,
  evidence_images        VARCHAR(255)[],
  status                 return_status NOT NULL DEFAULT 'pending',
  condition_check_result condition_check,
  admin_note             TEXT,
  rejection_reason       TEXT,
  exchange_order_id      UUID          REFERENCES orders(order_id),
  refund_amount          DECIMAL(10,0),
  tracking_return_code   VARCHAR(100),
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at            TIMESTAMP
);

CREATE TABLE return_item (
  return_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id      UUID NOT NULL REFERENCES return_exchange(return_id) ON DELETE CASCADE,
  order_item_id  UUID NOT NULL REFERENCES order_item(item_id) ON DELETE RESTRICT,
  quantity       INT  NOT NULL CHECK (quantity > 0)
);


-- ============================================================
-- 9. AI LOG
-- (ai_log â†’ users, guest_session)
-- Pháº£i táº¡o TRÆ¯á»šC support_ticket vÃ¬ support_ticket FK â†’ ai_log
-- ============================================================

CREATE TABLE ai_log (
  log_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_type             ai_log_type NOT NULL,
  user_id              UUID        REFERENCES users(user_id),
  session_id           VARCHAR(100) REFERENCES guest_session(session_id) ON DELETE CASCADE,
  messages             JSONB,
  image_urls           VARCHAR(255)[],
  recommended_products JSONB,
  clicked_products     JSONB,
  purchased_products   JSONB,
  ctr                  DECIMAL(5,4),
  quiz_results         JSONB,
  escalated_to_human   BOOLEAN   NOT NULL DEFAULT false,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 10. SUPPORT TICKET
-- (support_ticket â†’ users, ai_log â€” cáº£ 2 Ä‘Ã£ tá»“n táº¡i)
-- ============================================================

CREATE TABLE support_ticket (
  ticket_id   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID            REFERENCES users(user_id),
  guest_phone VARCHAR(15),
  guest_email VARCHAR(255),
  title       VARCHAR(200)    NOT NULL,
  description TEXT            NOT NULL,
  priority    ticket_priority NOT NULL DEFAULT 'medium',
  status      ticket_status   NOT NULL DEFAULT 'open',
  admin_reply TEXT,
  csat_score  SMALLINT        CHECK (csat_score BETWEEN 1 AND 5),
  ai_log_id   UUID            REFERENCES ai_log(log_id),
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);


-- ============================================================
-- 11. APPROVAL_ADMIN_REQUEST
-- (yÃªu cáº§u nÃ¢ng quyá»n admin â†’ users x3)
-- Pháº£i táº¡o sau users
-- ============================================================

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE approval_admin_request (
  request_id   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID            NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  target_user_id UUID          NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  approver_id  UUID            REFERENCES users(user_id) ON DELETE RESTRICT,
  -- Quyá»n Ä‘Æ°á»£c Ä‘á» xuáº¥t nÃ¢ng lÃªn
  requested_role admin_role_type NOT NULL,
  status       approval_status NOT NULL DEFAULT 'pending',
  reason       TEXT,
  admin_note   TEXT,
  expires_at   TIMESTAMP,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at  TIMESTAMP
);


-- ============================================================
-- 12. AUDIT LOG
-- (audit_log â†’ users)
-- ============================================================

CREATE TABLE audit_log (
  audit_id   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID            NOT NULL REFERENCES users(user_id),
  actor_role admin_role_type NOT NULL,
  action     audit_action    NOT NULL,
  module     VARCHAR(50)     NOT NULL,
  target_id  UUID            NOT NULL,
  old_value  JSONB,
  new_value  JSONB,
  ip_address VARCHAR(45)     NOT NULL,
  timestamp  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_product_category    ON product(category_id);
CREATE INDEX idx_product_status      ON product(status);
CREATE INDEX idx_product_featured    ON product(is_featured);
CREATE INDEX idx_product_style_tags  ON product USING GIN(style_tags);
CREATE INDEX idx_product_body_shapes ON product USING GIN(suitable_body_shapes);

CREATE INDEX idx_variant_product     ON variant(product_id);

CREATE INDEX idx_orders_user         ON orders(user_id);
CREATE INDEX idx_orders_status       ON orders(status);
CREATE INDEX idx_orders_date         ON orders(order_date DESC);

CREATE INDEX idx_order_item_order    ON order_item(order_id);
CREATE INDEX idx_order_item_variant  ON order_item(variant_id);

CREATE INDEX idx_review_product      ON review(product_id);
CREATE INDEX idx_review_status       ON review(status);

CREATE INDEX idx_ai_log_user         ON ai_log(user_id);
CREATE INDEX idx_ai_log_type         ON ai_log(log_type);


-- ============================================================
-- SEED DATA: CATEGORY
-- ============================================================

INSERT INTO category (name, parent_id, slug, display_order) VALUES
  ('Ão',        NULL, 'ao',       1),
  ('Quáº§n',      NULL, 'quan',     2),
  ('Äáº§m & VÃ¡y', NULL, 'dam-vay', 3),
  ('Ão khoÃ¡c',  NULL, 'ao-khoac', 4),
  ('Set Ä‘á»“',    NULL, 'set-do',  5),
  ('Phá»¥ kiá»‡n',  NULL, 'phu-kien', 6),
  ('GiÃ y dÃ©p',  NULL, 'giay-dep', 7);
