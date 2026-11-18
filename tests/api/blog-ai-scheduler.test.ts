import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverInteractiveBlogTopics,
  generateEndToEndBlogWorkflow,
  matchSemanticInventoryProducts,
} from "../../apps/api/src/content/blog-ai-workflow.js";
import { runScheduledBlogPublishCycle } from "../../apps/api/src/content/blog-scheduler.js";
import { createContentAdminService } from "../../apps/api/src/content/content-admin-service.js";
import { resetDecisionClientStateForTest } from "../../apps/api/src/decision/gemini-decision-client.js";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";

const superAdminAccess = accessForRole("super_admin");
const superAdminContext: AuthContext = {
  authUser: { id: "admin-1", email: "root@velura.test" },
  profile: { user_id: "admin-1", email: "root@velura.test", role: "admin", admin_role: "super_admin", is_active: true },
  roleCode: "super_admin",
  roleName: "super_admin",
  isAdmin: true,
  allowedPages: superAdminAccess.allowedPages,
  allowedModules: superAdminAccess.allowedModules,
  capabilities: superAdminAccess.capabilities,
  accessToken: "admin-token",
} as AuthContext;

const SAMPLE_CATALOG = [
  {
    product_id: "10000000-0000-4000-8000-000000000001",
    sku: "VLR-SILK-001",
    name: "Đầm Lụa Mulberry Cổ Đổ Burgundy",
    slug: "dam-lua-mulberry-co-do-burgundy",
    description: "Đầm lụa tơ tằm cao cấp tôn dáng dự tiệc mùa thu.",
    base_price: 1890000,
    sale_price: 1490000,
    images: ["https://cdn.velura.vn/silk-1.jpg"],
    status: "on_sale",
    style_tags: ["Quiet Luxury", "Silk", "Party"],
    color_tone: "Cool",
    collection: "Autumn Atelier",
    available_stock: 16,
    image_qa_verdict: "APPROVED_HERO" as const,
    image_qa_score: 4.8,
    similarity: 0.91,
  },
  {
    product_id: "10000000-0000-4000-8000-000000000002",
    sku: "VLR-OOS-002",
    name: "Áo Sơ Mi Hết Hàng",
    slug: "ao-so-mi-het-hang",
    description: "Sản phẩm hết tồn kho không được phép đưa vào bài blog khuyến mãi.",
    base_price: 890000,
    sale_price: 690000,
    images: ["https://cdn.velura.vn/oos.jpg"],
    status: "on_sale",
    style_tags: ["Office"],
    color_tone: "Neutral",
    collection: "Core",
    available_stock: 0,
    image_qa_verdict: "APPROVED_HERO" as const,
    image_qa_score: 4.7,
    similarity: 0.95,
  },
  {
    product_id: "10000000-0000-4000-8000-000000000003",
    sku: "VLR-REJECT-003",
    name: "Chân Váy Ảnh Bị Lỗi Watermark",
    slug: "chan-vay-anh-loi",
    description: "Sản phẩm có ảnh bị REJECTED bởi Visual QA.",
    base_price: 750000,
    sale_price: 590000,
    images: ["https://cdn.velura.vn/reject.jpg"],
    status: "on_sale",
    style_tags: ["Casual"],
    color_tone: "Warm",
    collection: "Core",
    available_stock: 25,
    image_qa_verdict: "REJECTED" as const,
    image_qa_score: 1.9,
    similarity: 0.96,
  },
  {
    product_id: "10000000-0000-4000-8000-000000000004",
    sku: "VLR-LINEN-004",
    name: "Áo Blazer Linen Kem Thanh Lịch",
    slug: "ao-blazer-linen-kem",
    description: "Blazer linen thoáng mát phối công sở chuẩn Quiet Luxury.",
    base_price: 1650000,
    sale_price: null,
    images: ["https://cdn.velura.vn/linen.jpg"],
    status: "on_sale",
    style_tags: ["Quiet Luxury", "Office"],
    color_tone: "Warm",
    collection: "Autumn Atelier",
    available_stock: 12,
    image_qa_verdict: "APPROVED_STANDARD" as const,
    image_qa_score: 3.9,
    similarity: 0.82,
  },
];

