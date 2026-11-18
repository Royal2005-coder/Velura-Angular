/**
 * Feature Spec F6 — Auto-Blog SKU Curation & End-to-End AI Blog + Promotion Workflow.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f6-blog-curation-workflow.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  decideBlogEditorialGate,
  discoverInteractiveBlogTopics,
  generateEndToEndBlogWorkflow,
  matchSemanticInventoryProducts,
} from "../../apps/api/src/content/blog-ai-workflow.js";
import { UnifiedDecisionService } from "../../apps/api/src/decision/decision-service.js";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import type { AuthContext } from "../../apps/api/src/types.js";
import { choice, mockDecisionResult, noul, score, withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

const superAccess = accessForRole("super_admin");
const adminCtx: AuthContext = {
  authUser: { id: "admin-f6", email: "editor@velura.test" },
  profile: { user_id: "admin-f6", email: "editor@velura.test", role: "admin", admin_role: "super_admin", is_active: true },
  roleCode: "super_admin",
  roleName: "super_admin",
  isAdmin: true,
  allowedPages: superAccess.allowedPages,
  allowedModules: superAccess.allowedModules,
  capabilities: superAccess.capabilities,
  accessToken: "editor-token",
} as AuthContext;

const CATALOG_FIXTURE = [
  {
    product_id: "60000000-0000-4000-8000-000000000001",
    sku: "VLR-HERO-01",
    name: "Đầm Lụa Tơ Tằm Mulberry Đỏ Rượu",
    slug: "dam-lua-to-tam-mulberry-do-ruou",
    description: "Đầm lụa cao cấp dự tiệc tối thu đông tôn dáng.",
    base_price: 2_200_000,
    sale_price: 1_760_000,
    images: ["https://cdn.velura.vn/hero-01.jpg"],
    status: "on_sale",
    style_tags: ["Quiet Luxury", "Party", "Silk"],
    color_tone: "Warm",
    collection: "Winter Gala",
    available_stock: 14,
    image_qa_verdict: "APPROVED_HERO" as const,
    image_qa_score: 4.8,
    similarity: 0.93,
  },
  {
    product_id: "60000000-0000-4000-8000-000000000002",
    sku: "VLR-LOWSTK-02",
    name: "Áo Khoác Tweed Kem Phối Cúc Ngọc",
    slug: "ao-khoac-tweed-kem-phoi-cuc-ngoc",
    description: "Áo khoác tweed sang trọng số lượng còn rất ít.",
    base_price: 1_950_000,
    sale_price: null,
    images: ["https://cdn.velura.vn/tweed-02.jpg"],
    status: "on_sale",
    style_tags: ["Office", "Tweed"],
    color_tone: "Neutral",
    collection: "Winter Gala",
    available_stock: 2,
    image_qa_verdict: "APPROVED_STANDARD" as const,
    image_qa_score: 3.9,
    similarity: 0.85,
  },
  {
    product_id: "60000000-0000-4000-8000-000000000003",
    sku: "VLR-OOS-03",
    name: "Chân Váy Xếp Ly Đã Hết Kho",
    slug: "chan-vay-xep-ly-het-kho",
    description: "Sản phẩm hết hàng tồn kho bằng 0.",
    base_price: 890_000,
    sale_price: 590_000,
    images: ["https://cdn.velura.vn/oos-03.jpg"],
    status: "on_sale",
    style_tags: ["Office"],
    color_tone: "Cool",
    collection: "Core",
    available_stock: 0,
    image_qa_verdict: "APPROVED_HERO" as const,
    image_qa_score: 4.7,
    similarity: 0.99,
  },
  {
    product_id: "60000000-0000-4000-8000-000000000004",
    sku: "VLR-BADIMG-04",
    name: "Áo Sơ Mi Ảnh Bị Watermark",
    slug: "ao-so-mi-anh-watermark",
    description: "Ảnh chất lượng kém bị từ chối bởi QA.",
    base_price: 750_000,
    sale_price: 450_000,
    images: ["https://cdn.velura.vn/bad-04.jpg"],
    status: "on_sale",
    style_tags: ["Office"],
    color_tone: "Cool",
    collection: "Core",
    available_stock: 25,
    image_qa_verdict: "REJECTED" as const,
    image_qa_score: 1.9,
    similarity: 0.95,
  },
];

test("F6.1: decideAutoBlogProductCuration short-circuits OOS/REJECTED with 0 API calls and caps low-stock (<3) at SEMI_AUTO_REVIEW", async () => {
  let apiCalls = 0;
  const svc = new UnifiedDecisionService(async () => {
    apiCalls += 1;
    return mockDecisionResult({
      publish_mode: choice("AUTO_BLOG_PUBLISH", ["AUTO_BLOG_PUBLISH", "SEMI_AUTO_REVIEW", "EXCLUDE"], 0.92),
      campaign_fit: choice("HERO_PRODUCT", ["HERO_PRODUCT", "BUNDLE_ADDON", "CLEARANCE"], 0.90),
      commercial_readiness: {
        type: "score",
        score: 2.8,
        confidence: 0.91,
        probabilities: { "0": 0.01, "1": 0.03, "2": 0.05, "3": 0.91 },
        legend: { "0": "L0", "1": "L1", "2": "L2", "3": "L3" },
      },
    });
  });

  // 1. Out-of-stock -> deterministic EXCLUDE with 0 Decision API calls
  const oos = await svc.decideAutoBlogProductCuration({
    productId: CATALOG_FIXTURE[2].product_id,
    name: CATALOG_FIXTURE[2].name,
    availableStock: 0,
    basePrice: 890_000,
    salePrice: 590_000,
    imageQaVerdict: "APPROVED_HERO",
    imageQaScore: 4.8,
  });
  assert.equal(oos.publish_mode, "EXCLUDE");
  assert.equal(apiCalls, 0);

  // 2. REJECTED image -> deterministic EXCLUDE with 0 Decision API calls
  const rejectedImg = await svc.decideAutoBlogProductCuration({
    productId: CATALOG_FIXTURE[3].product_id,
    name: CATALOG_FIXTURE[3].name,
    availableStock: 25,
    basePrice: 750_000,
    imageQaVerdict: "REJECTED",
    imageQaScore: 1.9,
  });
  assert.equal(rejectedImg.publish_mode, "EXCLUDE");
  assert.equal(apiCalls, 0);

  // 3. Low stock (`availableStock = 2 < 3`) even when VLM votes AUTO_BLOG_PUBLISH -> capped at SEMI_AUTO_REVIEW
  const lowStock = await svc.decideAutoBlogProductCuration({
    productId: CATALOG_FIXTURE[1].product_id,
    name: CATALOG_FIXTURE[1].name,
    availableStock: 2,
    basePrice: 1_950_000,
    imageQaVerdict: "APPROVED_HERO",
    imageQaScore: 4.6,
  });
  assert.equal(lowStock.publish_mode, "SEMI_AUTO_REVIEW");
  assert.equal(lowStock.requires_human_review, true);
  assert.equal(apiCalls, 1);

  // 4. Healthy stock + APPROVED_HERO -> AUTO_BLOG_PUBLISH
  const hero = await svc.decideAutoBlogProductCuration({
    productId: CATALOG_FIXTURE[0].product_id,
    name: CATALOG_FIXTURE[0].name,
    availableStock: 14,
    basePrice: 2_200_000,
    salePrice: 1_760_000,
    imageQaVerdict: "APPROVED_HERO",
    imageQaScore: 4.8,
  });
  assert.equal(hero.publish_mode, "AUTO_BLOG_PUBLISH");

  // 5. Batch SKU curation (`decideAutoBlogProductCurationBatch`): 3 SKUs (1 OOS + 1 HERO + 1 STANDARD) execute in ONE single Decision API call!
  let batchApiCalls = 0;
  const batchSvc = new UnifiedDecisionService(async (req) => {
    batchApiCalls += 1;
    const answers: Record<string, ReturnType<typeof choice> | ReturnType<typeof score>> = {};
    for (const key of Object.keys(req.questions)) {
      if (key.endsWith("_mode")) answers[key] = choice("AUTO_BLOG_PUBLISH", ["AUTO_BLOG_PUBLISH", "SEMI_AUTO_REVIEW", "EXCLUDE"], 0.9);
      else if (key.endsWith("_fit")) answers[key] = choice("HERO_PRODUCT", ["HERO_PRODUCT", "BUNDLE_ADDON", "CLEARANCE"], 0.88);
      else answers[key] = score(2.8, 4, 0.9);
    }
    return mockDecisionResult(answers);
  });
  const batchOut = await batchSvc.decideAutoBlogProductCurationBatch([
    {
      productId: "oos-1",
      name: "Đầm Hết Hàng",
      availableStock: 0,
      basePrice: 1_500_000,
      salePrice: null,
      imageQaVerdict: "APPROVED_HERO",
      imageQaScore: 4.8,
    },
    {
      productId: "hero-1",
      name: "Đầm Lụa Hero",
      availableStock: 12,
      basePrice: 2_000_000,
      salePrice: 1_600_000,
      imageQaVerdict: "APPROVED_HERO",
      imageQaScore: 4.9,
    },
    {
      productId: "std-2",
      name: "Áo Sơ Mi Standard",
      availableStock: 8,
      basePrice: 980_000,
      salePrice: null,
      imageQaVerdict: "APPROVED_STANDARD",
      imageQaScore: 3.9,
    },
  ]);
  assert.equal(batchApiCalls, 1, "Batch curation MUST issue exactly 1 /v1beta/decisions call for all active SKUs");
  assert.equal(batchOut[0]?.publish_mode, "EXCLUDE");
  assert.equal(batchOut[1]?.publish_mode, "AUTO_BLOG_PUBLISH");
  assert.equal(batchOut[2]?.publish_mode, "SEMI_AUTO_REVIEW", "APPROVED_STANDARD ceiling enforced in batch mode too");
});

test("F6.2: matchSemanticInventoryProducts returns [] (never unfiltered pool!) when 0 items match filters and drops EXCLUDE verdicts", async () => {
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    // Only non-discounted item passed with discountOnly: true -> MUST return [] (`P0-08`)
    const emptyOnStrictDiscount = await matchSemanticInventoryProducts("Áo khoác tweed", {
      candidatesOverride: [CATALOG_FIXTURE[1]], // sale_price === null
      discountOnly: true,
    });
    assert.deepEqual(emptyOnStrictDiscount, [], "Must NEVER fall back to unfiltered pool when 0 items match discountOnly");

    // Only OOS + REJECTED items in pool -> MUST return []
    const emptyOnInvalidPool = await matchSemanticInventoryProducts("Chân váy công sở", {
      candidatesOverride: [CATALOG_FIXTURE[2], CATALOG_FIXTURE[3]],
    });
    assert.deepEqual(emptyOnInvalidPool, []);

    // When Decision Engine returns publish_mode === "EXCLUDE" for a candidate, that SKU MUST be dropped (`P0-08`)
    const droppedOnExclude = await matchSemanticInventoryProducts("Đầm lụa dự tiệc", {
      candidatesOverride: [CATALOG_FIXTURE[0], CATALOG_FIXTURE[1]],
      decisionService: {
        decideAutoBlogProductCuration: async (item) => ({
          product_id: item.productId,
          publish_mode: item.productId === CATALOG_FIXTURE[1].product_id ? "EXCLUDE" : "AUTO_BLOG_PUBLISH",
          campaign_fit: "HERO_PRODUCT",
          curation_score: 92,
          confidence_score: 0.92,
          requires_human_review: false,
          rationale_vi: "Test curation",
        }),
      },
    });
    assert.equal(droppedOnExclude.length, 1);
    assert.equal(droppedOnExclude[0]?.product_id, CATALOG_FIXTURE[0].product_id);
  });
});

test("F6.3: decideBlogEditorialGate blocks fabricated coupon codes in socialCaptions and fails closed to `draft` on API outage", async () => {
  // 1. Clean article + verified voucher VELURA15 -> passes (`ai_reviewed`), whereas fabricated FAKE99 in Facebook caption fails!
  const passingEvaluator = async () =>
    mockDecisionResult({
      seo_structure_complete: noul(0.92, 0.91),
      brand_tone_aligned: noul(0.94, 0.92),
      zero_unverified_discounts: noul(0.95, 0.93),
    });

  const cleanGate = await decideBlogEditorialGate(
    {
      title: "5 Bản Phối Đầm Lụa Mulberry Tôn Dáng Dự Tiệc Tối",
      excerpt: "Khám phá thiết kế lụa tơ tằm sang trọng kèm ưu đãi chính thức.",
      metaTitle: "5 Bản Phối Đầm Lụa Dự Tiệc | Velura",
      metaDescription: "Bí quyết chọn đầm lụa dự tiệc sang trọng cùng Velura Atelier.",
      verifiedVoucherCode: "VELURA15",
      verifiedProductNames: [CATALOG_FIXTURE[0].name],
      articlePlain: "Bài viết phân tích chi tiết chất liệu lụa Mulberry và phom dáng cổ đổ thanh lịch áp dụng mã VELURA15.",
      socialCaptions: {
        facebookPage: "✨ Đầm Lụa Mulberry đã lên kệ — Nhập mã VELURA15 giảm ngay 15%!",
        zaloOa: "[Velura] Ưu đãi mã VELURA15 cho BST Winter Gala.",
        instagram: "Quiet Luxury ✨ #VeluraAtelier",
      },
    },
    { evaluateDecisions: passingEvaluator, recordAudit: async () => undefined },
  );
  assert.equal(cleanGate.passed, true);
  assert.equal(cleanGate.recommendedStatus, "ai_reviewed");

  // Inject hallucinated coupon `SUPER90` inside Facebook caption even if VLM missed it -> deterministic guard catches it!
  const hallucinatedSocialGate = await decideBlogEditorialGate(
    {
      title: "5 Bản Phối Đầm Lụa Mulberry Tôn Dáng Dự Tiệc Tối",
      excerpt: "Khám phá thiết kế lụa tơ tằm sang trọng.",
      metaTitle: "5 Bản Phối Đầm Lụa Dự Tiệc | Velura",
      metaDescription: "Bí quyết chọn đầm lụa dự tiệc sang trọng cùng Velura Atelier.",
      verifiedVoucherCode: "VELURA15",
      verifiedProductNames: [CATALOG_FIXTURE[0].name],
      articlePlain: "Bài viết chuẩn mực không có mã lạ trong thân bài.",
      socialCaptions: {
        facebookPage: "🔥 Săn sale chấn động: Nhập mã SUPER90 giảm 90% toàn bộ cửa hàng!",
        zaloOa: "[Velura] BST mới.",
        instagram: "Quiet Luxury ✨",
      },
    },
    { evaluateDecisions: passingEvaluator, recordAudit: async () => undefined },
  );
  assert.equal(hallucinatedSocialGate.passed, false);
  assert.equal(hallucinatedSocialGate.recommendedStatus, "draft");
  assert.equal(hallucinatedSocialGate.requiresHumanReview, true);
  assert.ok(hallucinatedSocialGate.zeroHallucinationProb <= 0.2);

  // 2. Decision API outage (503/timeout) -> MUST fail closed to `draft` + `requiresHumanReview: true` (`P0-09`)
  const outageGate = await decideBlogEditorialGate(
    {
      title: "Bài viết khi Decision API mất kết nối",
      excerpt: "Tóm tắt bài viết.",
      metaTitle: "Tiêu đề SEO | Velura",
      metaDescription: "Mô tả SEO.",
      verifiedVoucherCode: null,
      verifiedProductNames: [],
      articlePlain: "Nội dung bài viết đầy đủ phục vụ kiểm thử fail-closed khi mạng gián đoạn.",
      socialCaptions: { facebookPage: "FB", zaloOa: "Zalo", instagram: "IG" },
    },
    {
      evaluateDecisions: async () => {
        throw new HttpError(503, "AI_PROVIDER_UNAVAILABLE", "Simulated outage");
      },
    },
  );
  assert.equal(outageGate.passed, false);
  assert.equal(outageGate.recommendedStatus, "draft");
  assert.equal(outageGate.requiresHumanReview, true);
  assert.equal(outageGate.confidence, 0);
});

test("F6.4: discoverInteractiveBlogTopics & generateEndToEndBlogWorkflow emit structured <h2>+<h3> SEO HTML and strip hallucinated UUIDs", async () => {
  const promos = {
    promotions: [
      {
        promo_id: "77777777-0000-4000-8000-000000000001",
        name: "Winter Gala 20%",
        type: "percentage",
        discount_value: 20,
        start_date: "2026-11-20T00:00:00Z",
        end_date: "2026-12-20T00:00:00Z",
        is_active: true,
      },
    ],
    vouchers: [
      {
        voucher_id: "88888888-0000-4000-8000-000000000001",
        code: "GALA20",
        name: "Ưu đãi Gala 20%",
        discount_type: "percentage",
        discount_value: 20,
        start_date: "2026-11-20T00:00:00Z",
        end_date: "2026-12-20T00:00:00Z",
      },
    ],
  };

  const topicsRes = await discoverInteractiveBlogTopics(
    adminCtx,
    { campaignGoal: " Đầm dự tiệc cuối năm ", campaignType: "collection_launch" },
    {
      candidates: CATALOG_FIXTURE,
      categories: ["xu-huong"],
      promos,
      generateJson: async () => ({
        modelUsed: "gemini-3.5-flash",
        usedFallbackKey: false,
        data: {
          topics: [
            {
              title: "Nghệ Thuật Phối Đầm Lụa Dự Tiệc Mùa Lễ Hội",
              angle: "Tôn vinh chất liệu lụa tơ tằm.",
              campaignType: "collection_launch",
              primaryKeyword: "đầm lụa dự tiệc",
              secondaryKeywords: ["quiet luxury", "váy đỏ rượu"],
              estimatedSearchIntent: "transactional",
              heroProductIds: [
                CATALOG_FIXTURE[0].product_id,
                "99999999-9999-4999-8999-999999999999", // Hallucinated UUID -> MUST be stripped!
              ],
            },
          ],
        },
      }),
    },
  );
  assert.equal(topicsRes.topics.length, 1);
  assert.deepEqual(topicsRes.topics[0]?.heroProductIds, [CATALOG_FIXTURE[0].product_id]);

  const draft = await generateEndToEndBlogWorkflow(
    adminCtx,
    {
      title: "Nghệ Thuật Phối Đầm Lụa Dự Tiệc Mùa Lễ Hội",
      primaryKeyword: "đầm lụa dự tiệc",
      secondaryKeywords: ["quiet luxury"],
      categorySlug: "xu-huong",
      promoId: "77777777-0000-4000-8000-000000000001",
      voucherCode: "GALA20",
      // Attempt to request both valid SKU, OOS SKU, and non-existent SKU -> only grounded in-stock SKU survives!
      productIds: [
        CATALOG_FIXTURE[0].product_id,
        CATALOG_FIXTURE[2].product_id,
        "99999999-9999-4999-8999-999999999999",
      ],
    },
    {
      candidates: CATALOG_FIXTURE,
      categories: ["xu-huong"],
      promos,
      decisionService: {
        decideAutoBlogProductCuration: async (item) => ({
          product_id: item.productId,
          publish_mode: "AUTO_BLOG_PUBLISH",
          campaign_fit: "HERO_PRODUCT",
          curation_score: 95,
          confidence_score: 0.94,
          requires_human_review: false,
          rationale_vi: "Grounded hero",
        }),
      },
      generateJson: async () => ({
        modelUsed: "gemini-3.5-flash",
        usedFallbackKey: false,
        data: {
          title: "Nghệ Thuật Phối Đầm Lụa Dự Tiệc Mùa Lễ Hội Cùng Velura",
          excerpt: "Bản giao hưởng lụa Mulberry tôn dáng thanh lịch cho đêm tiệc cuối năm.",
          metaTitle: "Phối Đầm Lụa Dự Tiệc Mùa Lễ Hội | Velura",
          metaDescription: "Khám phá bí quyết diện đầm lụa đỏ rượu sang trọng kèm ưu đãi GALA20.",
          tags: ["Đầm lụa", "Dự tiệc", "Velura Atelier"],
          sections: [
            {
              heading: "1. Chất liệu lụa Mulberry và độ rủ tự nhiên",
              paragraphs: ["Lụa tơ tằm thượng hạng giúp tôn đường nét thanh thoát dưới ánh đèn tiệc tối."],
              featuredProductId: CATALOG_FIXTURE[0].product_id,
            },
            {
              heading: "2. Phối phụ kiện ánh kim tinh giản",
              paragraphs: ["Kết hợp khuyên tai ngọc trai và ví cầm tay tối giản chuẩn Quiet Luxury."],
              featuredProductId: "99999999-9999-4999-8999-999999999999",
            },
          ],
          facebookPage: "✨ Đầm Lụa Mulberry mùa lễ hội — Nhập mã GALA20 nhận ưu đãi 20%!",
          zaloOa: "[Velura Atelier] Đầm lụa dự tiệc kèm mã GALA20.",
          instagram: "Winter Gala ✨ #VeluraAtelier",
        },
      }),
      evaluateDecisions: async () =>
        mockDecisionResult({
          seo_structure_complete: noul(0.95, 0.94),
          brand_tone_aligned: noul(0.96, 0.95),
          zero_unverified_discounts: noul(0.97, 0.95),
        }),
      recordAudit: async () => undefined,
    },
  );

  assert.equal(draft.recommendedStatus, "ai_reviewed");
  assert.equal(draft.editorialGate.passed, true);
  assert.ok(draft.contentHtml.includes("<h2>"), "Generated HTML must include structured <h2> section headings");
  assert.ok(draft.contentHtml.includes("<h3>"), "Generated HTML must include <h3> product callout subheadings");
  assert.deepEqual(draft.productIds, [CATALOG_FIXTURE[0].product_id]);
  assert.equal(draft.voucherCode, "GALA20");
});
