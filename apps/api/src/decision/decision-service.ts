/**
 * Unified Scientific Decision Service for Velura Commerce.
 *
 * Strictly separates the zero-output-token **Base Decision Layer** (`gemini-decision-1`)
 * from downstream deterministic routing & generative copywriting across all 5 domains:
 * 1. Personal Color Analysis (CIE L*a*b* ITA° + Sclera WB + 4-Season Decision)
 * 2. CSKH & Chatbot Sentiment Branching Router
 * 3. Product Image Quality 4-Axis Taxonomy & Auto-Blog Eligibility
 * 4. Return Box QA & Carrier Dispute Visual Forensics (2-Axis Structural + Identity)
 * 5. Auto-Blog & Promotion Product Curation
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_PERSONAL_COLOR_POLICY } from "../personal-color/personal-color-policy.js";
import type { PersonalColorPolicy } from "../personal-color/personal-color-types.js";
import { measureTechnicalQuality } from "../products/product-ai-studio.js";
import type { JsonObject } from "../types.js";
import { evaluateGeminiDecisions, recordDecisionAuditLog } from "./gemini-decision-client.js";
import type {
  AutoBlogCurationDecision,
  AutoBlogPublishMode,
  BaseSkinDepth,
  BoxConditionVerdict,
  CampaignProductFit,
  CarrierDisputeReport,
  ContrastLevel,
  CreateDecisionRequest,
  CreateDecisionResult,
  CskhIntentLabel,
  CskhRoutingBranch,
  CskhSentimentDecision,
  CskhSentimentLabel,
  CskhUrgencyLevel,
  DecisionAnswer,
  DecisionChoiceAnswer,
  DecisionInputBlock,
  DecisionNoulAnswer,
  DecisionScoreAnswer,
  DetailedSkinDepth,
  FourSeason,
  ImageDefectTag,
  ImageQaVerdict,
  ParcelDiffFactor,
  ParcelMatchVerdict,
  PersonalColorDecision,
  ProductImageQaDecision,
  ReturnBoxForensicsDecision,
  SkinOpticalMeasurement,
  SkinUndertone,
} from "./decision-types.js";

const HUMAN_REVIEW_CONFIDENCE_FLOOR = 0.70;

const SEASON_PALETTE_KEYS: Readonly<Record<FourSeason, { recommended: readonly string[]; avoided: readonly string[] }>> = {
  Spring: { recommended: ["peach", "coral", "gold", "mint"], avoided: ["black", "burgundy", "royal_blue"] },
  Summer: { recommended: ["lavender", "rose", "sky", "sage"], avoided: ["terracotta", "mustard", "brown"] },
  Autumn: { recommended: ["terracotta", "olive", "mustard", "brown"], avoided: ["sky", "lavender", "mint"] },
  Winter: { recommended: ["emerald", "royal_blue", "burgundy", "black"], avoided: ["peach", "gold", "mustard"] },
};

/** Injectable evaluator signature allowing deterministic golden-dataset and unit tests. */
export type DecisionEvaluatorFn = (request: CreateDecisionRequest) => Promise<CreateDecisionResult>;

/**
 * Measures central portrait skin chromaticity in CIE L*a*b* and estimates Individual Typology Angle
 * `ITA° = arctan((L* - 50) / b*) * (180 / pi)` after virtual sclera/highlight white-balance compensation.
 */
export async function measurePortraitSkinOptics(bytes: Buffer): Promise<SkinOpticalMeasurement> {
  const sampleSize = 96;
  const raw = await sharp(bytes)
    .rotate()
    .resize(sampleSize, sampleSize, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 1. Estimate ambient illuminant cast from bright neutral/sclera-like pixels (top 8% luminance, low saturation)
  let hiR = 0;
  let hiG = 0;
  let hiB = 0;
  let hiCount = 0;
  for (let i = 0; i < sampleSize * sampleSize; i++) {
    const r = raw[i * 3];
    const g = raw[i * 3 + 1];
    const b = raw[i * 3 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (lum >= 185 && lum <= 250 && maxC - minC < 55) {
      hiR += r;
      hiG += g;
      hiB += b;
      hiCount++;
    }
  }

  let gainR = 1.0;
  let gainG = 1.0;
  let gainB = 1.0;
  let whiteBalanceShift: SkinOpticalMeasurement["whiteBalanceShift"] = "BALANCED";

  if (hiCount >= 12) {
    const meanR = hiR / hiCount;
    const meanG = hiG / hiCount;
    const meanB = hiB / hiCount;
    const avg = (meanR + meanG + meanB) / 3;
    const rbRatio = meanR / Math.max(1, meanB);
    if (rbRatio > 1.38 || rbRatio < 0.70) {
      whiteBalanceShift = "EXTREME_CAST";
    } else if (rbRatio > 1.14) {
      whiteBalanceShift = "WARM_CAST";
    } else if (rbRatio < 0.88) {
      whiteBalanceShift = "COOL_CAST";
    }
    // Damped Von Kries white-balance compensation (65% strength to avoid over-correcting natural warmth)
    gainR = 1 + 0.65 * Math.max(-0.25, Math.min(0.25, avg / Math.max(1, meanR) - 1));
    gainG = 1 + 0.65 * Math.max(-0.25, Math.min(0.25, avg / Math.max(1, meanG) - 1));
    gainB = 1 + 0.65 * Math.max(-0.25, Math.min(0.25, avg / Math.max(1, meanB) - 1));
  }

  // 2. Sample central facial ROI (x: 28%..72%, y: 24%..74%) for skin-plausible pixels
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let skinPixels = 0;

  const xMin = Math.floor(sampleSize * 0.28);
  const xMax = Math.ceil(sampleSize * 0.72);
  const yMin = Math.floor(sampleSize * 0.24);
  const yMax = Math.ceil(sampleSize * 0.74);

  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const idx = (y * sampleSize + x) * 3;
      const r = Math.min(255, Math.max(0, raw[idx] * gainR));
      const g = Math.min(255, Math.max(0, raw[idx + 1] * gainG));
      const b = Math.min(255, Math.max(0, raw[idx + 2] * gainB));
      const lab = srgbToLab(r, g, b);
      // Plausible human skin locus in CIE L*a*b*: L* in [20..88], a* > 2, b* > 4
      if (lab.L >= 20 && lab.L <= 88 && lab.a >= 1.5 && lab.b >= 3.0) {
        sumL += lab.L;
        sumA += lab.a;
        sumB += lab.b;
        skinPixels++;
      }
    }
  }

  if (skinPixels < 20) {
    // Fallback to ROI average if synthetic test fixture (e.g., pure white PNG in unit tests)
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const idx = (y * sampleSize + x) * 3;
        const lab = srgbToLab(raw[idx], raw[idx + 1], raw[idx + 2]);
        sumL += lab.L;
        sumA += lab.a;
        sumB += lab.b;
        skinPixels++;
      }
    }
  }

  const L = sumL / Math.max(1, skinPixels);
  const a = sumA / Math.max(1, skinPixels);
  const b = Math.max(0.5, sumB / Math.max(1, skinPixels));
  const itaAngle = Number(((Math.atan2(L - 50, b) * 180) / Math.PI).toFixed(2));
  // Dermatology Del Bino & Bernerd ITA° classification: > 28° corresponds to Fair/Light/Intermediate-Light tones
  const measuredBaseDepth: BaseSkinDepth = itaAngle >= 28 ? "LIGHT_TONE" : "DARK_TONE";

  return {
    itaAngle,
    luminanceL: Number(L.toFixed(2)),
    redGreenA: Number(a.toFixed(2)),
    yellowBlueB: Number(b.toFixed(2)),
    whiteBalanceShift,
    measuredBaseDepth,
  };
}

