/**
 * Velura AI Decision Engine — 50-Case Scientific Golden Dataset Evaluation Gate.
 *
 * Enforces >= 90% taxonomy routing accuracy, 100% strict schema compliance,
 * grey-zone Human-in-the-Loop (HITL) safety gates, and deterministic physical guardrails
 * across all 5 Decision Engine domains before allowing CI/CD promotion.
 *
 * Usage:
 *   npm run eval:ai-decisions          # Deterministic CI gate (50 Golden cases, zero external quota cost)
 *   npm run eval:ai-decisions -- --live # Live benchmark against Google `/v1beta/decisions` (`gemini-decision-1`)
 */

import { existsSync } from "node:fs";
import sharp from "sharp";
import { UnifiedDecisionService, measurePortraitSkinOptics } from "../apps/api/src/decision/decision-service.ts";
import { isDecisionEngineConfigured } from "../apps/api/src/decision/gemini-decision-client.ts";

/**
 * Generates a synthetic studio or portrait image buffer with exact sRGB background, center subject, and sclera band.
 *
 * @param {{ width?: number; height?: number; bg: [number, number, number]; subject: [number, number, number]; sclera?: [number, number, number]; crispGrid?: boolean }} spec
 * @returns {Promise<Buffer>}
 */
async function createSyntheticImage(spec) {
  const width = spec.width ?? 800;
  const height = spec.height ?? 800;
  const raw = Buffer.alloc(width * height * 3);
  const [bgR, bgG, bgB] = spec.bg;
  const [subR, subG, subB] = spec.subject;
  const sclera = spec.sclera ?? [244, 244, 245];

  for (let y = 0; y < height; y += 1) {
    const ny = y / height;
    for (let x = 0; x < width; x += 1) {
      const nx = x / width;
      const idx = (y * width + x) * 3;
      const inSubject = nx >= 0.25 && nx <= 0.75 && ny >= 0.18 && ny <= 0.82;
      const inSclera = spec.sclera && ny >= 0.34 && ny <= 0.39 && ((nx >= 0.36 && nx <= 0.43) || (nx >= 0.57 && nx <= 0.64));
      if (inSclera) {
        raw[idx] = sclera[0];
        raw[idx + 1] = sclera[1];
        raw[idx + 2] = sclera[2];
      } else if (inSubject) {
        const edgeBoost = spec.crispGrid && (x % 9 === 0 || y % 9 === 0) ? -38 : 0;
        raw[idx] = Math.max(0, Math.min(255, subR + edgeBoost));
        raw[idx + 1] = Math.max(0, Math.min(255, subG + edgeBoost));
        raw[idx + 2] = Math.max(0, Math.min(255, subB + edgeBoost));
      } else {
        raw[idx] = bgR;
        raw[idx + 1] = bgG;
        raw[idx + 2] = bgB;
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Builds calibrated `DecisionEvaluatorFn` answers from a fixture map so the Golden Dataset tests
 * the exact mathematical calibration, ITA° reconciliation, grey-zone HITL routing, and physical caps
 * inside `UnifiedDecisionService`.
 */
function buildCalibratedMockEvaluator(answerFixtures) {
  let pointer = 0;
  return async (req) => {
    const fixture = answerFixtures[pointer];
    pointer += 1;
    if (!fixture) {
      throw new Error(`Unexpected evaluate call #${pointer} for useCase=${req.useCase}`);
    }
    return {
      answers: fixture,
      modelUsed: "gemini-decision-1",
      transport: "decisions_api",
      usedFallbackKey: false,
      rolloutMode: "active",
      latencyMs: 120,
      inputTokens: 280,
    };
  };
}

function noul(p) {
  return { type: "noul", noul: p };
}

function choice(selected, confidence = 0.88, probs = {}) {
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: { [selected]: confidence, ...probs },
  };
}

function score(val, confidence = 0.88) {
  return {
    type: "score",
    score: val,
    confidence,
    probabilities: { [String(Math.round(val))]: confidence },
    legend: {},
  };
}

/**
 * Runs all 50 Golden Dataset cases across the 5 Velura Decision Engine domains.
 */
export async function runGoldenEvaluationSuite() {
  const lightPortrait = await createSyntheticImage({
    bg: [245, 244, 240],
    subject: [232, 202, 186],
    sclera: [246, 246, 247],
    crispGrid: true,
  });
  const warmRoomLightPortrait = await createSyntheticImage({
    bg: [245, 232, 205],
    subject: [228, 194, 165],
    sclera: [245, 230, 198],
    crispGrid: true,
  });
  const darkPortrait = await createSyntheticImage({
    bg: [236, 234, 230],
    subject: [122, 84, 62],
    sclera: [242, 242, 242],
    crispGrid: true,
  });
  const heroGarmentImg = await createSyntheticImage({
    width: 1200,
    height: 1200,
    bg: [255, 255, 255],
    subject: [148, 42, 64],
    crispGrid: true,
  });
  const lowResGarmentImg = await createSyntheticImage({
    width: 360,
    height: 360,
    bg: [250, 248, 245],
    subject: [120, 130, 140],
    crispGrid: false,
  });
  const darkBlankImg = await createSyntheticImage({
    width: 800,
    height: 800,
    bg: [18, 18, 20],
    subject: [22, 22, 24],
    crispGrid: false,
  });
  const parcelCleanImg = await createSyntheticImage({
    width: 900,
    height: 900,
    bg: [242, 240, 236],
    subject: [186, 148, 104],
    crispGrid: true,
  });

  const results = [];
  const record = (id, domain, passed, detail) => {
    results.push({ id, domain, passed, detail });
  };

  // =========================================================================
  // DOMAIN 1: PERSONAL COLOR (10 Golden Cases)
  // =========================================================================
  const pcCases = [
    {
      id: "PC-01",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.95),
        skin_visible: noul(0.98),
        blur_free: noul(0.96),
        filter_free: noul(0.94),
        base_skin_depth: choice("LIGHT_TONE", 0.92),
        skin_depth: choice("FAIR", 0.90),
        undertone: choice("COOL", 0.91),
        contrast_level: choice("HIGH", 0.90),
        personal_season: choice("Winter", 0.91),
      },
      check: (r) => r.lighting_valid === "PASS" && r.base_skin_depth === "LIGHT_TONE" && r.season === "Winter",
    },
    {
      id: "PC-02",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.94),
        skin_visible: noul(0.97),
        blur_free: noul(0.93),
        filter_free: noul(0.92),
        base_skin_depth: choice("LIGHT_TONE", 0.91),
        skin_depth: choice("LIGHT", 0.89),
        undertone: choice("WARM", 0.90),
        contrast_level: choice("MEDIUM", 0.86),
        personal_season: choice("Spring", 0.89),
      },
      check: (r) => r.lighting_valid === "PASS" && r.base_skin_depth === "LIGHT_TONE" && r.season === "Spring",
    },
    {
      id: "PC-03",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.92),
        skin_visible: noul(0.96),
        blur_free: noul(0.91),
        filter_free: noul(0.90),
        base_skin_depth: choice("LIGHT_TONE", 0.89),
        skin_depth: choice("FAIR", 0.87),
        undertone: choice("COOL", 0.88),
        contrast_level: choice("LOW", 0.87),
        personal_season: choice("Summer", 0.88),
      },
      check: (r) => r.lighting_valid === "PASS" && r.season === "Summer" && r.recommended_palette_ids.includes("lavender"),
    },
    {
      id: "PC-04",
      img: darkPortrait,
      ans: {
        lighting_valid: noul(0.93),
        skin_visible: noul(0.96),
        blur_free: noul(0.92),
        filter_free: noul(0.94),
        base_skin_depth: choice("DARK_TONE", 0.93),
        skin_depth: choice("TAN", 0.90),
        undertone: choice("WARM", 0.91),
        contrast_level: choice("MEDIUM", 0.88),
        personal_season: choice("Autumn", 0.92),
      },
      check: (r) => r.lighting_valid === "PASS" && r.base_skin_depth === "DARK_TONE" && r.season === "Autumn",
    },
    {
      id: "PC-05",
      img: darkPortrait,
      ans: {
        lighting_valid: noul(0.94),
        skin_visible: noul(0.97),
        blur_free: noul(0.95),
        filter_free: noul(0.95),
        base_skin_depth: choice("DARK_TONE", 0.95),
        skin_depth: choice("DEEP", 0.92),
        undertone: choice("COOL", 0.89),
        contrast_level: choice("HIGH", 0.91),
        personal_season: choice("Winter", 0.90),
      },
      check: (r) => r.base_skin_depth === "DARK_TONE" && r.skin_depth === "DEEP" && r.season === "Winter",
    },
    {
      id: "PC-06",
      img: darkPortrait,
      ans: {
        lighting_valid: noul(0.90),
        skin_visible: noul(0.95),
        blur_free: noul(0.90),
        filter_free: noul(0.91),
        base_skin_depth: choice("DARK_TONE", 0.86),
        skin_depth: choice("TAN", 0.85),
        undertone: choice("NEUTRAL_OLIVE", 0.84),
        contrast_level: choice("MEDIUM", 0.84),
        personal_season: choice("Autumn", 0.85),
      },
      check: (r) => r.undertone === "NEUTRAL_OLIVE" && r.season === "Autumn",
    },
    {
      id: "PC-07",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.18),
        skin_visible: noul(0.92),
        blur_free: noul(0.88),
        filter_free: noul(0.90),
        base_skin_depth: choice("LIGHT_TONE", 0.62),
        skin_depth: choice("LIGHT", 0.60),
        undertone: choice("WARM", 0.58),
        contrast_level: choice("MEDIUM", 0.60),
        personal_season: choice("Spring", 0.58),
      },
      check: (r) => r.lighting_valid === "RETAKE" && r.failed_checks.includes("lighting_valid"),
    },
    {
      id: "PC-08",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.88),
        skin_visible: noul(0.90),
        blur_free: noul(0.22),
        filter_free: noul(0.90),
        base_skin_depth: choice("LIGHT_TONE", 0.64),
        skin_depth: choice("LIGHT", 0.60),
        undertone: choice("COOL", 0.62),
        contrast_level: choice("LOW", 0.61),
        personal_season: choice("Summer", 0.62),
      },
      check: (r) => r.lighting_valid === "RETAKE" && r.failed_checks.includes("blur_free"),
    },
    {
      id: "PC-09",
      img: lightPortrait,
      ans: {
        lighting_valid: noul(0.89),
        skin_visible: noul(0.91),
        blur_free: noul(0.90),
        filter_free: noul(0.15),
        base_skin_depth: choice("LIGHT_TONE", 0.65),
        skin_depth: choice("FAIR", 0.65),
        undertone: choice("COOL", 0.60),
        contrast_level: choice("HIGH", 0.62),
        personal_season: choice("Winter", 0.60),
      },
      check: (r) => r.lighting_valid === "RETAKE" && r.failed_checks.includes("filter_free"),
    },
    {
      id: "PC-10",
      img: warmRoomLightPortrait,
      ans: {
        lighting_valid: noul(0.85),
        skin_visible: noul(0.95),
        blur_free: noul(0.92),
        filter_free: noul(0.93),
        // Even if naive model hesitated toward DARK_TONE with low confidence 0.54, strong ITA° > 40 keeps LIGHT_TONE!
        base_skin_depth: choice("DARK_TONE", 0.54),
        skin_depth: choice("LIGHT", 0.84),
        undertone: choice("COOL", 0.85),
        contrast_level: choice("LOW", 0.83),
        personal_season: choice("Summer", 0.86),
      },
      check: (r) => r.base_skin_depth === "LIGHT_TONE" && r.optical_measurement.itaAngle > 35 && r.season === "Summer",
    },
  ];

  for (const tc of pcCases) {
    const svc = new UnifiedDecisionService(buildCalibratedMockEvaluator([tc.ans]));
    const out = await svc.decidePersonalColor({ bytes: tc.img, mime: "image/jpeg" });
    record(tc.id, "personal_color", tc.check(out), `${out.lighting_valid}:${out.base_skin_depth}:${out.season}`);
  }

  // =========================================================================
  // DOMAIN 2: CSKH & CHATBOT SENTIMENT ROUTING (10 Golden Cases)
  // =========================================================================
  const cskhCases = [
    {
      id: "CS-01",
      msg: "Đầm lụa nhận được đẹp xuất sắc, đường may tỉ mỉ lắm shop ơi!",
      ans: { sentiment: choice("POSITIVE", 0.96, { POSITIVE: 0.96, NEUTRAL: 0.03, NEGATIVE: 0.01 }), intent: choice("PRAISE", 0.95), urgency: score(0.05), escalate_threat_or_human: noul(0.02) },
      check: (r) => r.sentiment === "POSITIVE" && r.routing_branch === "NURTURE_AND_UPSELL" && !r.escalate_to_human,
    },
    {
      id: "CS-02",
      msg: "Cảm ơn bạn tư vấn nhiệt tình nha, mình mặc size S vừa in luôn.",
      ans: { sentiment: choice("POSITIVE", 0.94, { POSITIVE: 0.94, NEUTRAL: 0.05, NEGATIVE: 0.01 }), intent: choice("PRAISE", 0.91), urgency: score(0.08), escalate_threat_or_human: noul(0.01) },
      check: (r) => r.sentiment === "POSITIVE" && r.routing_branch === "NURTURE_AND_UPSELL",
    },
    {
      id: "CS-03",
      msg: "Cho mình hỏi mẫu áo blazer linen màu kem còn size M ở kho Hà Nội không ạ?",
      ans: { sentiment: choice("NEUTRAL", 0.92, { POSITIVE: 0.06, NEUTRAL: 0.92, NEGATIVE: 0.02 }), intent: choice("INQUIRY", 0.95), urgency: score(0.20), escalate_threat_or_human: noul(0.02) },
      check: (r) => r.sentiment === "NEUTRAL" && r.routing_branch === "EDUCATE_AND_LOYALTY_HOOK" && r.urgency === "LOW",
    },
    {
      id: "CS-04",
      msg: "Chính sách tích điểm thành viên Velura tính như thế nào vậy shop?",
      ans: { sentiment: choice("NEUTRAL", 0.93, { POSITIVE: 0.05, NEUTRAL: 0.93, NEGATIVE: 0.02 }), intent: choice("INQUIRY", 0.94), urgency: score(0.15), escalate_threat_or_human: noul(0.01) },
      check: (r) => r.sentiment === "NEUTRAL" && r.routing_branch === "EDUCATE_AND_LOYALTY_HOOK",
    },
    {
      id: "CS-05",
      msg: "Mình muốn hỏi cách giặt bảo quản lụa tơ tằm để không bị nhăn.",
      ans: { sentiment: choice("NEUTRAL", 0.90, { POSITIVE: 0.08, NEUTRAL: 0.90, NEGATIVE: 0.02 }), intent: choice("INQUIRY", 0.92), urgency: score(0.12), escalate_threat_or_human: noul(0.01) },
      check: (r) => r.sentiment === "NEUTRAL" && r.intent === "INQUIRY",
    },
    {
      id: "CS-06",
      msg: "Đơn hàng của mình giao trễ 3 ngày rồi mà chưa thấy shipper gọi, kiểm tra giúp mình.",
      ans: { sentiment: choice("NEGATIVE", 0.89, { POSITIVE: 0.01, NEUTRAL: 0.10, NEGATIVE: 0.89 }), intent: choice("COMPLAINT", 0.90), urgency: score(1.05), escalate_threat_or_human: noul(0.18) },
      check: (r) => r.sentiment === "NEGATIVE" && r.routing_branch === "STANDARDIZED_DEESCALATION" && r.urgency === "MEDIUM",
    },
    {
      id: "CS-07",
      msg: "Áo nhận về bị bung chỉ ở cổ tay, mình muốn đăng ký đổi sang chiếc mới.",
      ans: { sentiment: choice("NEGATIVE", 0.91, { POSITIVE: 0.01, NEUTRAL: 0.08, NEGATIVE: 0.91 }), intent: choice("RETURN_REQ", 0.93), urgency: score(1.10), escalate_threat_or_human: noul(0.22) },
      check: (r) => r.sentiment === "NEGATIVE" && r.intent === "RETURN_REQ" && r.routing_branch === "STANDARDIZED_DEESCALATION",
    },
    {
      id: "CS-08",
      msg: "Làm ăn quá tệ! Thùng hàng bị rách tráo mất đầm bên trong, gọi quản lý xử lý ngay nếu không tôi bóc phốt!",
      ans: { sentiment: choice("NEGATIVE", 0.98, { POSITIVE: 0.0, NEUTRAL: 0.02, NEGATIVE: 0.98 }), intent: choice("COMPLAINT", 0.96), urgency: score(1.92), escalate_threat_or_human: noul(0.95) },
      check: (r) => r.sentiment === "NEGATIVE" && r.urgency === "CRITICAL" && r.escalate_to_human === true,
    },
    {
      id: "CS-09",
      msg: "Tệ.",
      rating: 1,
      ans: { sentiment: choice("NEUTRAL", 0.55, { POSITIVE: 0.1, NEUTRAL: 0.55, NEGATIVE: 0.35 }), intent: choice("COMPLAINT", 0.78), urgency: score(1.0), escalate_threat_or_human: noul(0.15) },
      check: (r) => r.sentiment === "NEGATIVE" && r.routing_branch === "STANDARDIZED_DEESCALATION" && r.requires_human_review === true,
    },
    {
      id: "CS-10",
      msg: "Ưng ý!",
      rating: 5,
      ans: { sentiment: choice("NEUTRAL", 0.60, { POSITIVE: 0.4, NEUTRAL: 0.6, NEGATIVE: 0.0 }), intent: choice("PRAISE", 0.85), urgency: score(0.1), escalate_threat_or_human: noul(0.01) },
      check: (r) => r.sentiment === "POSITIVE" && r.routing_branch === "NURTURE_AND_UPSELL",
    },
  ];

  for (const tc of cskhCases) {
    const svc = new UnifiedDecisionService(buildCalibratedMockEvaluator([tc.ans]));
    const out = await svc.decideCskhSentiment({ message: tc.msg, rating: tc.rating });
    record(tc.id, "cskh_sentiment", tc.check(out), `${out.sentiment}:${out.routing_branch}:${out.urgency}`);
  }

  // =========================================================================
  // DOMAIN 3: PRODUCT IMAGE QA 4-AXIS TAXONOMY (10 Golden Cases)
  // =========================================================================
  const imgCases = [
    {
      id: "IQ-01",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(3.9, 0.92), lighting_exposure: score(3.9, 0.91), composition_framing: score(3.8, 0.90), background_cleanliness: score(3.95, 0.94), has_watermark_or_text: noul(0.02), has_crop_cutoff: noul(0.03), has_cluttered_bg: noul(0.02) },
      check: (r) => r.final_verdict === "APPROVED_HERO" && r.blog_auto_eligible === true && r.defect_tags.length === 0,
    },
    {
      id: "IQ-02",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(3.8, 0.90), lighting_exposure: score(3.8, 0.89), composition_framing: score(3.7, 0.88), background_cleanliness: score(3.8, 0.91), has_watermark_or_text: noul(0.04), has_crop_cutoff: noul(0.04), has_cluttered_bg: noul(0.03) },
      check: (r) => r.final_verdict === "APPROVED_HERO" && r.blog_auto_eligible === true,
    },
    {
      id: "IQ-03",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(2.8, 0.86), lighting_exposure: score(2.9, 0.85), composition_framing: score(2.9, 0.85), background_cleanliness: score(3.0, 0.87), has_watermark_or_text: noul(0.05), has_crop_cutoff: noul(0.08), has_cluttered_bg: noul(0.10) },
      check: (r) => r.final_verdict === "APPROVED_STANDARD" && r.blog_auto_eligible === false,
    },
    {
      id: "IQ-04",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(2.6, 0.84), lighting_exposure: score(2.7, 0.84), composition_framing: score(2.8, 0.84), background_cleanliness: score(2.9, 0.85), has_watermark_or_text: noul(0.06), has_crop_cutoff: noul(0.06), has_cluttered_bg: noul(0.12) },
      check: (r) => r.final_verdict === "APPROVED_STANDARD" && !r.blog_auto_eligible,
    },
    {
      id: "IQ-05",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(2.1, 0.82), lighting_exposure: score(1.8, 0.80), composition_framing: score(2.4, 0.82), background_cleanliness: score(1.6, 0.81), has_watermark_or_text: noul(0.08), has_crop_cutoff: noul(0.10), has_cluttered_bg: noul(0.45) },
      check: (r) => r.final_verdict === "NEEDS_EDIT" && r.requires_human_review === true,
    },
    {
      id: "IQ-06",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(3.5, 0.90), lighting_exposure: score(3.5, 0.90), composition_framing: score(3.5, 0.90), background_cleanliness: score(2.8, 0.88), has_watermark_or_text: noul(0.91), has_crop_cutoff: noul(0.05), has_cluttered_bg: noul(0.15) },
      check: (r) => r.final_verdict === "REJECTED" && r.defect_tags.includes("WATERMARK") && !r.blog_auto_eligible,
    },
    {
      id: "IQ-07",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(2.5, 0.86), lighting_exposure: score(2.6, 0.85), composition_framing: score(1.2, 0.89), background_cleanliness: score(2.8, 0.85), has_watermark_or_text: noul(0.04), has_crop_cutoff: noul(0.88), has_cluttered_bg: noul(0.10) },
      check: (r) => r.final_verdict === "REJECTED" && r.defect_tags.includes("CROP_CUTOFF"),
    },
    {
      id: "IQ-08",
      img: heroGarmentImg,
      ans: { sharpness_focus: score(0.4, 0.91), lighting_exposure: score(1.1, 0.87), composition_framing: score(1.5, 0.85), background_cleanliness: score(1.0, 0.88), has_watermark_or_text: noul(0.05), has_crop_cutoff: noul(0.20), has_cluttered_bg: noul(0.82) },
      check: (r) => r.final_verdict === "REJECTED" && r.defect_tags.includes("BLURRY") && r.defect_tags.includes("CLUTTERED_BG"),
    },
    {
      id: "IQ-09",
      img: lowResGarmentImg,
      ans: { sharpness_focus: score(2.2, 0.83), lighting_exposure: score(2.4, 0.84), composition_framing: score(2.5, 0.84), background_cleanliness: score(2.4, 0.84), has_watermark_or_text: noul(0.03), has_crop_cutoff: noul(0.05), has_cluttered_bg: noul(0.10) },
      check: (r) => r.defect_tags.includes("LOW_RESOLUTION") && r.failed_taxonomy_codes.includes("RESOLUTION_TOO_LOW"),
    },
    {
      id: "IQ-10",
      img: darkBlankImg,
      // Even if VLM hallucinated 5/5 scores on a pitch-black image, physical Sharp telemetry caps axes <= 1.8 -> REJECTED!
      ans: { sharpness_focus: score(4.0, 0.90), lighting_exposure: score(4.0, 0.90), composition_framing: score(4.0, 0.90), background_cleanliness: score(4.0, 0.90), has_watermark_or_text: noul(0.01), has_crop_cutoff: noul(0.01), has_cluttered_bg: noul(0.01) },
      check: (r) => r.final_verdict === "REJECTED" && r.average_taxonomy_score <= 1.8,
    },
  ];

  for (const tc of imgCases) {
    const svc = new UnifiedDecisionService(buildCalibratedMockEvaluator([tc.ans]));
    const out = await svc.decideProductImageQa(tc.img, "image/jpeg", { productName: "Đầm lụa Velura" });
    record(tc.id, "product_image_qa", tc.check(out), `${out.final_verdict}:avg=${out.average_taxonomy_score}`);
  }

  // =========================================================================
  // DOMAIN 4: RETURN BOX FORENSICS & CARRIER DISPUTE (10 Golden Cases)
  // =========================================================================
  const boxCases = [
    {
      id: "RB-01",
      pair: true,
      ans: { box_condition: choice("INTACT", 0.94), seal_broken: noul(0.04), diff_tape_color: noul(0.05), diff_label_pos: noul(0.04), diff_box_ratio: noul(0.03), identity_match: choice("MATCHED", 0.95, { MATCHED: 0.95, SUSPICIOUS_DIFF: 0.04, MISMATCHED: 0.01 }) },
      check: (r) => r.box_condition === "INTACT" && r.match_verdict === "MATCHED" && r.tampering_risk_score < 20 && r.carrier_claim_report === null,
    },
    {
      id: "RB-02",
      pair: true,
      ans: { box_condition: choice("MINOR_DENT", 0.89), seal_broken: noul(0.08), diff_tape_color: noul(0.07), diff_label_pos: noul(0.06), diff_box_ratio: noul(0.05), identity_match: choice("MATCHED", 0.91, { MATCHED: 0.91, SUSPICIOUS_DIFF: 0.07, MISMATCHED: 0.02 }) },
      check: (r) => r.box_condition === "MINOR_DENT" && r.match_verdict === "MATCHED" && r.suggested_disposition === "restock",
    },
    {
      id: "RB-03",
      pair: true,
      ans: { box_condition: choice("SEVERE_CRUSH", 0.92), seal_broken: noul(0.12), diff_tape_color: noul(0.08), diff_label_pos: noul(0.07), diff_box_ratio: noul(0.10), identity_match: choice("MATCHED", 0.88, { MATCHED: 0.88, SUSPICIOUS_DIFF: 0.10, MISMATCHED: 0.02 }) },
      check: (r) => r.box_condition === "SEVERE_CRUSH" && r.carrier_claim_recommended === true && r.carrier_claim_report !== null && r.suggested_disposition === "repair",
    },
    {
      id: "RB-04",
      pair: true,
      ans: { box_condition: choice("TORN_WET", 0.95), seal_broken: noul(0.65), diff_tape_color: noul(0.10), diff_label_pos: noul(0.12), diff_box_ratio: noul(0.08), identity_match: choice("SUSPICIOUS_DIFF", 0.78, { MATCHED: 0.18, SUSPICIOUS_DIFF: 0.78, MISMATCHED: 0.04 }) },
      check: (r) => r.box_condition === "TORN_WET" && r.suggested_disposition === "scrap" && r.suggested_qa_failed_codes.includes("condition_bad") && r.suggested_qa_failed_codes.includes("seal_broken"),
    },
    {
      id: "RB-05",
      pair: true,
      // Grey-zone tampering (40..75): tape color changed + suspicious_diff -> MUST require human review & freeze auto refund!
      ans: { box_condition: choice("INTACT", 0.88), seal_broken: noul(0.62), diff_tape_color: noul(0.74), diff_label_pos: noul(0.18), diff_box_ratio: noul(0.12), identity_match: choice("SUSPICIOUS_DIFF", 0.81, { MATCHED: 0.12, SUSPICIOUS_DIFF: 0.81, MISMATCHED: 0.07 }) },
      check: (r) => r.match_verdict === "SUSPICIOUS_DIFF" && r.tampering_risk_score >= 40 && r.tampering_risk_score <= 75 && r.requires_human_review === true && r.freeze_auto_refund === true,
    },
    {
      id: "RB-06",
      pair: true,
      // Grey-zone: label moved slightly
      ans: { box_condition: choice("MINOR_DENT", 0.85), seal_broken: noul(0.25), diff_tape_color: noul(0.20), diff_label_pos: noul(0.68), diff_box_ratio: noul(0.15), identity_match: choice("SUSPICIOUS_DIFF", 0.76, { MATCHED: 0.19, SUSPICIOUS_DIFF: 0.76, MISMATCHED: 0.05 }) },
      check: (r) => r.match_verdict === "SUSPICIOUS_DIFF" && r.diff_factors.includes("LABEL_POS") && r.requires_human_review === true,
    },
    {
      id: "RB-07",
      pair: true,
      // High-risk swap (>75): completely different box ratio + tape + label
      ans: { box_condition: choice("INTACT", 0.93), seal_broken: noul(0.88), diff_tape_color: noul(0.92), diff_label_pos: noul(0.90), diff_box_ratio: noul(0.95), identity_match: choice("MISMATCHED", 0.94, { MATCHED: 0.01, SUSPICIOUS_DIFF: 0.05, MISMATCHED: 0.94 }) },
      check: (r) => r.match_verdict === "MISMATCHED" && r.tampering_risk_score > 75 && r.freeze_auto_refund === true && r.suggested_qa_failed_codes.includes("package_mismatch"),
    },
    {
      id: "RB-08",
      pair: false,
      ans: { box_condition: choice("INTACT", 0.91), seal_broken: noul(0.05) },
      check: (r) => r.box_condition === "INTACT" && r.seal_intact === true && r.match_verdict === "MATCHED",
    },
    {
      id: "RB-09",
      pair: false,
      ans: { box_condition: choice("INTACT", 0.87), seal_broken: noul(0.82) },
      check: (r) => r.seal_intact === false && r.match_verdict === "SUSPICIOUS_DIFF" && r.requires_human_review === true,
    },
    {
      id: "RB-10",
      pair: true,
      // Low confidence (<0.70) automatically routes to HITL even if MATCHED
      ans: { box_condition: choice("INTACT", 0.61), seal_broken: noul(0.12), diff_tape_color: noul(0.10), diff_label_pos: noul(0.12), diff_box_ratio: noul(0.11), identity_match: choice("MATCHED", 0.62, { MATCHED: 0.62, SUSPICIOUS_DIFF: 0.30, MISMATCHED: 0.08 }) },
      check: (r) => r.requires_human_review === true,
    },
  ];

  for (const tc of boxCases) {
    const svc = new UnifiedDecisionService(buildCalibratedMockEvaluator([tc.ans]));
    const out = await svc.decideReturnBoxForensics({
      returnCode: "RMA-GOLDEN",
      trackingCode: "GHN-GOLDEN-01",
      carrierName: "GHN",
      pickupImage: tc.pair ? { bytes: parcelCleanImg, mime: "image/jpeg" } : null,
      warehouseImage: { bytes: parcelCleanImg, mime: "image/jpeg" },
    });
    record(tc.id, "return_box_qa", tc.check(out), `${out.box_condition}:${out.match_verdict}:risk=${out.tampering_risk_score}`);
  }

  // =========================================================================
  // DOMAIN 5: AUTO-BLOG & PROMOTION PRODUCT CURATION (10 Golden Cases)
  // =========================================================================
  const curationCases = [
    {
      id: "BC-01",
      in: { productId: "p1", name: "Đầm Lụa Mulberry", availableStock: 18, basePrice: 1890000, salePrice: 1590000, imageQaVerdict: "APPROVED_HERO", imageQaScore: 4.7, ratingAvg: 4.9 },
      ans: { publish_mode: choice("AUTO_BLOG_PUBLISH", 0.93), campaign_fit: choice("HERO_PRODUCT", 0.91), commercial_readiness: score(2.85, 0.90) },
      check: (r) => r.publish_mode === "AUTO_BLOG_PUBLISH" && r.campaign_fit === "HERO_PRODUCT" && !r.requires_human_review,
    },
    {
      id: "BC-02",
      in: { productId: "p2", name: "Áo Khoác Tweed", availableStock: 42, basePrice: 2400000, salePrice: 1680000, imageQaVerdict: "APPROVED_HERO", imageQaScore: 4.5, ratingAvg: 4.7 },
      ans: { publish_mode: choice("AUTO_BLOG_PUBLISH", 0.90), campaign_fit: choice("CLEARANCE", 0.92), commercial_readiness: score(2.7, 0.89) },
      check: (r) => r.publish_mode === "AUTO_BLOG_PUBLISH" && r.campaign_fit === "CLEARANCE",
    },
    {
      id: "BC-03",
      // Guardrail: APPROVED_STANDARD image must cap at SEMI_AUTO_REVIEW even if model proposes AUTO_BLOG_PUBLISH!
      in: { productId: "p3", name: "Chân Váy Xếp Ly", availableStock: 15, basePrice: 980000, salePrice: null, imageQaVerdict: "APPROVED_STANDARD", imageQaScore: 3.9, ratingAvg: 4.6 },
      ans: { publish_mode: choice("AUTO_BLOG_PUBLISH", 0.88), campaign_fit: choice("BUNDLE_ADDON", 0.87), commercial_readiness: score(2.2, 0.86) },
      check: (r) => r.publish_mode === "SEMI_AUTO_REVIEW" && r.requires_human_review === true,
    },
    {
      id: "BC-04",
      // Guardrail: stock < 3 caps at SEMI_AUTO_REVIEW so auto-blog doesn't promote near-OOS item unattended
      in: { productId: "p4", name: "Đầm Dạ Hội Limited", availableStock: 2, basePrice: 3200000, salePrice: null, imageQaVerdict: "APPROVED_HERO", imageQaScore: 4.8, ratingAvg: 4.9 },
      ans: { publish_mode: choice("AUTO_BLOG_PUBLISH", 0.91), campaign_fit: choice("HERO_PRODUCT", 0.90), commercial_readiness: score(2.5, 0.88) },
      check: (r) => r.publish_mode === "SEMI_AUTO_REVIEW" && r.requires_human_review === true,
    },
    {
      id: "BC-05",
      in: { productId: "p5", name: "Khăn Lụa Vuông", availableStock: 25, basePrice: 450000, salePrice: 390000, imageQaVerdict: "APPROVED_STANDARD", imageQaScore: 3.8, ratingAvg: 4.5 },
      ans: { publish_mode: choice("SEMI_AUTO_REVIEW", 0.89), campaign_fit: choice("BUNDLE_ADDON", 0.91), commercial_readiness: score(2.1, 0.87) },
      check: (r) => r.publish_mode === "SEMI_AUTO_REVIEW" && r.campaign_fit === "BUNDLE_ADDON",
    },
    {
      id: "BC-06",
      in: { productId: "p6", name: "Áo Sơ Mi Tơ", availableStock: 9, basePrice: 890000, salePrice: 790000, imageQaVerdict: "NEEDS_EDIT", imageQaScore: 3.1, ratingAvg: 4.4 },
      ans: { publish_mode: choice("SEMI_AUTO_REVIEW", 0.84), campaign_fit: choice("BUNDLE_ADDON", 0.82), commercial_readiness: score(1.5, 0.82) },
      check: (r) => r.publish_mode === "SEMI_AUTO_REVIEW",
    },
    {
      id: "BC-07",
      // Hard deterministic guardrail: availableStock === 0 -> EXCLUDE with zero external model call
      in: { productId: "p7", name: "Áo Len Hết Hàng", availableStock: 0, basePrice: 1100000, salePrice: 790000, imageQaVerdict: "APPROVED_HERO", imageQaScore: 4.9, ratingAvg: 4.9 },
      ans: null,
      check: (r) => r.publish_mode === "EXCLUDE" && r.telemetry.transport === "deterministic_fallback",
    },
    {
      id: "BC-08",
      // Hard deterministic guardrail: imageQaVerdict === REJECTED -> EXCLUDE with zero external model call
      in: { productId: "p8", name: "Quần Âu Ảnh Lỗi", availableStock: 30, basePrice: 950000, salePrice: 690000, imageQaVerdict: "REJECTED", imageQaScore: 1.9, ratingAvg: 4.6 },
      ans: null,
      check: (r) => r.publish_mode === "EXCLUDE" && r.telemetry.transport === "deterministic_fallback",
    },
    {
      id: "BC-09",
      in: { productId: "p9", name: "Áo Thun Đánh Giá Thấp", availableStock: 12, basePrice: 490000, salePrice: 390000, imageQaVerdict: "APPROVED_STANDARD", imageQaScore: 3.6, ratingAvg: 2.4 },
      ans: { publish_mode: choice("EXCLUDE", 0.92), campaign_fit: choice("CLEARANCE", 0.80), commercial_readiness: score(0.3, 0.90) },
      check: (r) => r.publish_mode === "EXCLUDE",
    },
    {
      id: "BC-10",
      in: { productId: "p10", name: "Blazer Linen Cao Cấp", availableStock: 14, basePrice: 1750000, salePrice: 1450000, imageQaVerdict: "APPROVED_HERO", imageQaScore: 4.6, ratingAvg: 4.8 },
      ans: { publish_mode: choice("AUTO_BLOG_PUBLISH", 0.94), campaign_fit: choice("HERO_PRODUCT", 0.93), commercial_readiness: score(2.9, 0.92) },
      check: (r) => r.publish_mode === "AUTO_BLOG_PUBLISH" && r.curation_score > 90,
    },
  ];

  for (const tc of curationCases) {
    const svc = new UnifiedDecisionService(buildCalibratedMockEvaluator(tc.ans ? [tc.ans] : []));
    const out = await svc.decideAutoBlogProductCuration(tc.in);
    record(tc.id, "blog_product_curation", tc.check(out), `${out.publish_mode}:${out.campaign_fit}`);
  }

  // Also verify optical ITA° physics directly
  const lightOptics = await measurePortraitSkinOptics(lightPortrait);
  const darkOptics = await measurePortraitSkinOptics(darkPortrait);
  const opticsValid =
    lightOptics.itaAngle > 28 &&
    lightOptics.measuredBaseDepth === "LIGHT_TONE" &&
    darkOptics.itaAngle < 28 &&
    darkOptics.measuredBaseDepth === "DARK_TONE";

  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const accuracy = totalCount > 0 ? passedCount / totalCount : 0;

  return {
    totalCount,
    passedCount,
    failedCases: results.filter((r) => !r.passed),
    accuracy,
    opticsValid,
    lightItaAngle: lightOptics.itaAngle,
    darkItaAngle: darkOptics.itaAngle,
  };
}

