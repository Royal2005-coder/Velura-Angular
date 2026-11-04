# Feature Specification: Newsletter Subscription & Automated Blog Broadcast System

**Feature ID**: `FEAT-NEWSLETTER-BLOG-BROADCAST`  
**Jira/Ticket**: `KAN-67`  
**Status**: APPROVED (Post EGM Swarm Adversarial Review)  
**Target Architecture**:
- Storefront Frontend: Angular 21 Standalone + Signals (`apps/user-ng/src/app/layout/site-footer/`)
- Backend API Gateway: Node.js TypeScript (`apps/api/src/user/newsletter.ts`, `apps/api/src/content/content-admin-service.ts`)
- Email Delivery Engine: Direct SMTP (`mailer.ts`) + Priority-Aware Outbox (`outbox-worker.ts`)
- Database: Supabase PostgreSQL (`public.newsletter_subscribers`, `public.email_outbox`, `public.voucher`, `public.blog`)

---

## 1. Executive Summary & Business Intent

Velura requires an automated customer acquisition and retention channel:
1. **Lead Generation & Conversion (Welcome Voucher 10%)**: Prospective female shoppers visiting Velura can subscribe to fashion news directly at the website footer. Upon submitting their email, they instantly receive a branded welcome email delivering a 10% discount voucher code (`VELURA10`) usable at checkout.
2. **Audience Database (Compliant Email Subscribers)**: Subscribers are persisted in a dedicated, deduplicated `newsletter_subscribers` table with explicit opt-in records, audit timestamp, and unguessable random hex unsubscribe token (192-bit entropy) for privacy/anti-spam compliance.
3. **Automated Content Marketing (CMS Blog Broadcast)**: When administrators publish a new fashion article via the CMS (`content-admin-service`), the system automatically synthesizes a responsive, high-fashion HTML newsletter with the article title, hero thumbnail, excerpt, and CTA link to `https://velura.royalai.dev/blog/:slug`, broadcasting it to all active subscribers via the email outbox pipeline without Head-of-Line starvation of transactional emails.

---

## 2. EGM Swarm Audit Resolutions

1. **Transactional Email Head-of-Line Priority (`email_outbox.priority`)**:
   - Added `priority integer not null default 50` to `email_outbox`.
   - Priority tiers: `100` (Transactional: OTP, order receipts, password resets), `50` (Welcome voucher), `10` (Bulk marketing / blog broadcasts).
   - `velura_claim_email_outbox` claims by `priority DESC, created_at ASC` so bulk marketing never starves OTP or checkout emails.
2. **Full HTML Outbox Support (`email_outbox.html_body`)**:
   - Added `html_body text` column to `public.email_outbox`.
   - Updated `deliverWithSmtp` in `outbox-worker.ts` to pass `html: message.html_body || message.metadata?.html` to Nodemailer.
3. **Seeded Canonical Voucher `VELURA10`**:
   - Seeded in `public.voucher` with `applicable_user_group: 'all_users'` (so guest checkouts are permitted), `discount_type: 'percentage'`, `discount_value: 10`, `usage_limit_per_user: 1`, `max_discount_amount: 100000`, `min_order_value: 200000`.
4. **Blog Broadcast Deduplication & Target Table**:
   - Table is `public.blog` (singular). Added `newsletter_broadcast_at timestamptz`.
   - Guarded by atomic CAS: only triggers when transitioning from `draft`/`archived` to `published` and `newsletter_broadcast_at IS NULL`.
5. **No Voucher Leaks in Public HTTP Response**:
   - `POST /api/user/newsletter/subscribe` returns confirmation message but does **not** leak the voucher code in JSON, requiring users to supply a valid inbox to retrieve the code.

---

## 3. Database Schema

### 3.1 Migration `108_feat_newsletter_blog_broadcast.sql`
- `newsletter_subscribers`:
  - `subscriber_id uuid primary key default gen_random_uuid()`
  - `email text not null`
  - `status text not null default 'active' check (status in ('active', 'unsubscribed'))`
  - `source text not null default 'storefront_footer'`
  - `unsubscribe_token text not null default encode(gen_random_bytes(24), 'hex')`
  - `metadata jsonb not null default '{}'::jsonb`
  - `subscribed_at timestamptz not null default now()`
  - `unsubscribed_at timestamptz`
  - `created_at timestamptz not null default now()`
  - `updated_at timestamptz not null default now()`
- `email_outbox` column additions:
  - `priority integer not null default 50`
  - `html_body text`
- `blog` column addition:
  - `newsletter_broadcast_at timestamptz`
- `voucher` seed:
  - `code: 'VELURA10'`, `name: 'Ưu đãi chào mừng 10%'`, `discount_type: 'percentage'`, `discount_value: 10`, `applicable_user_group: 'all_users'`

---

## 4. API Endpoints

### 4.1 `POST /api/user/newsletter/subscribe`
- **Auth**: Public
- **Rate Limit**: 5 req/min per IP
- **Input**: `{ "email": string, "source"?: string, "hp_website"?: string }` (honeypot field)
- **Output**: `{ "success": true, "message": "Đăng ký nhận tin thành công! Mã ưu đãi 10% đã được gửi tới email của bạn." }`

### 4.2 `GET /api/user/newsletter/unsubscribe?token=...`
- **Auth**: Public
- **Output**: Confirmation HTML or JSON response acknowledging unsubscription.

---

## 5. Storefront Frontend (`SiteFooter`)
- Angular 21 Standalone + Signals.
- Signals: `email = signal('')`, `isSubmitting = signal(false)`, `statusMessage = signal<string | null>(null)`, `errorMessage = signal<string | null>(null)`.
- Client-side validation: RFC 5322 regex.
- Accessible: `aria-live="polite"`, `[disabled]="isSubmitting()"`, `aria-describedby`.