test("matchSemanticInventoryProducts enforces hard stock > 0, non-REJECTED image QA, discount/hero filters, and zero hallucinated SKUs", async () => {
  const prevLocal = process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
  const prevPrimary = process.env.GEMINI_PRIMARY_KEY;
  const prevFallback = process.env.GEMINI_FALLBACK_FREE_KEY;
  process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = "false";
  process.env.GEMINI_PRIMARY_KEY = "";
  process.env.GEMINI_FALLBACK_FREE_KEY = "";
  resetDecisionClientStateForTest();

  try {
    const allMatches = await matchSemanticInventoryProducts("phối đồ đầm lụa quiet luxury dự tiệc", {
      candidatesOverride: SAMPLE_CATALOG,
      limit: 6,
    });

    // Out-of-stock (0002) and REJECTED image (0003) are strictly excluded!
    const ids = allMatches.map((m) => m.product_id);
    assert.ok(ids.includes("10000000-0000-4000-8000-000000000001"));
    assert.ok(ids.includes("10000000-0000-4000-8000-000000000004"));
    assert.ok(!ids.includes("10000000-0000-4000-8000-000000000002"));
    assert.ok(!ids.includes("10000000-0000-4000-8000-000000000003"));

    // Discount-only + Hero-only narrows to exact discounted APPROVED_HERO SKU
    const heroDiscountOnly = await matchSemanticInventoryProducts("đầm lụa sale", {
      candidatesOverride: SAMPLE_CATALOG,
      discountOnly: true,
      heroImagesOnly: true,
      limit: 6,
    });
    assert.equal(heroDiscountOnly.length, 1);
    assert.equal(heroDiscountOnly[0].sku, "VLR-SILK-001");
  } finally {
    if (prevLocal === undefined) delete process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
    else process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = prevLocal;
    if (prevPrimary === undefined) delete process.env.GEMINI_PRIMARY_KEY;
    else process.env.GEMINI_PRIMARY_KEY = prevPrimary;
    if (prevFallback === undefined) delete process.env.GEMINI_FALLBACK_FREE_KEY;
    else process.env.GEMINI_FALLBACK_FREE_KEY = prevFallback;
    resetDecisionClientStateForTest();
  }
});

test("discoverInteractiveBlogTopics & generateEndToEndBlogWorkflow produce SEO HTML, grounded SKUs, and social captions", async () => {
  const prevLocal = process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
  const prevPrimary = process.env.GEMINI_PRIMARY_KEY;
  const prevFallback = process.env.GEMINI_FALLBACK_FREE_KEY;
  process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = "false";
  process.env.GEMINI_PRIMARY_KEY = "";
  process.env.GEMINI_FALLBACK_FREE_KEY = "";
  resetDecisionClientStateForTest();

  try {
    const discovered = await discoverInteractiveBlogTopics(
      superAdminContext,
      { campaignGoal: "Flash Sale Thu Đông Quiet Luxury", campaignType: "double_day_sale" },
      { candidates: SAMPLE_CATALOG, categories: ["xu-huong"] },
    );
    assert.ok(discovered.topics.length >= 3);
    assert.equal(discovered.topics[0].recommendedCategorySlug, "xu-huong");

    const chosen = discovered.topics[0];
    const workflow = await generateEndToEndBlogWorkflow(
      superAdminContext,
      {
        title: chosen.title,
        angle: chosen.angle,
        primaryKeyword: chosen.primaryKeyword,
        secondaryKeywords: chosen.secondaryKeywords,
        categorySlug: "xu-huong",
      },
      { candidates: SAMPLE_CATALOG },
    );

    assert.ok(workflow.title.length >= 10);
    assert.ok(workflow.slug.length >= 5);
    assert.ok(workflow.contentHtml.includes("<h2>"));
    // Every attached product ID MUST exist in real grounded catalog (zero hallucinated SKUs)
    const allowedIds = new Set(SAMPLE_CATALOG.map((c) => c.product_id));
    for (const pid of workflow.productIds) {
      assert.ok(allowedIds.has(pid), `Hallucinated productId=${pid}`);
    }
    assert.ok(!workflow.productIds.includes("10000000-0000-4000-8000-000000000002"));
    assert.ok(!workflow.productIds.includes("10000000-0000-4000-8000-000000000003"));
    assert.ok(workflow.socialCaptions.facebookPage.length > 15);
    assert.ok(workflow.socialCaptions.zaloOa.length > 15);
    assert.ok(workflow.socialCaptions.instagram.length > 15);
    assert.equal(workflow.editorialGate.zeroHallucinationProb >= 0.9, true);
  } finally {
    if (prevLocal === undefined) delete process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK;
    else process.env.ALLOW_LOCAL_GEMINI_ENV_FALLBACK = prevLocal;
    if (prevPrimary === undefined) delete process.env.GEMINI_PRIMARY_KEY;
    else process.env.GEMINI_PRIMARY_KEY = prevPrimary;
    if (prevFallback === undefined) delete process.env.GEMINI_FALLBACK_FREE_KEY;
    else process.env.GEMINI_FALLBACK_FREE_KEY = prevFallback;
    resetDecisionClientStateForTest();
  }
});

