import { sendJson } from "./http.js";
import { requirePermission } from "./rbac.js";
import { buildDashboardSummary } from "./dashboard.js";
import { generateGeminiEmbedding, generateGeminiText, isGeminiConfigured } from "./gemini-client.js";
import { callRpc } from "./supabase.js";
import { buildInsightBoard, moduleForInsightScope, parseInsightScope } from "./insights.js";
import { buildGroundedBrief, keepGroundedSentences } from "./insights/grounded-brief.js";
import { isJsonObject, type RouteArgs } from "./types.js";
import type { VoiceInsights } from "./insights.js";

/**
 * Module insight HTTP routes under `/api/v1/admin/insights`.
 */
export async function handleInsightsRoute({
  req,
  res,
  url,
  parts,
  context,
  headers
}: RouteArgs): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "insights") {
    return false;
  }
  if (req.method === "POST" && parts[4] === "recommend" && parts.length === 5) {
    requirePermission(context!, "dashboard", "read");
    const summary = await buildDashboardSummary(url.searchParams);
    const voice = summary.voice as VoiceInsights;
    const brief = buildGroundedBrief(voice);
    if (!isGeminiConfigured()) {
      sendJson(res, 200, { source: "facts", lines: brief, narrative: [] }, headers);
      return true;
    }
    let narrative: string[] = [];
    let policyContext = "";
    try {
      const embedding = await generateGeminiEmbedding(brief.join("\n"));
      const matched = await callRpc("match_policies", {
        query_embedding: embedding,
        match_threshold: 0.15,
        match_count: 3
      });
      const rows = Array.isArray(matched) ? matched : [];
      policyContext = rows
        .map((row) => (row && typeof row === "object" ? String((row as { title?: string; summary?: string }).title || (row as { summary?: string }).summary || "") : ""))
        .filter(Boolean)
        .join("\n");
    } catch {
      policyContext = "";
    }
    try {
      const text = await generateGeminiText(
        [
          "Viết tối đa 3 câu khuyến nghị tiếng Việt cho nhà quản trị Velura.",
          "Chỉ được dùng các con số có trong bản tóm tắt. Không thêm số mới. Không bịa nguyên nhân.",
          "Đoạn chính sách dưới đây chỉ để nhắc quy tắc, không được lấy số từ đó.",
          brief.join("\n"),
          policyContext
        ].join("\n"),
        { temperature: 0.2, maxOutputTokens: 400 }
      );
      narrative = keepGroundedSentences(text, brief).slice(0, 3);
    } catch {
      narrative = [];
    }
    sendJson(res, 200, { source: narrative.length ? "gemini" : "facts", lines: brief, narrative }, headers);
    return true;
  }

  if (req.method !== "GET" || parts.length !== 4) {
    return false;
  }
  const scope = parseInsightScope(url.searchParams.get("scope"));
  requirePermission(context!, moduleForInsightScope(scope), "read");
  const summary = await buildDashboardSummary(url.searchParams);
  const voice = summary.voice as VoiceInsights;
  const business =
    scope === "hq" || scope === "orders" || scope === "promotions" || scope === "pricing"
      ? (isJsonObject(summary.business) ? summary.business : null)
      : null;
  sendJson(
    res,
    200,
    {
      scope,
      range: summary.range,
      from: summary.from,
      to: summary.to,
      voice,
      board: buildInsightBoard(scope, voice, business)
    },
    headers
  );
  return true;
}
