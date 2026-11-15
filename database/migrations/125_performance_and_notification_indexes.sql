-- Migration 125: Performance and Notification Composite Indexes
-- Supports high-concurrency order/return tracking, unread notification counts, and product/review lookups.

begin;

-- 1. Notifications table: speed up user inbox query and unread count
create index if not exists idx_notifications_user_unread 
  on public.notifications(user_id, is_read, created_at desc);

-- 2. Return Exchange table: speed up customer return tracking and admin status filters
create index if not exists idx_return_user_status_created 
  on public.return_exchange(user_id, status, created_at desc);

-- 3. Orders table: speed up customer order history and state queries
create index if not exists idx_orders_user_status_created 
  on public.orders(user_id, status, created_at desc);

-- 4. Reviews table: speed up approved reviews retrieval for product pages and admin review moderation
create index if not exists idx_reviews_product_approved 
  on public.reviews(product_id, is_approved, created_at desc);

-- 5. Products table: speed up active catalog queries by category
create index if not exists idx_products_active_category 
  on public.products(is_active, category_id);

commit;