test("ContentAdminService validates scheduledAt when status='scheduled' and runScheduledBlogPublishCycle broadcasts newsletter once", async () => {
  const savedDrafts: unknown[] = [];
  const service = createContentAdminService({
    repository: {
      listBlogs: async () => ({ rows: [], count: 0 }),
      listBlogProducts: async () => [],
      listProductCandidates: async () => [],
      upsertBlog: async (draft) => {
        savedDrafts.push(draft);
        return {
          blog_id: "blog-sched-1",
          slug: draft.slug,
          title: draft.title,
          status: draft.status,
          scheduled_at: draft.scheduledAt,
          version: 1,
        };
      },
    },
  });

  // Missing scheduledAt when status === 'scheduled' must fail 422 CONTENT_VALIDATION
  await assert.rejects(
    () =>
      service.createBlog(
        superAdminContext,
        {
          slug: "sale-ngay-doi-11-11",
          title: "Flash Sale Ngày Đôi 11.11 Săn Đầm Lụa Velura",
          categorySlug: "xu-huong",
          status: "scheduled",
          contentHtml: "<p>Nội dung bài viết chiến dịch khuyến mãi đủ dài trên bốn mươi ký tự chuẩn CMS.</p>",
        },
        {},
      ),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  // Valid future ISO scheduledAt succeeds
  const futureIso = new Date(Date.now() + 7200_000).toISOString();
  const created = await service.createBlog(
    superAdminContext,
    {
      slug: "sale-ngay-doi-11-11",
      title: "Flash Sale Ngày Đôi 11.11 Săn Đầm Lụa Velura",
      categorySlug: "xu-huong",
      status: "scheduled",
      scheduledAt: futureIso,
      voucherCode: "VELURA20",
      contentHtml: "<p>Nội dung bài viết chiến dịch khuyến mãi đủ dài trên bốn mươi ký tự chuẩn CMS.</p>",
    },
    {},
  );
  assert.equal(created.status, "scheduled");
  assert.equal(savedDrafts.length, 1);

  // Verify scheduler publishes due posts and skips re-broadcasting posts that already have `newsletter_broadcast_at`
  const broadcasted: string[] = [];
  const recordedErrors: Array<{ id: string; err: string }> = [];
  const summary = await runScheduledBlogPublishCycle({
    claimDueBlogs: async () =>
      [
        {
          blog_id: "b-due-1",
          slug: "sale-1",
          title: "Bài hẹn giờ 1",
          excerpt: "Tóm tắt",
          newsletter_broadcast_at: null,
        },
        {
          blog_id: "b-due-2",
          slug: "sale-2",
          title: "Bài hẹn giờ đã gửi mail",
          excerpt: "Tóm tắt",
          newsletter_broadcast_at: "2026-11-18T00:00:00Z",
        },
      ] as JsonObject[],
    broadcastBlog: async (payload) => {
      broadcasted.push(payload.blogId);
      return { sent: 12, failed: 0 };
    },
    recordBroadcastError: async (id, err) => {
      recordedErrors.push({ id, err });
    },
  });

  assert.equal(summary.publishedCount, 2);
  assert.deepEqual(broadcasted, ["b-due-1"]);
  assert.equal(summary.broadcastErrors, 0);
  assert.equal(recordedErrors.length, 0);
});
