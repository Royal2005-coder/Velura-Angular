import { sendJson } from "./http.js";
import { requirePermission } from "./rbac.js";
import { buildDashboardSummary } from "./dashboard.js";
import type { RouteArgs } from "./types.js";

/**
 * Admin dashboard HTTP routes under `/api/v1/admin/dashboard`.
 */
export async function handleDashboardRoute({
  req,
  res,
  url,
  parts,
  context,
  headers
}: RouteArgs): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "dashboard") {
    return false;
  }
  if (req.method !== "GET" || parts.length !== 4) {
    return false;
  }
  requirePermission(context!, "dashboard", "read");
  sendJson(res, 200, await buildDashboardSummary(url.searchParams), headers);
  return true;
}