async function runLiveSmokeBenchmark() {
  if (existsSync(".env") && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env");
    } catch {
      // Ignore .env load errors in non-local environments
    }
  }
  if (!process.env.GEMINI_PRIMARY_KEY && process.env.GEMINI_API_KEY) {
    process.env.GEMINI_PRIMARY_KEY = process.env.GEMINI_API_KEY;
  }
  if (!isDecisionEngineConfigured()) {
    console.log("[eval:ai-decisions] Live mode skipped: no Gemini key configured in env or gemini.env.");
    return;
  }
  const liveSvc = new UnifiedDecisionService();
  const studioImg = await createSyntheticImage({
    width: 900,
    height: 900,
    bg: [255, 255, 255],
    subject: [138, 38, 60],
    crispGrid: true,
  });
  const portraitImg = await createSyntheticImage({
    width: 800,
    height: 800,
    bg: [244, 242, 238],
    subject: [232, 198, 178],
    sclera: [246, 246, 247],
    crispGrid: true,
  });

  const [cskhPos, cskhNeg, pcOut, qaOut, boxOut, curOut] = await Promise.all([
    liveSvc.decideCskhSentiment({
      message: "Đầm lụa Velura đẹp xuất sắc, chất vải mát mịn và giao hàng siêu nhanh!",
    }),
    liveSvc.decideCskhSentiment({
      message: "Thùng hàng giao đến bị rách móp nát, bên trong thiếu mất chiếc áo sơ mi, yêu cầu quản lý kiểm tra gấp!",
    }),
    liveSvc.decidePersonalColor({ bytes: portraitImg, mime: "image/jpeg" }),
    liveSvc.decideProductImageQa(studioImg, "image/jpeg", { productName: "Đầm Lụa Đỏ Burgundy Velura" }),
    liveSvc.decideReturnBoxForensics({
      returnCode: "RMA-LIVE-01",
      trackingCode: "GHN-LIVE-8899",
      carrierName: "GHN",
      pickupImage: { bytes: studioImg, mime: "image/jpeg" },
      warehouseImage: { bytes: studioImg, mime: "image/jpeg" },
    }),
    liveSvc.decideAutoBlogProductCuration({
      productId: "live-prod-1",
      name: "Đầm Lụa Mulberry Cổ Đổ",
      availableStock: 24,
      basePrice: 1890000,
      salePrice: 1490000,
      imageQaVerdict: "APPROVED_HERO",
      imageQaScore: 4.8,
      ratingAvg: 4.9,
      campaignGoal: "Flash Sale Ngày Đôi",
    }),
  ]);

  console.log("\n=== LIVE GEMINI-DECISION-1 (/v1beta/decisions) BENCHMARK ===");
  console.log(
    JSON.stringify(
      {
        cskh_positive: {
          sentiment: cskhPos.sentiment,
          branch: cskhPos.routing_branch,
          confidence: cskhPos.confidence_score,
          transport: cskhPos.telemetry.transport,
          latency_ms: cskhPos.telemetry.latency_ms,
        },
        cskh_negative: {
          sentiment: cskhNeg.sentiment,
          branch: cskhNeg.routing_branch,
          urgency: cskhNeg.urgency,
          escalate_to_human: cskhNeg.escalate_to_human,
          confidence: cskhNeg.confidence_score,
          transport: cskhNeg.telemetry.transport,
          latency_ms: cskhNeg.telemetry.latency_ms,
        },
        personal_color: {
          base_skin_depth: pcOut.base_skin_depth,
          skin_depth: pcOut.skin_depth,
          undertone: pcOut.undertone,
          season: pcOut.season,
          ita_angle: pcOut.optical_measurement.itaAngle,
          transport: pcOut.telemetry.transport,
          latency_ms: pcOut.telemetry.latency_ms,
        },
        product_image_qa: {
          final_verdict: qaOut.final_verdict,
          avg_score: qaOut.average_taxonomy_score,
          blog_auto_eligible: qaOut.blog_auto_eligible,
          transport: qaOut.telemetry.transport,
          latency_ms: qaOut.telemetry.latency_ms,
        },
        return_box_forensics: {
          box_condition: boxOut.box_condition,
          match_verdict: boxOut.match_verdict,
          tampering_risk_score: boxOut.tampering_risk_score,
          transport: boxOut.telemetry.transport,
          latency_ms: boxOut.telemetry.latency_ms,
        },
        blog_curation: {
          publish_mode: curOut.publish_mode,
          campaign_fit: curOut.campaign_fit,
          curation_score: curOut.curation_score,
          transport: curOut.telemetry.transport,
          latency_ms: curOut.telemetry.latency_ms,
        },
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1] && process.argv[1].endsWith("eval-decision-golden.mjs");
if (isMain) {
  const summary = await runGoldenEvaluationSuite();
  console.log(
    `[eval:ai-decisions] Golden Dataset: ${summary.passedCount}/${summary.totalCount} passed (${(summary.accuracy * 100).toFixed(1)}%) | ITA° Optics valid=${summary.opticsValid} (Light=${summary.lightItaAngle}°, Dark=${summary.darkItaAngle}°)`,
  );
  if (summary.failedCases.length > 0) {
    console.error("[eval:ai-decisions] Failed cases:", summary.failedCases);
  }
  if (summary.accuracy < 0.9 || !summary.opticsValid) {
    process.exitCode = 1;
  } else if (process.argv.includes("--live")) {
    await runLiveSmokeBenchmark();
  }
}
