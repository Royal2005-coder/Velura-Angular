/**
 * Feature Spec F4 — Scientific 4-Axis Product Image Quality Taxonomy & Studio Guardrails.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f4-product-image-qa.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { UnifiedDecisionService } from "../../apps/api/src/decision/decision-service.js";
import { HttpError } from "../../apps/api/src/http.js";
import { analyzeProductImageQuality } from "../../apps/api/src/products/product-ai-studio.js";
import { resolveSafePublicAssetPath } from "../../apps/api/src/security/safe-media-fetch.js";
import { getCachedSyntheticImage, mockDecisionResult, noul, score, withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

test("F4.1: decideProductImageQa classifies APPROVED_HERO, blocks CROP_CUTOFF from APPROVED_STANDARD, rejects minAxis <= 2.0, and caps flat/blank images", async () => {
  const [crispStudioImg, pureWhiteBlankImg, pitchDarkBlankImg] = await Promise.all([
    getCachedSyntheticImage("f4-studio", {
      width: 640,
      height: 640,
      bg: [250, 248, 245],
      subject: [122, 40, 60],
      crispGrid: true,
    }),
    getCachedSyntheticImage("f4-white-blank", {
      width: 640,
      height: 640,
      bg: [250, 250, 250],
      subject: [250, 250, 250],
      solidOnly: true,
    }),
    getCachedSyntheticImage("f4-dark-blank", {
      width: 640,
      height: 640,
      bg: [8, 8, 8],
      subject: [8, 8, 8],
      solidOnly: true,
    }),
  ]);

  // 1. High scores across all 4 axes -> APPROVED_HERO + blog_auto_eligible === true
  const heroSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sharpness_focus: score(3.8, 5, 0.93),
      lighting_exposure: score(3.7, 5, 0.92),
      composition_framing: score(3.6, 5, 0.91),
      background_cleanliness: score(3.9, 5, 0.94),
      has_watermark_or_text: noul(0.02),
      has_crop_cutoff: noul(0.03),
      has_cluttered_bg: noul(0.04),
    }),
  );
  const hero = await heroSvc.decideProductImageQa(crispStudioImg, "image/jpeg", { productName: "Đầm Lụa Burgundy" });
  assert.equal(hero.final_verdict, "APPROVED_HERO");
  assert.equal(hero.blog_auto_eligible, true);
  assert.ok(hero.average_taxonomy_score >= 4.3);

  // 2. Moderate crop cutoff (`has_crop_cutoff: 0.72` even with avg >= 3.8) -> MUST NOT be APPROVED_STANDARD; downgraded to NEEDS_EDIT (`P0-07`)
  const cropSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sharpness_focus: score(3.2, 5, 0.90),
      lighting_exposure: score(3.2, 5, 0.90),
      composition_framing: score(2.4, 5, 0.88),
      background_cleanliness: score(3.3, 5, 0.90),
      has_watermark_or_text: noul(0.03),
      has_crop_cutoff: noul(0.72),
      has_cluttered_bg: noul(0.08),
    }),
  );
  const cropped = await cropSvc.decideProductImageQa(crispStudioImg, "image/jpeg");
  assert.equal(cropped.final_verdict, "NEEDS_EDIT");
  assert.ok(cropped.defect_tags.includes("CROP_CUTOFF"));
  assert.equal(cropped.blog_auto_eligible, false);

  // 3. Catastrophic single-axis collapse (`composition_framing = 1.5 <= 2.0` despite 4.8 on other 3 axes -> avg 3.9) -> REJECTED (`P0-07`)
  const singleAxisCollapseSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sharpness_focus: score(3.8, 5, 0.92),
      lighting_exposure: score(3.8, 5, 0.92),
      composition_framing: score(0.5, 5, 0.92), // 1.5 <= 2.0 on 1..5 scale
      background_cleanliness: score(3.8, 5, 0.92),
      has_watermark_or_text: noul(0.02),
      has_crop_cutoff: noul(0.02),
      has_cluttered_bg: noul(0.02),
    }),
  );
  const collapsed = await singleAxisCollapseSvc.decideProductImageQa(crispStudioImg, "image/jpeg");
  assert.equal(collapsed.final_verdict, "REJECTED");
  assert.ok(collapsed.defect_tags.includes("CROP_CUTOFF"));

  // 4. Pure-white blank & pitch-dark blank images (`contrast < 2`) -> physicalCap = 1.8 forces REJECTED even if VLM hallucinated 5/5!
  const whiteBlankQa = await heroSvc.decideProductImageQa(pureWhiteBlankImg, "image/jpeg");
  assert.equal(whiteBlankQa.final_verdict, "REJECTED");
  assert.ok(whiteBlankQa.average_taxonomy_score <= 1.8);

  const darkBlankQa = await heroSvc.decideProductImageQa(pitchDarkBlankImg, "image/jpeg");
  assert.equal(darkBlankQa.final_verdict, "REJECTED");
  assert.ok(darkBlankQa.average_taxonomy_score <= 1.8);

  // 5. Borderline `[2.9..3.4]` -> NEEDS_EDIT with non-empty `defect_tags` and `actionable_fix` (`P1-04`)
  const borderlineSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      sharpness_focus: score(1.9, 5, 0.85),
      lighting_exposure: score(1.9, 5, 0.85),
      composition_framing: score(2.1, 5, 0.85),
      background_cleanliness: score(1.9, 5, 0.85),
      has_watermark_or_text: noul(0.05),
      has_crop_cutoff: noul(0.05),
      has_cluttered_bg: noul(0.05),
    }),
  );
  const borderline = await borderlineSvc.decideProductImageQa(crispStudioImg, "image/jpeg");
  assert.equal(borderline.final_verdict, "NEEDS_EDIT");
  assert.ok(borderline.defect_tags.length >= 1, "NEEDS_EDIT must always include at least one explanatory defect_tag");
  assert.ok(borderline.actionable_fix.length >= 1);
});

test("F4.2: analyzeProductImageQuality blocks path-traversal & SSRF URLs and respects shadow vs active rollout persistence", async () => {
  assert.throws(
    () => resolveSafePublicAssetPath("/assets/../../package.json"),
    (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "ASSET_PATH_FORBIDDEN",
  );
  assert.throws(
    () => resolveSafePublicAssetPath("/etc/passwd"),
    (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "ASSET_PATH_FORBIDDEN",
  );

  await assert.rejects(
    () => analyzeProductImageQuality({ imageUrl: "/assets/../../.env" }),
    (err: unknown) => err instanceof HttpError && err.code === "ASSET_PATH_FORBIDDEN",
  );
  await assert.rejects(
    () => analyzeProductImageQuality({ imageUrl: "https://169.254.169.254/latest/meta-data" }),
    (err: unknown) => err instanceof HttpError && err.code === "SSRF_HOST_BLOCKED",
  );

  const imgBytes = await getCachedSyntheticImage("f4-studio-b64", {
    width: 640,
    height: 640,
    bg: [250, 248, 245],
    subject: [122, 40, 60],
    crispGrid: true,
  });
  const base64 = imgBytes.toString("base64");
  const persistedIds: string[] = [];

  const mockDeps = {
    isDecisionConfigured: () => true,
    persistQa: async (productId: string) => {
      persistedIds.push(productId);
    },
    decisionService: {
      decideProductImageQa: async () => ({
        final_verdict: "APPROVED_HERO" as const,
        average_taxonomy_score: 4.75,
        axes: {
          sharpness_focus: 4.8,
          lighting_exposure: 4.7,
          composition_framing: 4.7,
          background_cleanliness: 4.8,
        },
        defect_tags: [],
        failed_taxonomy_codes: [],
        actionable_fix: [],
        blog_auto_eligible: true,
        confidence_score: 0.94,
        requires_human_review: false,
      }),
    },
  };

  const productId = "44444444-0000-4000-8000-000000000044";

  // Shadow mode -> runs Decision Engine for telemetry, does NOT overwrite overallScore or persist to product_ai_qa
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "shadow" }, async () => {
    const shadowRes = await analyzeProductImageQuality({ imageBase64: base64, productId }, mockDeps);
    assert.equal(shadowRes.decisionTaxonomy, undefined);
    assert.equal(persistedIds.length, 0);
  });

  // Active mode -> attaches decisionTaxonomy, blends overallScore >= 90 Grade A, and persists to product_ai_qa
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    const activeRes = await analyzeProductImageQuality({ imageBase64: base64, productId }, mockDeps);
    assert.equal(activeRes.decisionTaxonomy?.final_verdict, "APPROVED_HERO");
    assert.ok(activeRes.overallScore >= 90);
    assert.equal(activeRes.grade, "A");
    assert.deepEqual(persistedIds, [productId]);

    // When decisionTaxonomy returns REJECTED (e.g. watermark/cropped garment on bright studio bg),
    // passed MUST be false, grade = 'D', and actionable_fix MUST be surfaced in recommendations!
    const rejectedRes = await analyzeProductImageQuality(
      { imageBase64: base64 },
      {
        ...mockDeps,
        decisionService: {
          decideProductImageQa: async () => ({
            final_verdict: "REJECTED" as const,
            average_taxonomy_score: 2.1,
            axes: {
              sharpness_focus: 4.1,
              lighting_exposure: 4.0,
              composition_framing: 1.5,
              background_cleanliness: 4.2,
            },
            defect_tags: ["CROP_CUTOFF", "WATERMARK"],
            failed_taxonomy_codes: ["COMPOSITION_CROP_DEFECT", "WATERMARK_OR_TEXT_OVERLAY"],
            actionable_fix: ["Gỡ bỏ hoàn toàn watermark, logo bên thứ ba hoặc chữ đè lên sản phẩm."],
            blog_auto_eligible: false,
            confidence_score: 0.91,
            requires_human_review: false,
          }),
        },
      },
    );
    assert.equal(rejectedRes.passed, false);
    assert.equal(rejectedRes.grade, "D");
    assert.ok(rejectedRes.recommendations[0]?.includes("watermark"));
  });
});
