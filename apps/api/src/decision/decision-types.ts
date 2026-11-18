/**
 * Contracts for the Unified Gemini Decision Engine (`gemini-decision-1` via `/v1beta/decisions`)
 * and its five production Velura commerce taxonomies.
 */

import type { JsonObject } from "../types.js";

/** Supported use-cases tracked in telemetry and `public.ai_decision_log`. */
export type DecisionUseCase =
  | "personal_color"
  | "cskh_sentiment"
  | "product_image_qa"
  | "return_box_qa"
  | "blog_product_curation"
  | "blog_editorial_gate";

/** Rollout stage controlling whether AI decisions actively route or only shadow-log. */
export type DecisionRolloutMode = "shadow" | "canary" | "active";

/** Transport tier that fulfilled a decision evaluation. */
export type DecisionTransport =
  | "decisions_api"
  | "fallback_decisions_api"
  | "structured_json_fallback"
  | "deterministic_fallback";

/** Multimodal input blocks accepted by Google's Gemini Decisions API (`/v1beta/decisions`). */
export type DecisionInputBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mime_type: "image/jpeg" | "image/png" | "image/webp";
      readonly resolution?: "low" | "medium" | "high" | "ultra_high";
    }
  | {
      readonly type: "document";
      readonly data: string;
      readonly mime_type: "application/pdf";
    };

/** Binary Yes/No (`noul`) question returning calibrated probability in `[0.01, 0.99]`. */
export interface DecisionNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: {
    readonly true_description?: string;
    readonly false_description?: string;
  };
}

/** Mutually exclusive categorical (`choice`) question over 2..255 options. */
export interface DecisionChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Ordered discrete rubric (`score`) question over 2..255 levels indexed `0..N-1`. */
export interface DecisionScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

/** Union of typed questions accepted by `gemini-decision-1`. */
export type DecisionQuestion =
  | DecisionNoulQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;

/** Calibrated binary answer from `gemini-decision-1`. */
export interface DecisionNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
  readonly confidence: number;
}

/** Calibrated categorical answer from `gemini-decision-1`. */
export interface DecisionChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Calibrated rubric score answer from `gemini-decision-1`. */
export interface DecisionScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly legend: Readonly<Record<string, string>>;
}

/** Union of calibrated answers returned per question key. */
export type DecisionAnswer =
  | DecisionNoulAnswer
  | DecisionChoiceAnswer
  | DecisionScoreAnswer;

/** Request envelope for `GeminiDecisionClient.decide`. */
export interface CreateDecisionRequest {
  readonly useCase: DecisionUseCase;
  readonly input: string | readonly DecisionInputBlock[];
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorId?: string | null;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Validated response envelope with transport telemetry. */
export interface CreateDecisionResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly modelUsed: string;
  readonly transport: DecisionTransport;
  readonly usedFallbackKey: boolean;
  readonly rolloutMode: DecisionRolloutMode;
  readonly latencyMs: number;
  readonly inputTokens: number;
}

/** Content-free Prometheus-ready telemetry per Decision Engine use-case. */
export interface DecisionEngineMetric {
  useCase: DecisionUseCase;
  requests: number;
  failures: number;
  fallbackKeyCount: number;
  structuredFallbackCount: number;
  humanReviewCount: number;
  latencyMs: number;
  inputTokens: number;
}

// ============================================================================
// 1. Personal Color Scientific Taxonomy (ITA° + Sclera WB + 4-Season Routing)
// ============================================================================

export type LightingQualityVerdict = "PASS" | "RETAKE";
export type BaseSkinDepth = "LIGHT_TONE" | "DARK_TONE";
export type DetailedSkinDepth = "FAIR" | "LIGHT" | "MEDIUM" | "TAN" | "DEEP";
export type SkinUndertone = "COOL" | "WARM" | "NEUTRAL_OLIVE";
export type ContrastLevel = "LOW" | "MEDIUM" | "HIGH";
export type FourSeason = "Spring" | "Summer" | "Autumn" | "Winter";

/** Scientific CIE L*a*b* and sclera white-balance telemetry measured by Sharp before VLM scoring. */
export interface SkinOpticalMeasurement {
  readonly itaAngle: number;
  readonly luminanceL: number;
  readonly redGreenA: number;
  readonly yellowBlueB: number;
  readonly whiteBalanceShift: "BALANCED" | "WARM_CAST" | "COOL_CAST" | "EXTREME_CAST";
  readonly measuredBaseDepth: BaseSkinDepth;
  readonly isBlankSolid?: boolean;
}

/** Output of Use-Case 1: Personal Color Scientific Decision Engine. */
export interface PersonalColorDecision {
  readonly lighting_valid: LightingQualityVerdict;
  readonly failed_checks: readonly string[];
  readonly base_skin_depth: BaseSkinDepth;
  readonly skin_depth: DetailedSkinDepth;
  readonly undertone: SkinUndertone;
  readonly contrast_level: ContrastLevel;
  readonly season: FourSeason | null;
  readonly recommended_palette_ids: readonly string[];
  readonly avoid_palette_ids: readonly string[];
  readonly recommended_hex_palette: readonly string[];
  readonly avoid_hex_palette: readonly string[];
  readonly confidence_score: number;
  readonly requires_human_review: boolean;
  readonly optical_measurement: SkinOpticalMeasurement;
  readonly telemetry: {
    readonly model_used: string;
    readonly transport: DecisionTransport;
    readonly used_fallback_key: boolean;
    readonly latency_ms: number;
  };
}

// ============================================================================
// 2. CSKH & Chatbot Sentiment Branching Decision Router
// ============================================================================

