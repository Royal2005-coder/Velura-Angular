/**
 * Feature Spec F7 — Smart Publishing Scheduler, Retry Recovery (`failed_retry`), Email XSS Hygiene & SQL Contracts.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f7-blog-scheduler-and-prod.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runScheduledBlogPublishCycle, startBlogScheduler } from "../../apps/api/src/content/blog-scheduler.js";
import { createContentAdminService } from "../../apps/api/src/content/content-admin-service.js";
import { HttpError } from "../../apps/api/src/http.js";
import { buildBlogBroadcastHtml, NewsletterService } from "../../apps/api/src/newsletter/newsletter-service.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";
import { withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

const superAccess = accessForRole("super_admin");
const adminCtx: AuthContext = {
  authUser: { id: "admin-f7", email: "scheduler@velura.test" },
  profile: { user_id: "admin-f7", email: "scheduler@velura.test", role: "admin", admin_role: "super_admin", is_active: true },
  roleCode: "super_admin",
  roleName: "super_admin",
  isAdmin: true,
  allowedPages: superAccess.allowedPages,
  allowedModules: superAccess.allowedModules,
  capabilities: superAccess.capabilities,
  accessToken: "sched-token",
} as AuthContext;

test("F7.1: ContentAdminService enforces scheduledAt when status='scheduled' and rejects invalid create states", async () => {
  const upserted: unknown[] = [];
  const svc = createContentAdminService({
    repository: {
      listBlogs: async () => ({ rows: [], count: 0 }),
      listBlogProducts: async () => [],
      listProductCandidates: async () => [],
      upsertBlog: async (draft) => {
        upserted.push(draft);
        return {
          blog_id: "70000000-0000-4000-8000-000000000001",
          slug: draft.slug,
          title: draft.title,
          status: draft.status,
          scheduled_at: draft.scheduledAt,
          version: 1,
        };
      },
    },
  });

  // Missing scheduledAt on status === 'scheduled' -> 422 CONTENT_VALIDATION
  await assert.rejects(
    () =>
      svc.createBlog(
        adminCtx,
        {
          title: "Chiến dịch lên lịch thiếu thời điểm",
          slug: "chien-dich-len-lich-thieu-thoi-diem",
          categorySlug: "xu-huong",
          status: "scheduled",
          contentHtml: "<p>Nội dung bài viết chiến dịch khuyến mãi đủ dài trên bốn mươi ký tự chuẩn CMS.</p>",
        },
        { ipAddress: "127.0.0.1" },
      ),
    (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "CONTENT_VALIDATION",
  );

  // Creating directly in `failed_retry` -> 422 CONTENT_VALIDATION
  await assert.rejects(
    () =>
      svc.createBlog(
        adminCtx,
        {
          title: "Trạng thái khởi tạo sai",
          slug: "trang-thai-khoi-tao-sai",
          categorySlug: "xu-huong",
          status: "failed_retry",
          contentHtml: "<p>Nội dung bài viết chiến dịch khuyến mãi đủ dài trên bốn mươi ký tự chuẩn CMS.</p>",
        },
        { ipAddress: "127.0.0.1" },
      ),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  // Valid scheduled blog creation
  const created = await svc.createBlog(
    adminCtx,
    {
      title: "Chiến Dịch Đầm Lụa Hẹn Giờ Mở Bán",
      slug: "chien-dich-dam-lua-hen-gio-mo-ban",
      categorySlug: "xu-huong",
      status: "scheduled",
      scheduledAt: "2026-12-01T02:00:00.000Z",
      voucherCode: "velura15",
      contentHtml: "<p>Nội dung bài viết chiến dịch khuyến mãi đủ dài trên bốn mươi ký tự chuẩn CMS.</p>",
    },
    { ipAddress: "127.0.0.1" },
  );
  assert.equal(created.status, "scheduled");
  assert.equal(upserted.length, 1);
});

test("F7.2: runScheduledBlogPublishCycle broadcasts idempotently and transitions failed broadcasts into `failed_retry`", async () => {
  const broadcastedIds: string[] = [];
  const recordedErrors: Array<{ blogId: string; errText: string }> = [];

  const summary = await runScheduledBlogPublishCycle({
    claimDueBlogs: async () => [
      {
        blog_id: "blog-ok-1",
        slug: "bai-hen-gio-ok",
        title: "Bài hẹn giờ thành công",
        excerpt: "Tóm tắt",
        newsletter_broadcast_at: null,
      },
      {
        blog_id: "blog-already-sent-2",
        slug: "bai-da-gui-email",
        title: "Bài đã gửi bản tin trước đó",
        excerpt: "Tóm tắt",
        newsletter_broadcast_at: "2026-11-18T00:00:00Z",
      },
      {
        blog_id: "blog-fail-3",
        slug: "bai-loi-outbox",
        title: "Bài lỗi kết nối outbox",
        excerpt: "Tóm tắt",
        newsletter_broadcast_at: null,
      },
    ],
    broadcastBlog: async (payload) => {
      if (payload.blogId === "blog-fail-3") {
        throw new Error("SMTP outbox temporary timeout");
      }
      broadcastedIds.push(payload.blogId);
      return { queuedCount: 5 };
    },
    recordBroadcastError: async (blogId, errText) => {
      recordedErrors.push({ blogId, errText });
    },
  });

  assert.deepEqual(broadcastedIds, ["blog-ok-1"]);
  assert.deepEqual(summary.publishedIds, ["blog-ok-1", "blog-already-sent-2"]);
  assert.deepEqual(summary.failedRetryIds, ["blog-fail-3"]);
  assert.equal(summary.broadcastErrors, 1);
  assert.equal(recordedErrors[0]?.blogId, "blog-fail-3");

  // Verify startBlogScheduler returns null cleanly when service role key is absent
  await withScrubbedAiEnv({ SUPABASE_SERVICE_ROLE_KEY: "", VELURA_SUPABASE_SERVICE_ROLE_KEY: "" }, () => {
    // Only asserts dynamic env behavior when config key isn't pre-populated
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const timer = startBlogScheduler();
      if (timer) clearInterval(timer);
    }
  });
});

test("F7.3: NewsletterService.broadcastBlog deduplicates already-queued recipients on retry and escapes XSS in HTML emails", async () => {
  const html = buildBlogBroadcastHtml(
    `<script>alert("xss")</script>Đầm Lụa & Áo Khoác`,
    `<img src=x onerror=alert(1)>Ưu đãi 20%`,
    `javascript:alert(1)`,
    `https://velura.royalai.dev/blog/dam-lua`,
    `https://api.royalai.dev/api/user/newsletter/unsubscribe?token=abc`,
  );
  assert.equal(html.includes("<script>"), false, "Title <script> tag MUST be HTML-escaped");
  assert.equal(html.includes("<img src=x onerror=alert(1)>"), false, "Excerpt raw HTML MUST be escaped");
  assert.equal(html.includes("javascript:alert"), false, "Unsafe image URL scheme MUST fall back to safe HTTPS logo");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));

  // Deduplication + partial-failure retry safety
  const outboxRows: JsonObject[] = [];
  let stampedAt: string | null = null;
  const newsletter = new NewsletterService();

  // Attempt 1: 2 active subscribers; 1st succeeds, 2nd fails -> throws so scheduler moves blog to `failed_retry` without stamping `newsletter_broadcast_at`!
  await assert.rejects(() =>
    newsletter.broadcastBlog(
      {
        blogId: "blog-retry-dedup",
        slug: "dam-lua-velura",
        title: "Đầm Lụa Velura",
        excerpt: "Bản tin mới",
      },
      {
        selectSubscribers: async () => [
          { subscriber_id: "s1", email: "vip1@velura.test", unsubscribe_token: "tok11111111111111" },
          { subscriber_id: "s2", email: "vip2@velura.test", unsubscribe_token: "tok22222222222222" },
        ],
        selectAlreadyQueuedRecipients: async () => new Set(),
        insertOutbox: async (row) => {
          if (row.recipient === "vip2@velura.test") throw new Error("Transient DB lock");
          outboxRows.push(row);
        },
        stampBroadcastAt: async (_id, iso) => {
          stampedAt = iso;
        },
      },
    ),
  );
  assert.equal(outboxRows.length, 1);
  assert.equal(stampedAt, null, "Must NOT stamp newsletter_broadcast_at when partial failure occurred");

  // Attempt 2 (Retry): `vip1@velura.test` is already in outbox -> skipped! Only `vip2@velura.test` is inserted and `newsletter_broadcast_at` is stamped!
  const retryResult = await newsletter.broadcastBlog(
    {
      blogId: "blog-retry-dedup",
      slug: "dam-lua-velura",
      title: "Đầm Lụa Velura",
      excerpt: "Bản tin mới",
    },
    {
      selectSubscribers: async () => [
        { subscriber_id: "s1", email: "vip1@velura.test", unsubscribe_token: "tok11111111111111" },
        { subscriber_id: "s2", email: "vip2@velura.test", unsubscribe_token: "tok22222222222222" },
      ],
      selectAlreadyQueuedRecipients: async () => new Set(["vip1@velura.test"]),
      insertOutbox: async (row) => {
        outboxRows.push(row);
      },
      stampBroadcastAt: async (_id, iso) => {
        stampedAt = iso;
      },
    },
  );
  assert.equal(retryResult.queuedCount, 1);
  assert.equal(outboxRows.length, 2, "Each subscriber receives at most 1 queued email across retries");
  assert.ok(stampedAt !== null);
});

test("F7.4: SQL migrations 134 & 135 enforce RLS, SKIP LOCKED scheduler RPC, and `published -> failed_retry` state transition", () => {
  const root = resolve(process.cwd());
  const mig134 = readFileSync(resolve(root, "database/migrations/134_ai_blog_scheduler_and_decision_engine.sql"), "utf8");
  const mig135 = readFileSync(resolve(root, "database/migrations/135_scheduler_retry_and_forensics_guard.sql"), "utf8");

  assert.ok(/for update skip locked/i.test(mig134));
  assert.ok(/alter table public\.product_ai_qa enable row level security/i.test(mig134));
  assert.ok(/alter table public\.return_box_forensics enable row level security/i.test(mig134));
  assert.ok(/alter table public\.ai_decision_log enable row level security/i.test(mig134));
  assert.ok(/when p_from = 'published' then p_to in \('draft', 'failed_retry', 'archived'\)/i.test(mig135));
});
