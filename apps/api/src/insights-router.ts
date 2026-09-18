import { sendJson } from "./http.js";
import { requirePermission } from "./rbac.js";
import { buildDashboardSummary } from "./dashboard.js";
import { buildInsightBoard, moduleForInsightScope, parseInsightScope } from "./insights.js";
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
