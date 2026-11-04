# Implementation Tasks: Newsletter Subscription & Automated Blog Broadcast System

**Feature ID**: `FEAT-NEWSLETTER-BLOG-BROADCAST`  
**Jira/Ticket**: `KAN-67`  
**Status**: APPROVED

---

## Tasks Breakdown

- [ ] **TASK-1: Create Migration 108 for Newsletter Subscribers, Outbox Priority & Voucher Seed**
  - Path: `database/migrations/108_feat_newsletter_blog_broadcast.sql`
  - Acceptance: Table `newsletter_subscribers` created; `email_outbox` has `priority` and `html_body`; `velura_claim_email_outbox` prioritizes transactional emails; `blog.newsletter_broadcast_at` added; `VELURA10` seeded in `public.voucher`.

- [ ] **TASK-2: Upgrade Outbox Worker with HTML Body & RFC 8058 Headers**
  - Path: `apps/api/src/email/outbox-worker.ts`
  - Acceptance: `deliverWithSmtp` passes `html` property to Nodemailer if `html_body` or `metadata.html` exists; adds List-Unsubscribe header.

- [ ] **TASK-3: Implement Newsletter Service & Router in API Gateway**
  - Paths: `apps/api/src/newsletter/newsletter-service.ts`, `apps/api/src/newsletter/newsletter-router.ts`, `apps/api/src/user/index.ts`
  - Acceptance: `POST /api/user/newsletter/subscribe` validates email, upserts subscriber, sends luxury welcome email with `VELURA10` voucher; `GET /api/user/newsletter/unsubscribe` disables subscription; mounted under `/api/user/newsletter`.

- [ ] **TASK-4: Hook Blog CMS Publication with Automated Newsletter Broadcast**
  - Paths: `apps/api/src/content/content-admin-service.ts`, `apps/api/src/newsletter/newsletter-service.ts`
  - Acceptance: When a blog is published (`status === 'published'`), the service triggers `broadcastBlog` to all active subscribers with high-fashion HTML layout and stamps `newsletter_broadcast_at`.

- [ ] **TASK-5: Enhance Storefront SiteFooter with Angular Signals & Real Submission**
  - Paths: `apps/user-ng/src/app/layout/site-footer/site-footer.ts`, `apps/user-ng/src/app/layout/site-footer/site-footer.html`, `apps/user-ng/src/styles-velura/layouts/_footer.css`
  - Acceptance: Footer form binds email signal, validates on submit, handles loading/submitting state, shows success/error messages with full accessibility.

- [ ] **TASK-6: Add Comprehensive Unit Tests & Run Verification Suite**
  - Paths: `apps/user-ng/src/app/layout/site-footer/site-footer.spec.ts`, `tests/api/newsletter.test.ts`
  - Acceptance: All unit tests pass; `typecheck:api`, `test:api`, `test:user`, and builds pass with zero errors.

- [ ] **TASK-7: Commit, PR to develop, Merge, Promote to main, and Verify Production Rollout**
  - Acceptance: CI passes, merged to develop, promoted to main, verified on live production endpoints.
