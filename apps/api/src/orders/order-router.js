import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleOrderRoute({ req, res, url, parts, context, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "orders") return false;
  const requestMeta = { ipAddress: getRequestIp(req) };

  if (req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.list(context, url.searchParams), headers);
    return true;
  }

  const orderId = parts[4];
  if (!orderId) return false;

  if (req.method === "GET" && parts.length === 5) {
    sendJson(res, 200, await service.get(context, orderId), headers);
    return true;
  }

  if (req.method === "GET" && parts[5] === "audit-logs" && parts.length === 6) {
    sendJson(res, 200, await service.listAuditLogs(context, orderId, url.searchParams), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "change-status" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.changeStatus(context, orderId, body, requestMeta), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "cancel" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.cancel(context, orderId, body, requestMeta), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "payments" && parts[7] === "resolve" && parts.length === 8) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.resolvePayment(context, orderId, parts[6], body, requestMeta), headers);
    return true;
  }

  return false;
}
