/**
 * Admin HTTP Router for the Unified Gemini Decision Engine (`/api/v1/admin/ai-decisions/*`).
 *
 * Exposes:
 * - `GET  /api/v1/admin/ai-decisions/status`: Telemetry, rollout mode, circuit-breaker & fallback readiness
 * - `POST /api/v1/admin/ai-decisions/cskh-route`: CSKH & Chatbot Sentiment Branching Decision Router
 * - `POST /api/v1/admin/ai-decisions/product-qa`: 4-Axis Product Image Quality Taxonomy & Blog Eligibility
 * - `POST /api/v1/admin/ai-decisions/blog-curate`: Batch Auto-Blog SKU Curation Decision
 */

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { HttpError, readJson, sendJson } from "../http.js";
import { requireAdmin } from "../rbac.js";
import { insertRow, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asNumber, asString, type AuthContext, type JsonObject, type RouteArgs } from "../types.js";
import {
  isDecisionEngineConfigured,
  readDecisionEngineMetrics,
  resolveFallbackGeminiKey,
  resolveRolloutMode,
} from "./gemini-decision-client.js";
import { unifiedDecisionService, type UnifiedDecisionService } from "./decision-service.js";
import type { ImageQaVerdict } from "./decision-types.js";

/**
 * Dispatches `/api/v1/admin/ai-decisions` admin requests to `UnifiedDecisionService`.
 */
export async function handleDecisionAdminRoute({
  req,
  res,
  parts,
  context,
  headers,
  service = unifiedDecisionService,
}: RouteArgs<UnifiedDecisionService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "ai-decisions") {
    return false;
  }

  requireAdmin(context as AuthContext);
  const actorId = context?.profile?.user_id || context?.authUser?.id || null;

  if (req.method === "GET" && parts[4] === "status" && parts.length === 5) {
    const rollout = resolveRolloutMode("status-probe");
    sendJson(
      res,
      200,
      {
        configured: isDecisionEngineConfigured(),
        decisionModel: config.geminiDecisionModel || "gemini-decision-1",
        rolloutMode: rollout.mode,
        canaryPercent: config.aiDecisionCanaryPercent,
        primaryKeyConfigured: Boolean(config.geminiApiKey.trim()),
        fallbackKeyConfigured: Boolean(resolveFallbackGeminiKey()),
        gatewayConfigured: Boolean(process.env.LITELLM_ENDPOINT && process.env.LITELLM_API_KEY),
        metrics: readDecisionEngineMetrics(),
      },
      headers,
    );
    return true;
  }

  if (req.method === "POST" && parts[4] === "cskh-route" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    const message = asString(body.message).trim();
    if (!message && body.rating == null) {
      throw new HttpError(422, "VALIDATION_ERROR", "Cần nội dung tin nhắn hoặc điểm đánh giá của khách hàng.");
    }
    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history = rawHistory.map((item) => {
      const obj = asJsonObject(item);
      return { sender: asString(obj.sender) || "user", text: asString(obj.text) };
    });
    const decision = await service.decideCskhSentiment({
      message,
      history,
      rating: body.rating == null ? undefined : Number(body.rating),
      contextKind: (["chat", "review", "ticket"].includes(asString(body.contextKind))
        ? asString(body.contextKind)
        : "chat") as "chat" | "review" | "ticket",
      entityId: asString(body.entityId) || undefined,
      actorId,
    });
    sendJson(res, 200, decision as unknown as JsonObject, headers);
    return true;
  }

  if (req.method === "POST" && parts[4] === "product-qa" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    const { bytes, mime, imageUrl } = await decodeAdminImagePayload(body);
    const productId = asString(body.productId).trim() || undefined;
    const productName = asString(body.productName).trim() || undefined;

    const decision = await service.decideProductImageQa(bytes, mime, {
      productId,
      productName,
      actorId,
    });

    if (productId && /^[0-9a-f-]{36}$/i.test(productId) && config.supabaseUrl && config.supabaseServiceRoleKey) {
      await persistProductAiQa(productId, imageUrl, bytes, decision).catch(() => undefined);
    }

    sendJson(res, 200, decision as unknown as JsonObject, headers);
    return true;
  }

  if (req.method === "POST" && parts[4] === "blog-curate" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    const campaignGoal = asString(body.campaignGoal).trim() || undefined;
    const items = Array.isArray(body.products) ? body.products : [];
    if (!items.length || items.length > 30) {
      throw new HttpError(422, "VALIDATION_ERROR", "Gửi từ 1 đến 30 sản phẩm cần chấm điểm tuyển chọn Blog.");
    }
    const results = [];
    for (const raw of items) {
      const p = asJsonObject(raw);
      const verdictRaw = asString(p.imageQaVerdict) as ImageQaVerdict;
      const verdict: ImageQaVerdict = ["APPROVED_HERO", "APPROVED_STANDARD", "NEEDS_EDIT", "REJECTED"].includes(verdictRaw)
        ? verdictRaw
        : "APPROVED_STANDARD";
      results.push(
        await service.decideAutoBlogProductCuration({
          productId: asString(p.productId) || "unknown",
          name: asString(p.name) || "Sản phẩm Velura",
          availableStock: Math.max(0, asNumber(p.availableStock) || 0),
          basePrice: Math.max(0, asNumber(p.basePrice) || 0),
          salePrice: p.salePrice == null ? null : Math.max(0, asNumber(p.salePrice)),
          imageQaVerdict: verdict,
          imageQaScore: Math.max(1, Math.min(5, Number(p.imageQaScore) || 4.0)),
          ratingAvg: p.ratingAvg == null ? undefined : Number(p.ratingAvg),
          reviewCount: p.reviewCount == null ? undefined : Number(p.reviewCount),
          campaignGoal,
          actorId,
        }),
      );
    }
    sendJson(res, 200, { results }, headers);
    return true;
  }

  return false;
}