export type CskhSentimentLabel = "POSITIVE" | "NEUTRAL" | "NEGATIVE";
export type CskhUrgencyLevel = "LOW" | "MEDIUM" | "CRITICAL";
export type CskhIntentLabel = "PRAISE" | "INQUIRY" | "COMPLAINT" | "RETURN_REQ";
export type CskhRoutingBranch =
  | "NURTURE_AND_UPSELL"
  | "EDUCATE_AND_LOYALTY_HOOK"
  | "STANDARDIZED_DEESCALATION";

/** Output of Use-Case 2: CSKH Sentiment & Branching Decision Router. */
export interface CskhSentimentDecision {
  readonly sentiment: CskhSentimentLabel;
  readonly urgency: CskhUrgencyLevel;
  readonly intent: CskhIntentLabel;
  readonly routing_branch: CskhRoutingBranch;
  readonly confidence_score: number;
  readonly escalate_to_human: boolean;
  readonly requires_human_review: boolean;
  readonly sentiment_probabilities: Readonly<Record<CskhSentimentLabel, number>>;
  readonly response_guidelines: readonly string[];
  readonly telemetry: {
    readonly model_used: string;
    readonly transport: DecisionTransport;
    readonly used_fallback_key: boolean;
    readonly latency_ms: number;
  };
}

// ============================================================================
// 3. Product Image Quality Taxonomy & Auto-Blog Eligibility
// ============================================================================

export type ImageQaVerdict = "APPROVED_HERO" | "APPROVED_STANDARD" | "NEEDS_EDIT" | "REJECTED";
export type ImageDefectTag =
  | "BLURRY"
  | "WATERMARK"
  | "CLUTTERED_BG"
  | "CROP_CUTOFF"
  | "POOR_EXPOSURE"
  | "LOW_RESOLUTION";

/** Output of Use-Case 3: Product Image Quality Taxonomy Decision Engine. */
export interface ProductImageQaDecision {
  readonly final_verdict: ImageQaVerdict;
  readonly average_taxonomy_score: number;
  readonly axes: {
    readonly sharpness_focus: number;
    readonly lighting_exposure: number;
    readonly composition_framing: number;
    readonly background_cleanliness: number;
  };
  readonly defect_tags: readonly ImageDefectTag[];
  readonly failed_taxonomy_codes: readonly string[];
  readonly actionable_fix: readonly string[];
  readonly blog_auto_eligible: boolean;
  readonly confidence_score: number;
  readonly requires_human_review: boolean;
  readonly telemetry: {
    readonly model_used: string;
    readonly transport: DecisionTransport;
    readonly used_fallback_key: boolean;
    readonly latency_ms: number;
  };
}

// ============================================================================
// 4. Return Box QA & Carrier Tampering Forensics
// ============================================================================

export type BoxConditionVerdict = "INTACT" | "MINOR_DENT" | "SEVERE_CRUSH" | "TORN_WET";
export type ParcelMatchVerdict = "MATCHED" | "SUSPICIOUS_DIFF" | "MISMATCHED";
export type ParcelDiffFactor = "TAPE_COLOR" | "LABEL_POS" | "BOX_RATIO" | "SEAL_BROKEN";

/** Structured carrier dispute evidence report generated when parcel arrives crushed or torn/wet. */
export interface CarrierDisputeReport {
  readonly report_code: string;
  readonly generated_at: string;
  readonly return_code: string | null;
  readonly tracking_code: string | null;
  readonly carrier_name: string | null;
  readonly box_condition: BoxConditionVerdict;
  readonly match_verdict: ParcelMatchVerdict;
  readonly tampering_risk_score: number;
  readonly discrepancy_factors: readonly ParcelDiffFactor[];
  readonly recommended_claim_action: string;
  readonly summary_vi: string;
}

/** Output of Use-Case 4: Return Box QA & Carrier Tampering Forensics Engine. */
export interface ReturnBoxForensicsDecision {
  readonly box_condition: BoxConditionVerdict;
  readonly seal_intact: boolean;
  readonly carrier_claim_recommended: boolean;
  readonly match_verdict: ParcelMatchVerdict;
  readonly diff_factors: readonly ParcelDiffFactor[];
  readonly tampering_risk_score: number;
  readonly confidence_score: number;
  readonly requires_human_review: boolean;
  readonly freeze_auto_refund: boolean;
  readonly suggested_qa_failed_codes: readonly string[];
  readonly suggested_disposition: "restock" | "repair" | "scrap" | "return_supplier";
  readonly discrepancy_evidence: readonly string[];
  readonly factor_probabilities: JsonObject;
  readonly carrier_claim_report: CarrierDisputeReport | null;
  readonly telemetry: {
    readonly model_used: string;
    readonly transport: DecisionTransport;
    readonly used_fallback_key: boolean;
    readonly latency_ms: number;
  };
}

// ============================================================================
// 5. Auto-Blog Product Curation Decision Engine
// ============================================================================

export type AutoBlogPublishMode = "AUTO_BLOG_PUBLISH" | "SEMI_AUTO_REVIEW" | "EXCLUDE";
export type CampaignProductFit = "HERO_PRODUCT" | "BUNDLE_ADDON" | "CLEARANCE";

/** Output of Use-Case 5: Auto-Blog & Promo Product Curation Decision Engine. */
export interface AutoBlogCurationDecision {
  readonly product_id: string;
  readonly publish_mode: AutoBlogPublishMode;
  readonly campaign_fit: CampaignProductFit;
  readonly curation_score: number;
  readonly confidence_score: number;
  readonly requires_human_review: boolean;
  readonly rationale_vi: string;
  readonly telemetry: {
    readonly model_used: string;
    readonly transport: DecisionTransport;
    readonly used_fallback_key: boolean;
    readonly latency_ms: number;
  };
}
