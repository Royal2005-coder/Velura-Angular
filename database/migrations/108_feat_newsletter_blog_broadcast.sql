-- Migration 108: Newsletter Subscribers, Dual-Priority Email Outbox & Automated Blog Broadcast
-- Feature: KAN-67 (FEAT-NEWSLETTER-BLOG-BROADCAST)

-- 1. Create newsletter_subscribers table
create table if not exists public.newsletter_subscribers (
  subscriber_id uuid primary key default gen_random_uuid(),
  email text not null,
  status text not null default 'active' check (status in ('active', 'unsubscribed')),
  source text not null default 'storefront_footer',
  unsubscribe_token text not null default encode(gen_random_bytes(24), 'hex'),
  metadata jsonb not null default '{}'::jsonb,
  subscribed_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique constraint on lowercase trimmed email
create unique index if not exists idx_newsletter_subscribers_email_lower
  on public.newsletter_subscribers (lower(trim(email)));

-- Efficient filtering for active subscribers when broadcasting
create index if not exists idx_newsletter_subscribers_active
  on public.newsletter_subscribers (status, subscribed_at desc)
  where status = 'active';

-- Unsubscribe token lookup
create unique index if not exists idx_newsletter_subscribers_token
  on public.newsletter_subscribers (unsubscribe_token);

-- Auto-update updated_at timestamp
drop trigger if exists trg_newsletter_subscribers_touch_updated_at on public.newsletter_subscribers;
create trigger trg_newsletter_subscribers_touch_updated_at
  before update on public.newsletter_subscribers
  for each row execute function public.velura_touch_updated_at();

-- RLS hardening
alter table public.newsletter_subscribers enable row level security;
revoke all on public.newsletter_subscribers from public, anon, authenticated;
grant all on public.newsletter_subscribers to service_role;

-- 2. Upgrade email_outbox with priority and HTML body
alter table public.email_outbox add column if not exists priority integer not null default 50;
alter table public.email_outbox add column if not exists html_body text;

-- Index supporting priority-first queue drainage
create index if not exists idx_email_outbox_priority_dispatch
  on public.email_outbox(status, priority desc, next_attempt_at)
  where status in ('pending', 'failed') and attempts < 3;

-- Replace claim RPC to enforce priority-based order (OTP/Receipts 100 > Welcome 50 > Marketing 10)
create or replace function public.velura_claim_email_outbox(p_limit integer default 20)
returns setof public.email_outbox
language sql
security definer
set search_path = pg_catalog, public
as $$
  with candidates as (
    select email_id
    from public.email_outbox
    where status in ('pending', 'failed')
      and attempts < 3
      and next_attempt_at <= now()
    order by priority desc, created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  update public.email_outbox outbox
  set status = 'sending',
      attempts = outbox.attempts + 1,
      updated_at = now()
  from candidates
  where outbox.email_id = candidates.email_id
  returning outbox.*
$$;

-- 3. Add newsletter_broadcast_at to public.blog
alter table public.blog add column if not exists newsletter_broadcast_at timestamptz;

-- 4. Seed VELURA10 welcome voucher into public.voucher if not already existing
insert into public.voucher (
  code,
  name,
  discount_type,
  discount_value,
  start_date,
  end_date,
  is_active,
  min_order_value,
  max_discount_amount,
  usage_limit_total,
  usage_limit_per_user,
  applicable_user_group
)
select
  'VELURA10',
  'Ưu đãi chào mừng bản tin 10%',
  'percentage',
  10,
  now() - interval '1 day',
  now() + interval '5 years',
  true,
  100000,
  100000,
  1000000,
  1,
  'all_users'
where not exists (
  select 1 from public.voucher where upper(code) = 'VELURA10'
);
