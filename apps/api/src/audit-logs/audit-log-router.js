import { sendJson } from "../http.js";

export async function handleAuditLogRoute({ req, res, url, parts, context, headers, service }) {
  if (req.method !== "GET" || parts.join("/") !== "api/v1/admin/audit-logs") return false;
  sendJson(res, 200, await service.list(context, url.searchParams), headers);
  return true;
}