/** Persists or updates a product's 4-axis Visual QA Taxonomy row in `public.product_ai_qa`. */
export async function persistProductAiQa(
  productId: string,
  imageUrl: string,
  bytes: Buffer,
  decision: Awaited<ReturnType<UnifiedDecisionService["decideProductImageQa"]>>,
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const payload = {
    product_id: productId,
    image_url: imageUrl,
    image_sha256: sha,
    verdict: decision.final_verdict,
    overall_score: decision.average_taxonomy_score,
    sharpness_focus: decision.axes.sharpness_focus,
    lighting_exposure: decision.axes.lighting_exposure,
    composition_framing: decision.axes.composition_framing,
    background_cleanliness: decision.axes.background_cleanliness,
    defect_tags: [...decision.defect_tags],
    actionable_fix: [...decision.actionable_fix],
    blog_auto_eligible: decision.blog_auto_eligible,
    publish_mode:
      decision.final_verdict === "APPROVED_HERO"
        ? "AUTO_BLOG_PUBLISH"
        : decision.final_verdict === "REJECTED"
          ? "EXCLUDE"
          : "SEMI_AUTO_REVIEW",
    decision_confidence: decision.confidence_score,
    requires_human_review: decision.requires_human_review,
    evaluated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const existing = await selectRows("product_ai_qa", {
    select: "product_id",
    product_id: `eq.${productId}`,
    limit: "1",
  }).catch(() => ({ rows: [] }));

  if (existing.rows?.length) {
    const { product_id: _pid, ...patch } = payload;
    await updateRows("product_ai_qa", { product_id: `eq.${productId}` }, patch);
  } else {
    await insertRow("product_ai_qa", payload);
  }
}

async function decodeAdminImagePayload(body: JsonObject): Promise<{
  bytes: Buffer;
  mime: "image/jpeg" | "image/png" | "image/webp";
  imageUrl: string;
}> {
  const b64 = asString(body.imageBase64).trim();
  if (b64) {
    const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(cleaned, "base64");
    if (bytes.length < 16 || bytes.length > 10 * 1024 * 1024) {
      throw new HttpError(422, "INVALID_IMAGE", "Ảnh tải lên phải hợp lệ và nhỏ hơn 10 MB.");
    }
    return { bytes, mime: sniffRasterMime(bytes), imageUrl: asString(body.imageUrl) };
  }
  const imageUrl = asString(body.imageUrl).trim();
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new HttpError(422, "IMAGE_REQUIRED", "Cần cung cấp imageBase64 hoặc đường dẫn https:// của ảnh.");
  }
  const resp = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new HttpError(422, "IMAGE_FETCH_FAILED", "Không tải được ảnh sản phẩm để kiểm định.");
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length < 16 || bytes.length > 10 * 1024 * 1024) {
    throw new HttpError(422, "INVALID_IMAGE", "Dung lượng ảnh không hợp lệ.");
  }
  return { bytes, mime: sniffRasterMime(bytes), imageUrl };
}

function sniffRasterMime(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}