function srgbToLab(r8: number, g8: number, b8: number): { L: number; a: number; b: number } {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  // D65 reference white
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0;
  const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export class UnifiedDecisionService {
  constructor(private readonly evaluate: DecisionEvaluatorFn = evaluateGeminiDecisions) {}

  /**
   * 1. Personal Color Scientific Decision Engine:
   * Evaluates portrait validity, sclera white-balance, base skin depth (`LIGHT_TONE` vs `DARK_TONE`),
   * detailed ITA° depth (`FAIR`..`DEEP`), undertone (`COOL`|`WARM`|`NEUTRAL_OLIVE`), and 4-season mapping
   * in a single zero-output-token pass of `gemini-decision-1`.
   */
  async decidePersonalColor(
    image: { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" },
    options: { policy?: PersonalColorPolicy | null; actorId?: string | null; entityId?: string; signal?: AbortSignal } = {},
  ): Promise<PersonalColorDecision> {
    const policy = options.policy ?? DEFAULT_PERSONAL_COLOR_POLICY;
    const optics = await measurePortraitSkinOptics(image.bytes);
    const resized = await sharp(image.bytes)
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86 })
      .toBuffer();

    const input: DecisionInputBlock[] = [
      {
        type: "text",
        text: `Certified Personal Color Analysis input. Measured CIE L*a*b* skin optics after sclera white-balance calibration: ${JSON.stringify(optics)}.\n`,
      },
      {
        type: "image",
        data: resized.toString("base64"),
        mime_type: "image/jpeg",
        resolution: "medium",
      },
    ];

    const decision = await this.evaluate({
      useCase: "personal_color",
      entityType: "personal_color_analysis",
      entityId: options.entityId,
      actorId: options.actorId,
      signal: options.signal,
      input,
      questions: {
        lighting_valid: {
          type: "noul",
          instructions:
            "Inspect the sclera (eye whites) and ambient illumination. Is the lighting acceptable to judge real skin tone without extreme neon/disco color casts or severe backlighting?",
          criteria: {
            true_description: "Daylight or normal indoor lighting where natural skin and sclera are discernible.",
            false_description: "Extreme colored neon lighting, pitch-dark shadow, or severe overexposure obscuring skin.",
          },
        },
        skin_visible: {
          type: "noul",
          instructions: "Is a real human face with unobscured facial skin clearly visible in the photo?",
        },
        blur_free: {
          type: "noul",
          instructions: "Is the portrait sufficiently sharp in focus to observe skin, hair, and eye contrast?",
        },
        filter_free: {
          type: "noul",
          instructions: "Is the face free of heavy AR masks, cartoon stickers, or extreme skin-bleaching beauty filters?",
        },
        base_skin_depth: {
          type: "choice",
          instructions:
            "After compensating white balance against the sclera and considering the measured ITA angle, classify the foundational skin value/depth into LIGHT_TONE or DARK_TONE.",
          criteria: {
            LIGHT_TONE: "Fair to light-medium skin value (higher luminance L*, ITA typically >= 28 degrees).",
            DARK_TONE: "Medium-tan, tan, caramel, or deep skin value (richer melanin depth, ITA typically < 28 degrees).",
          },
        },
        skin_depth: {
          type: "choice",
          instructions: "Select the 5-tier dermatological skin depth level after white-balance normalization.",
          criteria: {
            FAIR: "Very fair / porcelain skin depth with high reflectance.",
            LIGHT: "Light skin depth with gentle warmth or coolness.",
            MEDIUM: "Balanced medium skin depth.",
            TAN: "Warm tan / bronze / olive-tan skin depth.",
            DEEP: "Rich deep melanin skin depth.",
          },
        },
        undertone: {
          type: "choice",
          instructions:
            "Determine the subcutaneous skin undertone (Warm golden/peachy, Cool rosy/bluish, or Neutral/Olive balanced) independent of surface lighting.",
          criteria: {
            COOL: "Pinkish, rosy, or bluish-red undertone; harmonizes with silver, berry, sky blue, emerald.",
            WARM: "Golden, peachy, or yellow-amber undertone; harmonizes with gold, coral,peach, terracotta, olive.",
            NEUTRAL_OLIVE: "Balanced neutral or subtle green-beige olive undertone without strong warm/cool dominance.",
          },
        },
        contrast_level: {
          type: "choice",
          instructions: "Classify the value contrast between hair, eyebrows/irises, and facial skin.",
          criteria: {
            LOW: "Soft, blended low contrast between skin, hair, and eyes.",
            MEDIUM: "Moderate balanced contrast between facial features and skin.",
            HIGH: "Sharp, vivid high contrast (e.g., jet-black hair/eyes against fair skin or bright features on deep skin).",
          },
        },
        personal_season: {
          type: "choice",
          instructions:
            "Map the portrait's base_skin_depth, undertone, and contrast_level to the exact 4-season Personal Color harmony.",
          criteria: {
            Spring: "Warm/neutral-warm undertone with bright, clear, light-to-medium value (peach, coral, warm gold, mint).",
            Summer: "Cool/neutral-cool undertone with soft, muted, light-to-medium contrast (lavender, rose, sky blue, sage).",
            Autumn: "Warm/neutral-olive undertone with rich, earthy, medium-to-deep depth (terracotta, olive, mustard, brown).",
            Winter: "Cool/neutral-cool undertone with high contrast or deep vivid intensity (emerald, royal blue, burgundy, black).",
          },
        },
      },
    });

    const failedChecks: string[] = [];
    for (const checkKey of ["lighting_valid", "skin_visible", "blur_free", "filter_free"] as const) {
      const ans = decision.answers[checkKey] as DecisionNoulAnswer;
      if (ans.noul < 0.5) failedChecks.push(checkKey);
    }
    if (optics.whiteBalanceShift === "EXTREME_CAST" && !failedChecks.includes("lighting_valid")) {
      failedChecks.push("lighting_valid");
    }

    const lightingValid: "PASS" | "RETAKE" = failedChecks.length === 0 ? "PASS" : "RETAKE";
    const baseDepthAns = decision.answers.base_skin_depth as DecisionChoiceAnswer;
    const baseSkinDepth: BaseSkinDepth =
      baseDepthAns.confidence >= 0.65
        ? (baseDepthAns.choice as BaseSkinDepth)
        : optics.measuredBaseDepth;

    const skinDepth = (decision.answers.skin_depth as DecisionChoiceAnswer).choice as DetailedSkinDepth;
    const undertone = (decision.answers.undertone as DecisionChoiceAnswer).choice as SkinUndertone;
    const contrastLevel = (decision.answers.contrast_level as DecisionChoiceAnswer).choice as ContrastLevel;

    const seasonAns = decision.answers.personal_season as DecisionChoiceAnswer;
    const season = resolveScientificSeason(
      seasonAns.choice as FourSeason,
      seasonAns.confidence,
      baseSkinDepth,
      undertone,
      contrastLevel,
    );

    const paletteKeys = SEASON_PALETTE_KEYS[season];
    const paletteMap = policy.palette || DEFAULT_PERSONAL_COLOR_POLICY.palette;
    const recommendedIds = paletteKeys.recommended.filter((id) => Boolean(paletteMap[id]));
    const avoidIds = paletteKeys.avoided.filter((id) => Boolean(paletteMap[id]));
    const confidenceScore = Number(
      Math.min(seasonAns.confidence, baseDepthAns.confidence * 0.4 + seasonAns.confidence * 0.6).toFixed(4),
    );
    const requiresHumanReview = lightingValid === "RETAKE" || confidenceScore < HUMAN_REVIEW_CONFIDENCE_FLOOR;

    void recordDecisionAuditLog({
      useCase: "personal_color",
      entityType: "personal_color_analysis",
      entityId: options.entityId,
      rolloutMode: decision.rolloutMode,
      modelUsed: decision.modelUsed,
      transport: decision.transport,
      usedFallbackKey: decision.usedFallbackKey,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      confidenceScore,
      requiresHumanReview,
      verdictCode: lightingValid === "RETAKE" ? `RETAKE:${failedChecks.join(",")}` : `${season}:${baseSkinDepth}:${undertone}`,
      rawAnswers: serializeAnswers(decision.answers),
      downstreamAction: lightingValid === "RETAKE" ? "REQUEST_PHOTO_RETAKE" : `SEASON_${season.toUpperCase()}`,
      actorId: options.actorId,
    });

    return {
      lighting_valid: lightingValid,
      failed_checks: failedChecks,
      base_skin_depth: baseSkinDepth,
      skin_depth: skinDepth,
      undertone,
      contrast_level: contrastLevel,
      season,
      recommended_palette_ids: recommendedIds,
      avoid_palette_ids: avoidIds,
      recommended_hex_palette: recommendedIds.map((id) => paletteMap[id]),
      avoid_hex_palette: avoidIds.map((id) => paletteMap[id]),
      confidence_score: confidenceScore,
      requires_human_review: requiresHumanReview,
      optical_measurement: optics,
      telemetry: {
        model_used: decision.modelUsed,
        transport: decision.transport,
        used_fallback_key: decision.usedFallbackKey,
        latency_ms: decision.latencyMs,
      },
    };
  }

  /**
   * 2. CSKH & Chatbot Sentiment Branching Decision Router:
   * Evaluates customer message + conversation context via `gemini-decision-1` and hard-routes
   * into `NURTURE_AND_UPSELL` (Positive), `EDUCATE_AND_LOYALTY_HOOK` (Neutral), or
   * `STANDARDIZED_DEESCALATION` (Negative).
   */
  async decideCskhSentiment(input: {
    message: string;
    history?: ReadonlyArray<{ sender: string; text: string }>;
    rating?: number;
    contextKind?: "chat" | "review" | "ticket";
    entityId?: string;
    actorId?: string | null;
    signal?: AbortSignal;
  }): Promise<CskhSentimentDecision> {
    const serializedContext = JSON.stringify({
      channel: input.contextKind || "chat",
      rating: input.rating ?? null,
      recent_history: (input.history || []).slice(-8).map((turn) => ({
        sender: turn.sender,
        text: String(turn.text || "").slice(0, 600),
      })),
      latest_customer_message: String(input.message || "").slice(0, 2000),
    });

    const decision = await this.evaluate({
      useCase: "cskh_sentiment",
      entityType: input.contextKind || "chat",
      entityId: input.entityId,
      actorId: input.actorId,
      signal: input.signal,
      input: serializedContext,
      questions: {
        sentiment: {
          type: "choice",
          instructions:
            "Classify the customer's dominant sentiment in `latest_customer_message` considering `recent_history` and optional `rating`.",
          criteria: {
            POSITIVE: "Satisfied, praising product/service quality, thanking staff, or excited to buy.",
            NEUTRAL: "Asking factual questions about size, stock, shipping, policy, or price without clear emotional polarity.",
            NEGATIVE: "Dissatisfied, frustrated, angry, reporting product defect, wrong item, late shipping, or refund issue.",
          },
        },
        intent: {
          type: "choice",
          instructions: "Classify the primary customer support intent of `latest_customer_message`.",
          criteria: {
            PRAISE: "Complimenting garment design, fabric quality, packaging, or service.",
            INQUIRY: "Asking about sizing, styling, product availability, promotions, loyalty points, or store policy.",
            COMPLAINT: "Complaining about damaged goods, poor quality, delayed carrier delivery, or billing problems.",
            RETURN_REQ: "Explicitly requesting return, exchange, order cancellation, or refund processing.",
          },
        },
        urgency: {
          type: "score",
          instructions: "Rate the operational urgency of this customer interaction.",
          criteria: [
            "LOW: Routine praise, general styling question, or non-time-sensitive catalog inquiry.",
            "MEDIUM: Order/return question or mild dissatisfaction needing timely standard SOP assistance.",
            "CRITICAL: Severe defect, repeated unresolved complaint, angry escalation, fraud claim, or explicit demand for human manager.",
          ],
        },
        escalate_threat_or_human: {
          type: "noul",
          instructions:
            "Is the customer explicitly asking for a human agent/supervisor, threatening public/legal escalation, reporting fraud/parcel swap, or using abusive language?",
        },
      },
    });

    const sentimentAns = decision.answers.sentiment as DecisionChoiceAnswer;
    const intentAns = decision.answers.intent as DecisionChoiceAnswer;
    const urgencyAns = decision.answers.urgency as DecisionScoreAnswer;
    const escalateAns = decision.answers.escalate_threat_or_human as DecisionNoulAnswer;

    let sentiment = sentimentAns.choice as CskhSentimentLabel;
    // Anchor extreme star ratings if text is empty or ultra-short
    if (typeof input.rating === "number" && input.message.trim().length < 8) {
      if (input.rating <= 2) sentiment = "NEGATIVE";
      else if (input.rating >= 4) sentiment = "POSITIVE";
    }

    const urgency: CskhUrgencyLevel =
      urgencyAns.score >= 1.45 || escalateAns.noul >= 0.65
        ? "CRITICAL"
        : urgencyAns.score >= 0.65 || sentiment === "NEGATIVE"
          ? "MEDIUM"
          : "LOW";

    const intent = intentAns.choice as CskhIntentLabel;
    const routingBranch: CskhRoutingBranch =
      sentiment === "POSITIVE"
        ? "NURTURE_AND_UPSELL"
        : sentiment === "NEUTRAL"
          ? "EDUCATE_AND_LOYALTY_HOOK"
          : "STANDARDIZED_DEESCALATION";

    const confidenceScore = Number(sentimentAns.confidence.toFixed(4));
    const escalateToHuman =
      urgency === "CRITICAL" || escalateAns.noul >= 0.60 || (sentiment === "NEGATIVE" && intent === "RETURN_REQ" && urgencyAns.score >= 1.2);
    const requiresHumanReview = escalateToHuman || confidenceScore < HUMAN_REVIEW_CONFIDENCE_FLOOR;

    const guidelines = buildCskhBranchGuidelines(routingBranch, intent, escalateToHuman);

    void recordDecisionAuditLog({
      useCase: "cskh_sentiment",
      entityType: input.contextKind || "chat",
      entityId: input.entityId,
      rolloutMode: decision.rolloutMode,
      modelUsed: decision.modelUsed,
      transport: decision.transport,
      usedFallbackKey: decision.usedFallbackKey,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      confidenceScore,
      requiresHumanReview,
      verdictCode: `${sentiment}:${urgency}:${intent}`,
      rawAnswers: serializeAnswers(decision.answers),
      downstreamAction: routingBranch,
      actorId: input.actorId,
    });

    return {
      sentiment,
      urgency,
      intent,
      routing_branch: routingBranch,
      confidence_score: confidenceScore,
      escalate_to_human: escalateToHuman,
      requires_human_review: requiresHumanReview,
      sentiment_probabilities: {
        POSITIVE: Number((sentimentAns.probabilities.POSITIVE ?? 0).toFixed(4)),
        NEUTRAL: Number((sentimentAns.probabilities.NEUTRAL ?? 0).toFixed(4)),
        NEGATIVE: Number((sentimentAns.probabilities.NEGATIVE ?? 0).toFixed(4)),
      },
      response_guidelines: guidelines,
      telemetry: {
        model_used: decision.modelUsed,
        transport: decision.transport,
        used_fallback_key: decision.usedFallbackKey,
        latency_ms: decision.latencyMs,
      },
    };
  }

  /**
   * 3. Product Image Quality 4-Axis Taxonomy & Blog Eligibility Decision Engine:
   * Combines Sharp physical pixel metrics with `gemini-decision-1` 4-axis rubric scoring (1..5 scale)
   * and specific defect flags (`BLURRY`, `WATERMARK`, `CLUTTERED_BG`, `CROP_CUTOFF`).
   */
  async decideProductImageQa(
    bytes: Buffer,
    mime: "image/jpeg" | "image/png" | "image/webp",
    options: { productId?: string; productName?: string; actorId?: string | null; signal?: AbortSignal } = {},
  ): Promise<ProductImageQaDecision> {
    const measured = await measureTechnicalQuality(bytes);
    const resized = await sharp(bytes)
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const input: DecisionInputBlock[] = [
      {
        type: "text",
        text: `E-commerce fashion product image QA for "${options.productName || "Velura garment"}". Measured pixel telemetry: width=${measured.metrics.width}px, height=${measured.metrics.height}px, brightness=${measured.metrics.brightness}/255, contrast=${measured.metrics.contrast}, sharpness=${measured.metrics.sharpnessScore}/100, borderCleanliness=${measured.metrics.backgroundScore}/100.\n`,
      },
      {
        type: "image",
        data: resized.toString("base64"),
        mime_type: "image/jpeg",
        resolution: "medium",
      },
    ];

    const decision = await this.evaluate({
      useCase: "product_image_qa",
      entityType: "product",
      entityId: options.productId,
      actorId: options.actorId,
      signal: options.signal,
      input,
      questions: {
        sharpness_focus: {
          type: "score",
          instructions: "Rate garment sharpness, fabric weave clarity, and absence of motion blur or compression pixelation.",
          criteria: [
            "1 - Severely blurry, out of focus, or heavily pixelated.",
            "2 - Noticeably soft focus; seam and fabric details are indistinct.",
            "3 - Acceptable sharpness for web thumbnail, minor softness on edges.",
            "4 - Crisp focus across garment silhouette and fabric texture.",
            "5 - Editorial studio sharpness showing fine fabric weave and stitching clearly.",
          ],
        },
        lighting_exposure: {
          type: "score",
          instructions: "Rate lighting balance, true garment color representation, and absence of clipped highlights or crushed dark shadows.",
          criteria: [
            "1 - Severely underexposed dark image or blown-out highlights hiding garment.",
            "2 - Strong color cast, harsh shadows, or dull uneven room lighting.",
            "3 - Adequate exposure with minor shadow unevenness.",
            "4 - Well-balanced studio lighting showing accurate garment color and drape.",
            "5 - Flawless diffused studio illumination highlighting fabric sheen and true color.",
          ],
        },
        composition_framing: {
          type: "score",
          instructions: "Rate garment framing, centering, aspect balance, and whether key garment parts are fully visible without awkward cropping.",
          criteria: [
            "1 - Product is mostly cut off, tiny in frame, or unrecognizable.",
            "2 - Awkwardly cropped hemline/sleeves or tilted off-center framing.",
            "3 - Complete garment visible with acceptable margins.",
            "4 - Cleanly centered commercial framing with balanced breathing room.",
            "5 - Lookbook-grade editorial composition and silhouette presentation.",
          ],
        },
        background_cleanliness: {
          type: "score",
          instructions: "Rate background cleanliness, studio professionalism, and absence of clutter, distracting objects, or promotional watermarks.",
          criteria: [
            "1 - Messy room clutter, distracting bystanders/objects, or intrusive watermarks.",
            "2 - Wrinkled backdrop, visible floor clutter, or promotional text covering garment.",
            "3 - Mostly clean background with minor shadows or neutral indoor setting.",
            "4 - Clean uniform studio or curated lookbook backdrop free of distractions.",
            "5 - Pure seamless Velura studio backdrop (#FFFFFF or #FAF6F0) or luxury editorial set.",
          ],
        },
        has_watermark_or_text: {
          type: "noul",
          instructions: "Does the image contain third-party watermarks, phone timestamps, or promotional text covering the garment?",
        },
        has_crop_cutoff: {
          type: "noul",
          instructions: "Is an essential part of the main garment unintentionally cut off at the frame border?",
        },
        has_cluttered_bg: {
          type: "noul",
          instructions: "Does the background contain messy household clutter, hangers on racks, or unrelated objects?",
        },
      },
    });

    // Convert 0..4 rubric index score into 1.0..5.0 taxonomy score, grounded by physical Sharp telemetry
    const rawSharp = 1 + (decision.answers.sharpness_focus as DecisionScoreAnswer).score;
    const rawLight = 1 + (decision.answers.lighting_exposure as DecisionScoreAnswer).score;
    const rawComp = 1 + (decision.answers.composition_framing as DecisionScoreAnswer).score;
    const rawBg = 1 + (decision.answers.background_cleanliness as DecisionScoreAnswer).score;

    // Grounding guard: a physically blank dark image (measured.overallScore < 55) can NEVER be scored high
    const physicalCap = measured.metrics.brightness < 55 && measured.metrics.backgroundScore < 45 ? 1.8 : 5.0;
    const sharpnessFocus = Number(Math.min(physicalCap, rawSharp * 0.75 + (measured.metrics.sharpnessScore / 20) * 0.25).toFixed(2));
    const lightingExposure = Number(Math.min(physicalCap, rawLight * 0.75 + (measured.criteria.find((c) => c.key === "lighting")!.score / 20) * 0.25).toFixed(2));
    const compositionFraming = Number(Math.min(physicalCap, rawComp).toFixed(2));
    const backgroundCleanliness = Number(Math.min(physicalCap, rawBg * 0.75 + (measured.metrics.backgroundScore / 20) * 0.25).toFixed(2));

    const axes = [sharpnessFocus, lightingExposure, compositionFraming, backgroundCleanliness];
    const avgScore = Number((axes.reduce((s, v) => s + v, 0) / 4).toFixed(2));
    const minAxis = Math.min(...axes);

    const watermarkAns = decision.answers.has_watermark_or_text as DecisionNoulAnswer;
    const cutoffAns = decision.answers.has_crop_cutoff as DecisionNoulAnswer;
    const clutterAns = decision.answers.has_cluttered_bg as DecisionNoulAnswer;

    const defectTags: ImageDefectTag[] = [];
    if (sharpnessFocus < 3.2) defectTags.push("BLURRY");
    if (watermarkAns.noul >= 0.55) defectTags.push("WATERMARK");
    if (clutterAns.noul >= 0.55 || backgroundCleanliness < 3.0) defectTags.push("CLUTTERED_BG");
    if (cutoffAns.noul >= 0.55 || compositionFraming < 3.0) defectTags.push("CROP_CUTOFF");
    if (lightingExposure < 3.0) defectTags.push("POOR_EXPOSURE");
    if (Math.min(measured.metrics.width, measured.metrics.height) < 500) defectTags.push("LOW_RESOLUTION");

    let finalVerdict: ImageQaVerdict;
    if (avgScore >= 4.3 && minAxis >= 4.0 && !defectTags.includes("WATERMARK") && !defectTags.includes("CROP_CUTOFF")) {
      finalVerdict = "APPROVED_HERO";
    } else if (avgScore >= 3.5 && minAxis >= 3.0 && !defectTags.includes("WATERMARK")) {
      finalVerdict = "APPROVED_STANDARD";
    } else if (avgScore >= 2.7 && !defectTags.includes("WATERMARK") && !defectTags.includes("CROP_CUTOFF")) {
      finalVerdict = "NEEDS_EDIT";
    } else {
      finalVerdict = "REJECTED";
    }

    const failedCodes: string[] = [];
    const actionableFix: string[] = [];
    if (sharpnessFocus < 3.5) {
      failedCodes.push("SHARPNESS_BELOW_STANDARD");
      actionableFix.push("Tăng độ nét chi tiết sợi vải bằng Velura AI Studio (Sharpen) hoặc chụp lại giữ cố định máy.");
    }
    if (lightingExposure < 3.5) {
      failedCodes.push("EXPOSURE_IMBALANCE");
      actionableFix.push("Cân bằng lại độ phơi sáng Studio để màu vải trung thực, tránh cháy sáng hoặc tối vùng chi tiết.");
    }
    if (compositionFraming < 3.5 || defectTags.includes("CROP_CUTOFF")) {
      failedCodes.push("COMPOSITION_CROP_DEFECT");
      actionableFix.push("Căn chỉnh toàn bộ phom trang phục nằm trọn trong khung hình với khoảng thở lề cân đối.");
    }
    if (backgroundCleanliness < 3.5 || defectTags.includes("CLUTTERED_BG")) {
      failedCodes.push("BACKGROUND_NOT_CLEAN");
      actionableFix.push("Tách nền sang Trắng Studio (#FFFFFF) hoặc Kem Velura (#FAF6F0) bằng AI U2Net trong trình sửa ảnh.");
    }
    if (defectTags.includes("WATERMARK")) {
      failedCodes.push("WATERMARK_OR_TEXT_OVERLAY");
      actionableFix.push("Gỡ bỏ hoàn toàn watermark, logo bên thứ ba hoặc chữ đè lên sản phẩm.");
    }
    if (defectTags.includes("LOW_RESOLUTION")) {
      failedCodes.push("RESOLUTION_TOO_LOW");
      actionableFix.push("Nâng cấp độ phân giải tối thiểu 1080×1080px để hỗ trợ zoom chi tiết trên trang sản phẩm.");
    }

    const confidences = [
      (decision.answers.sharpness_focus as DecisionScoreAnswer).confidence,
      (decision.answers.lighting_exposure as DecisionScoreAnswer).confidence,
      (decision.answers.composition_framing as DecisionScoreAnswer).confidence,
      (decision.answers.background_cleanliness as DecisionScoreAnswer).confidence,
    ];
    const confidenceScore = Number((confidences.reduce((s, c) => s + c, 0) / confidences.length).toFixed(4));
    const blogAutoEligible = finalVerdict === "APPROVED_HERO";
    const requiresHumanReview = confidenceScore < HUMAN_REVIEW_CONFIDENCE_FLOOR || finalVerdict === "NEEDS_EDIT";

    void recordDecisionAuditLog({
      useCase: "product_image_qa",
      entityType: "product",
      entityId: options.productId,
      rolloutMode: decision.rolloutMode,
      modelUsed: decision.modelUsed,
      transport: decision.transport,
      usedFallbackKey: decision.usedFallbackKey,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      confidenceScore,
      requiresHumanReview,
      verdictCode: finalVerdict,
      rawAnswers: serializeAnswers(decision.answers),
      downstreamAction: blogAutoEligible ? "BLOG_AUTO_ELIGIBLE" : finalVerdict,
      actorId: options.actorId,
    });

    return {
      final_verdict: finalVerdict,
      average_taxonomy_score: avgScore,
      axes: {
        sharpness_focus: sharpnessFocus,
        lighting_exposure: lightingExposure,
        composition_framing: compositionFraming,
        background_cleanliness: backgroundCleanliness,
      },
      defect_tags: defectTags,
      failed_taxonomy_codes: failedCodes,
      actionable_fix: actionableFix,
      blog_auto_eligible: blogAutoEligible,
      confidence_score: confidenceScore,
      requires_human_review: requiresHumanReview,
      telemetry: {
        model_used: decision.modelUsed,
        transport: decision.transport,
        used_fallback_key: decision.usedFallbackKey,
        latency_ms: decision.latencyMs,
      },
    };
  }

  /**
   * 4. Return Box QA & Carrier Tampering Forensics Decision Engine:
   * Evaluates structural parcel damage (Axis 1) and pickup-vs-warehouse parcel identity consistency
   * (Axis 2) without over-claiming biometric certainty—routing grey-zone scores (40..75) to 1-click HITL review.
   */
  async decideReturnBoxForensics(input: {
    returnId?: string;
    returnCode?: string | null;
    trackingCode?: string | null;
    carrierName?: string | null;
    pickupImage?: { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" } | null;
    warehouseImage: { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" };
    actorId?: string | null;
    signal?: AbortSignal;
  }): Promise<ReturnBoxForensicsDecision> {
    const hasPair = Boolean(input.pickupImage?.bytes?.length);
    const blocks: DecisionInputBlock[] = [
      {
        type: "text",
        text: `Logistics & Return Parcel Visual Forensics QA. Return=${input.returnCode || "N/A"}, AWB=${input.trackingCode || "N/A"}, Carrier=${input.carrierName || "N/A"}, Mode=${hasPair ? "PAIR_COMPARISON" : "SINGLE_WAREHOUSE_INSPECTION"}.\n`,
      },
    ];

    if (hasPair && input.pickupImage) {
      const pickupResized = await sharp(input.pickupImage.bytes)
        .rotate()
        .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      blocks.push(
        { type: "text", text: "IMAGE_A (Parcel photographed at customer handover / carrier pickup):\n" },
        { type: "image", data: pickupResized.toString("base64"), mime_type: "image/jpeg", resolution: "high" },
      );
    }

    const warehouseResized = await sharp(input.warehouseImage.bytes)
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    blocks.push(
      { type: "text", text: "\nIMAGE_B (Parcel photographed upon arrival at Velura warehouse QA):\n" },
      { type: "image", data: warehouseResized.toString("base64"), mime_type: "image/jpeg", resolution: "high" },
    );

    const questions: Record<string, CreateDecisionRequest["questions"][string]> = {
      box_condition: {
        type: "choice",
        instructions:
          "Inspect IMAGE_B (warehouse arrival parcel) and classify physical outer carton condition.",
        criteria: {
          INTACT: "Carton corners, walls, and surfaces are structurally sound with clean shape.",
          MINOR_DENT: "Slight surface crease or minor corner scuff from normal transit without structural collapse.",
          SEVERE_CRUSH: "Heavily crushed, caved-in, or deformed carton walls threatening inner garment.",
          TORN_WET: "Punctured hole, ripped/torn cardboard panel, or water/liquid saturation damage.",
        },
      },
      seal_broken: {
        type: "noul",
        instructions:
          "Does IMAGE_B show broken security tape, peeled/cut sealing tape, Double-taped resealing over torn paper fibers, or an open flap?",
      },
    };

    if (hasPair) {
      questions.diff_tape_color = {
        type: "noul",
        instructions:
          "Comparing IMAGE_A and IMAGE_B (ignoring camera lighting shifts), did the packing tape color, width, or taping pattern materially change (e.g. branded/clear tape replaced with brown/colored tape)?",
      };
      questions.diff_label_pos = {
        type: "noul",
        instructions:
          "Comparing IMAGE_A and IMAGE_B, is the shipping waybill / QR label placed on a different face/position or replaced with a visibly different label layout?",
      };
      questions.diff_box_ratio = {
        type: "noul",
        instructions:
          "Comparing IMAGE_A and IMAGE_B (accounting for perspective angle), do the carton's geometric length-width-height proportions or cardboard color/material clearly belong to a different box?",
      };
      questions.identity_match = {
        type: "choice",
        instructions:
          "Evaluate whether IMAGE_A (pickup) and IMAGE_B (warehouse arrival) depict the exact same physical parcel. Do NOT flag mismatch solely due to camera angle or lighting.",
        criteria: {
          MATCHED: "Consistent box geometry, tape type/pattern, and shipping label placement.",
          SUSPICIOUS_DIFF: "Ambiguous discrepancy (such as added tape layer, partial label tear, or unclear angle) needing human QA verification.",
          MISMATCHED: "Clear physical contradiction in box geometry/material, tape color, or waybill placement indicating parcel swap or relabeling.",
        },
      };
    }

    const decision = await this.evaluate({
      useCase: "return_box_qa",
      entityType: "return_exchange",
      entityId: input.returnId,
      actorId: input.actorId,
      signal: input.signal,
      input: blocks,
      questions,
    });

    const boxAns = decision.answers.box_condition as DecisionChoiceAnswer;
    const sealBrokenAns = decision.answers.seal_broken as DecisionNoulAnswer;
    const boxCondition = boxAns.choice as BoxConditionVerdict;
    const sealBroken = sealBrokenAns.noul >= 0.55;

    const diffFactors: ParcelDiffFactor[] = [];
    const discrepancyEvidence: string[] = [];
    const factorProbs: Record<string, number> = {
      seal_broken: Number(sealBrokenAns.noul.toFixed(4)),
    };

    if (sealBroken) {
      diffFactors.push("SEAL_BROKEN");
      discrepancyEvidence.push(`Phát hiện dấu hiệu rách/bóc băng keo niêm phong (xác suất ${(sealBrokenAns.noul * 100).toFixed(0)}%).`);
    }

    let matchVerdict: ParcelMatchVerdict = "MATCHED";
    let tamperingRiskScore = sealBroken ? Math.round(sealBrokenAns.noul * 48) : Math.round(sealBrokenAns.noul * 15);
    let confidenceScore = Number(boxAns.confidence.toFixed(4));

    if (hasPair) {
      const tapeAns = decision.answers.diff_tape_color as DecisionNoulAnswer;
      const labelAns = decision.answers.diff_label_pos as DecisionNoulAnswer;
      const ratioAns = decision.answers.diff_box_ratio as DecisionNoulAnswer;
      const matchAns = decision.answers.identity_match as DecisionChoiceAnswer;

      factorProbs.diff_tape_color = Number(tapeAns.noul.toFixed(4));
      factorProbs.diff_label_pos = Number(labelAns.noul.toFixed(4));
      factorProbs.diff_box_ratio = Number(ratioAns.noul.toFixed(4));
      factorProbs.mismatch_prob = Number((matchAns.probabilities.MISMATCHED ?? 0).toFixed(4));
      factorProbs.suspicious_prob = Number((matchAns.probabilities.SUSPICIOUS_DIFF ?? 0).toFixed(4));

      if (tapeAns.noul >= 0.50) {
        diffFactors.push("TAPE_COLOR");
        discrepancyEvidence.push(`Màu sắc / kiểu dán băng keo thay đổi so với ảnh bàn giao ĐVVC (${(tapeAns.noul * 100).toFixed(0)}%).`);
      }
      if (labelAns.noul >= 0.50) {
        diffFactors.push("LABEL_POS");
        discrepancyEvidence.push(`Vị trí hoặc bố cục tem vận đơn/QR không khớp với ảnh lúc nhận hàng (${(labelAns.noul * 100).toFixed(0)}%).`);
      }
      if (ratioAns.noul >= 0.50) {
        diffFactors.push("BOX_RATIO");
        discrepancyEvidence.push(`Tỷ lệ hình học / chất liệu vỏ thùng khác biệt so với kiện gốc (${(ratioAns.noul * 100).toFixed(0)}%).`);
      }

      // Weighted Visual Forensics Risk Formula (0..100)
      const weightedSignal =
        (matchAns.probabilities.MISMATCHED ?? 0) * 42 +
        (matchAns.probabilities.SUSPICIOUS_DIFF ?? 0) * 22 +
        ratioAns.noul * 18 +
        tapeAns.noul * 14 +
        labelAns.noul * 14 +
        sealBrokenAns.noul * 12;
      tamperingRiskScore = Math.max(0, Math.min(100, Math.round(weightedSignal)));

      if (tamperingRiskScore > 75 || (matchAns.choice === "MISMATCHED" && matchAns.confidence >= 0.78)) {
        matchVerdict = "MISMATCHED";
        tamperingRiskScore = Math.max(76, tamperingRiskScore);
      } else if (tamperingRiskScore >= 40 || matchAns.choice === "SUSPICIOUS_DIFF" || diffFactors.length > 0) {
        matchVerdict = "SUSPICIOUS_DIFF";
        tamperingRiskScore = Math.max(40, Math.min(75, tamperingRiskScore));
      } else {
        matchVerdict = "MATCHED";
      }

      confidenceScore = Number(((boxAns.confidence + matchAns.confidence) / 2).toFixed(4));
    } else if (sealBroken) {
      matchVerdict = "SUSPICIOUS_DIFF";
      tamperingRiskScore = Math.max(45, tamperingRiskScore);
    }

    const carrierClaimRecommended = boxCondition === "SEVERE_CRUSH" || boxCondition === "TORN_WET";
    const freezeAutoRefund = matchVerdict === "MISMATCHED" || matchVerdict === "SUSPICIOUS_DIFF";
    // Visual Forensics grey-zone [40..75] or low confidence ALWAYS enforces 1-click Human-in-the-Loop
    const requiresHumanReview =
      (tamperingRiskScore >= 40 && tamperingRiskScore <= 75) ||
      matchVerdict !== "MATCHED" ||
      carrierClaimRecommended ||
      confidenceScore < HUMAN_REVIEW_CONFIDENCE_FLOOR;

    // Map directly to ReturnFlowComponent QA failure codes so warehouse operator gets 1-click prefill!
    const suggestedQaFailedCodes: string[] = [];
    if (matchVerdict === "MISMATCHED") suggestedQaFailedCodes.push("package_mismatch");
    if (sealBroken) suggestedQaFailedCodes.push("seal_broken");
    if (boxCondition === "TORN_WET") suggestedQaFailedCodes.push("condition_bad");

    const suggestedDisposition: ReturnBoxForensicsDecision["suggested_disposition"] =
      boxCondition === "TORN_WET"
        ? "scrap"
        : boxCondition === "SEVERE_CRUSH"
          ? "repair"
          : "restock";

    const carrierClaimReport: CarrierDisputeReport | null =
      carrierClaimRecommended || matchVerdict !== "MATCHED"
        ? {
            report_code: `DSP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
            generated_at: new Date().toISOString(),
            return_code: input.returnCode || null,
            tracking_code: input.trackingCode || null,
            carrier_name: input.carrierName || null,
            box_condition: boxCondition,
            match_verdict: matchVerdict,
            tampering_risk_score: tamperingRiskScore,
            discrepancy_factors: diffFactors,
            recommended_claim_action:
              matchVerdict === "MISMATCHED"
                ? "Đóng băng hoàn tiền tự động, trích xuất video đóng gói/mở hộp và lập biên bản tra soát tráo kiện với ĐVVC."
                : carrierClaimRecommended
                  ? "Lập biên bản bồi hoàn hư hỏng ngoại quan gửi ĐVVC kèm cặp ảnh đối chứng lúc lấy hàng và lúc nhập kho."
                  : "Yêu cầu nhân viên QA kho kiểm tra video mở hộp xác nhận thực tế trước khi nhập tồn.",
            summary_vi: buildDisputeSummaryVi(boxCondition, matchVerdict, tamperingRiskScore, diffFactors, input.trackingCode),
          }
        : null;

    void recordDecisionAuditLog({
      useCase: "return_box_qa",
      entityType: "return_exchange",
      entityId: input.returnId,
      rolloutMode: decision.rolloutMode,
      modelUsed: decision.modelUsed,
      transport: decision.transport,
      usedFallbackKey: decision.usedFallbackKey,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      confidenceScore,
      requiresHumanReview,
      verdictCode: `${boxCondition}:${matchVerdict}:RISK_${tamperingRiskScore}`,
      rawAnswers: serializeAnswers(decision.answers),
      downstreamAction: freezeAutoRefund
        ? "FREEZE_REFUND_AND_QA_ESCALATE"
        : carrierClaimRecommended
          ? "GENERATE_CARRIER_CLAIM"
          : "ALLOW_STANDARD_QA_RECEIPT",
      actorId: input.actorId,
    });

    return {
      box_condition: boxCondition,
      seal_intact: !sealBroken,
      carrier_claim_recommended: carrierClaimRecommended,
      match_verdict: matchVerdict,
      diff_factors: diffFactors,
      tampering_risk_score: tamperingRiskScore,
      confidence_score: confidenceScore,
      requires_human_review: requiresHumanReview,
      freeze_auto_refund: freezeAutoRefund,
      suggested_qa_failed_codes: suggestedQaFailedCodes,
      suggested_disposition: suggestedDisposition,
      discrepancy_evidence: discrepancyEvidence,
      factor_probabilities: factorProbs,
      carrier_claim_report: carrierClaimReport,
      telemetry: {
        model_used: decision.modelUsed,
        transport: decision.transport,
        used_fallback_key: decision.usedFallbackKey,
        latency_ms: decision.latencyMs,
      },
    };
  }

  /**
   * 5. Auto-Blog & Promotion Product Curation Decision Engine:
   * Evaluates stock depth, discount/margin attractiveness, customer rating, and Visual QA verdict
   * to route SKUs into `AUTO_BLOG_PUBLISH`, `SEMI_AUTO_REVIEW`, or `EXCLUDE` + campaign role.
   */
  async decideAutoBlogProductCuration(input: {
    productId: string;
    name: string;
    availableStock: number;
    basePrice: number;
    salePrice: number | null;
    imageQaVerdict: ImageQaVerdict;
    imageQaScore: number;
    ratingAvg?: number;
    reviewCount?: number;
    campaignGoal?: string;
    actorId?: string | null;
    signal?: AbortSignal;
  }): Promise<AutoBlogCurationDecision> {
    // Hard deterministic business guardrails: out-of-stock or rejected-image SKUs NEVER enter blog curation
    if (input.availableStock <= 0 || input.imageQaVerdict === "REJECTED") {
      return {
        product_id: input.productId,
        publish_mode: "EXCLUDE",
        campaign_fit: "BUNDLE_ADDON",
        curation_score: 0,
        confidence_score: 0.99,
        requires_human_review: false,
        rationale_vi:
          input.availableStock <= 0
            ? "Loại tự động vì sản phẩm hiện hết tồn kho khả dụng."
            : "Loại tự động vì chất lượng hình ảnh chưa đạt chuẩn kiểm định Visual QA.",
        telemetry: {
          model_used: "deterministic-guardrail",
          transport: "deterministic_fallback",
          used_fallback_key: false,
          latency_ms: 0,
        },
      };
    }

    const discountPct =
      input.salePrice && input.salePrice < input.basePrice && input.basePrice > 0
        ? Math.round(((input.basePrice - input.salePrice) / input.basePrice) * 100)
        : 0;

    const payload = JSON.stringify({
      product_id: input.productId,
      name: input.name,
      available_stock: input.availableStock,
      base_price_vnd: input.basePrice,
      sale_price_vnd: input.salePrice,
      discount_percent: discountPct,
      image_qa_verdict: input.imageQaVerdict,
      image_qa_score_5: input.imageQaScore,
      customer_rating_avg: input.ratingAvg ?? 4.6,
      customer_review_count: input.reviewCount ?? 0,
      campaign_goal: input.campaignGoal || "Editorial & Seasonal Promotion",
    });

    const decision = await this.evaluate({
      useCase: "blog_product_curation",
      entityType: "product",
      entityId: input.productId,
      actorId: input.actorId,
      signal: input.signal,
      input: payload,
      questions: {
        publish_mode: {
          type: "choice",
          instructions:
            "Select the editorial blog automation tier based on `image_qa_verdict`, `available_stock`, `customer_rating_avg`, and `discount_percent`.",
          criteria: {
            AUTO_BLOG_PUBLISH:
              "APPROVED_HERO image quality (>=4.3/5), healthy stock (>=5 units), strong customer rating (>=4.2), ready for automated weekly SEO/Promo blog features.",
            SEMI_AUTO_REVIEW:
              "APPROVED_STANDARD or NEEDS_EDIT image quality or moderate stock (1..4 units); include in candidate pool for 1-click marketer approval.",
            EXCLUDE:
              "Poor customer rating (<3.2 with complaints), insufficient commercial fit, or severe quality limitations.",
          },
        },
        campaign_fit: {
          type: "choice",
          instructions: "Classify the merchandising role of this SKU inside a fashion blog/promotion campaign.",
          criteria: {
            HERO_PRODUCT: "Flagship statement garment with strong visual appeal and healthy stock to anchor the article.",
            BUNDLE_ADDON: "Versatile styling piece or accessory ideal for cross-selling outfit combinations.",
            CLEARANCE: "High-stock or discounted item (>=15% off) suited for flash-sale / seasonal clearance campaigns.",
          },
        },
        commercial_readiness: {
          type: "score",
          instructions: "Rate overall merchandising readiness for AI promotional storytelling.",
          criteria: [
            "Low commercial appeal or constrained inventory.",
            "Moderate appeal suitable for secondary mention.",
            "Strong merchandising candidate with good stock and visual quality.",
            "Top-tier flagship SKU with hero photography, strong stock, and compelling offer.",
          ],
        },
      },
    });

    const modeAns = decision.answers.publish_mode as DecisionChoiceAnswer;
    const fitAns = decision.answers.campaign_fit as DecisionChoiceAnswer;
    const scoreAns = decision.answers.commercial_readiness as DecisionScoreAnswer;

    let publishMode = modeAns.choice as AutoBlogPublishMode;
    // Enforce strict image QA ceiling: non-HERO images cannot bypass human review into AUTO_BLOG_PUBLISH
    if (publishMode === "AUTO_BLOG_PUBLISH" && input.imageQaVerdict !== "APPROVED_HERO") {
      publishMode = "SEMI_AUTO_REVIEW";
    }
    if (publishMode === "AUTO_BLOG_PUBLISH" && input.availableStock < 3) {
      publishMode = "SEMI_AUTO_REVIEW";
    }

    const campaignFit = fitAns.choice as CampaignProductFit;
    const curationScore = Number(((scoreAns.score / 3) * 100).toFixed(1));
    const confidenceScore = Number(((modeAns.confidence + fitAns.confidence) / 2).toFixed(4));
    const requiresHumanReview = publishMode === "SEMI_AUTO_REVIEW" || confidenceScore < HUMAN_REVIEW_CONFIDENCE_FLOOR;

    const rationaleVi =
      publishMode === "AUTO_BLOG_PUBLISH"
        ? `Đạt chuẩn ảnh Hero (${input.imageQaScore}/5), tồn kho ${input.availableStock} SP${discountPct > 0 ? `, ưu đãi ${discountPct}%` : ""} — sẵn sàng đưa vào luồng AI Blog tự động (${campaignFit}).`
        : publishMode === "SEMI_AUTO_REVIEW"
          ? `Phù hợp vai trò ${campaignFit} (ảnh ${input.imageQaVerdict}, tồn ${input.availableStock} SP) — đề xuất Marketer duyệt 1-click.`
          : `Chưa ưu tiên đưa vào chiến dịch hiện tại (điểm thương mại ${curationScore}/100).`;

    void recordDecisionAuditLog({
      useCase: "blog_product_curation",
      entityType: "product",
      entityId: input.productId,
      rolloutMode: decision.rolloutMode,
      modelUsed: decision.modelUsed,
      transport: decision.transport,
      usedFallbackKey: decision.usedFallbackKey,
      latencyMs: decision.latencyMs,
      inputTokens: decision.inputTokens,
      confidenceScore,
      requiresHumanReview,
      verdictCode: `${publishMode}:${campaignFit}`,
      rawAnswers: serializeAnswers(decision.answers),
      downstreamAction: publishMode,
      actorId: input.actorId,
    });

    return {
      product_id: input.productId,
      publish_mode: publishMode,
      campaign_fit: campaignFit,
      curation_score: curationScore,
      confidence_score: confidenceScore,
      requires_human_review: requiresHumanReview,
      rationale_vi: rationaleVi,
      telemetry: {
        model_used: decision.modelUsed,
        transport: decision.transport,
        used_fallback_key: decision.usedFallbackKey,
        latency_ms: decision.latencyMs,
      },
    };
  }
}

export const unifiedDecisionService = new UnifiedDecisionService();

// ============================================================================
// Pure Scientific & Business Routing Helpers
// ============================================================================

function resolveScientificSeason(
  modelSeason: FourSeason,
  confidence: number,
  baseDepth: BaseSkinDepth,
  undertone: SkinUndertone,
  contrast: ContrastLevel,
): FourSeason {
  if (confidence >= 0.72 && ["Spring", "Summer", "Autumn", "Winter"].includes(modelSeason)) {
    // Reconcile stark contradictions between undertone and 4-season color theory
    if (undertone === "WARM" && (modelSeason === "Summer" || modelSeason === "Winter")) {
      return baseDepth === "LIGHT_TONE" && contrast !== "LOW" ? "Spring" : "Autumn";
    }
    if (undertone === "COOL" && (modelSeason === "Spring" || modelSeason === "Autumn")) {
      return baseDepth === "DARK_TONE" || contrast === "HIGH" ? "Winter" : "Summer";
    }
    return modelSeason;
  }
  if (undertone === "WARM") {
    return baseDepth === "LIGHT_TONE" ? "Spring" : "Autumn";
  }
  if (undertone === "COOL") {
    return contrast === "HIGH" || baseDepth === "DARK_TONE" ? "Winter" : "Summer";
  }
  // NEUTRAL_OLIVE balances on depth + contrast
  if (baseDepth === "LIGHT_TONE") {
    return contrast === "HIGH" ? "Winter" : "Summer";
  }
  return contrast === "HIGH" ? "Winter" : "Autumn";
}

function buildCskhBranchGuidelines(
  branch: CskhRoutingBranch,
  intent: CskhIntentLabel,
  escalate: boolean,
): string[] {
  if (branch === "NURTURE_AND_UPSELL") {
    return [
      "Tri ân chân thành và đồng hành khích lệ cảm hứng mặc đẹp cùng Velura Atelier.",
      "Gợi ý tinh tế cách bảo quản chất liệu hoặc phối kèm phụ kiện/thiết kế cùng tông trong kho (chỉ dùng sản phẩm thật được cấp).",
      "Khuyến khích khách chia sẻ hình ảnh trải nghiệm hoặc tích lũy điểm thành viên Velura Loyalty.",
    ];
  }
  if (branch === "EDUCATE_AND_LOYALTY_HOOK") {
    return [
      "Giải đáp trực diện, súc tích đúng thông tin size, chất liệu, tồn kho hoặc chính sách chính thức của Velura.",
      "Nhắc nhẹ quyền lợi gắn bó thành viên (tích điểm Loyalty / ưu đãi hiện hành đã được phê duyệt) không gây áp lực mua sắm.",
      intent === "RETURN_REQ"
        ? "Hướng dẫn rõ ràng điều kiện và quy trình gửi yêu cầu đổi trả trong thời hạn quy định."
        : "Đặt 1 câu hỏi mở ngắn gọn về số đo hoặc dịp mặc để cá nhân hóa tư vấn sâu hơn.",
    ];
  }
  return [
    "Chuẩn hóa giọng văn đồng cảm, điềm tĩnh, nhận trách nhiệm xác minh ngay lập tức và tuyệt đối không tranh cãi với khách.",
    "Thu thập chính xác mã đơn hàng và hình ảnh/video thực tế để đối chiếu quy trình QA chuẩn SOP; không tự ý hứa hoàn tiền hay cấp mã giảm giá vượt thẩm quyền.",
    escalate
      ? "Chuyển tiếp ưu tiên cao (L3 Escalation) cho chuyên viên CSKH tiếp nhận xử lý trực tiếp trên hồ sơ."
      : "Đề xuất phương án xử lý nằm trong chính sách đã duyệt và hỏi xác nhận sự đồng thuận của khách hàng.",
  ];
}

function buildDisputeSummaryVi(
  boxCondition: BoxConditionVerdict,
  matchVerdict: ParcelMatchVerdict,
  riskScore: number,
  factors: readonly ParcelDiffFactor[],
  trackingCode?: string | null,
): string {
  const conditionLabels: Record<BoxConditionVerdict, string> = {
    INTACT: "nguyên vẹn",
    MINOR_DENT: "cấn nhẹ góc hộp",
    SEVERE_CRUSH: "móp méo biến dạng nặng",
    TORN_WET: "rách thủng / ướt mục vỏ kiện",
  };
  const matchLabels: Record<ParcelMatchVerdict, string> = {
    MATCHED: "khớp đặc điểm nhận dạng kiện gốc",
    SUSPICIOUS_DIFF: "có điểm bất thường vùng xám cần QA kiểm chứng",
    MISMATCHED: "sai lệch nghiêm trọng đặc điểm nhận dạng so với ảnh bàn giao",
  };
  const factorText = factors.length ? ` (yếu tố nghi vấn: ${factors.join(", ")})` : "";
  return `Biên bản giám định ngoại quan vận đơn ${trackingCode || "chưa rõ AWB"}: Tình trạng vỏ kiện ${conditionLabels[boxCondition]}; kết quả đối chiếu ${matchLabels[matchVerdict]} — điểm rủi ro can thiệp ${riskScore}/100${factorText}.`;
}

function serializeAnswers(answers: Readonly<Record<string, DecisionAnswer>>): JsonObject {
  return JSON.parse(JSON.stringify(answers)) as JsonObject;
}
