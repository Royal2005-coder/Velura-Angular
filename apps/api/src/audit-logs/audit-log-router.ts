import { sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { AuditLogService } from "./audit-log-service.js";

/**
 * Admin audit-log HTTP routes under `/api/v1/admin/audit-logs`.
 */
export async function handleAuditLogRoute({ req, res, url, parts, context, headers, service }: RouteArgs<AuditLogService>): Promise<boolean> {
  if (req.method !== "GET" || parts.join("/") !== "api/v1/admin/audit-logs") return false;
  sendJson(res, 200, await service.list(context, url.searchParams), headers);
  return true;
}
