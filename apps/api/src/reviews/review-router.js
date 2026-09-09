import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleReviewRoute({ req, res, url, parts, context, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "reviews") return false;
  const requestMeta = { ipAddress: getRequestIp(req) };

  if (req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.list(context, url.searchParams), headers);
    return true;
  }

  if (req.method === "GET" && parts[4] === "audit-logs" && parts.length === 5) {
    sendJson(res, 200, await service.listAuditLogs(context, url.searchParams), headers);
    return true;
  }

  const reviewId = parts[4];
  if (!reviewId) return false;

  if (req.method === "GET" && parts.length === 5) {
    sendJson(res, 200, await service.get(context, reviewId), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "approve" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.approve(context, reviewId, body), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "hide" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.hide(context, reviewId, body), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "reply" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.reply(context, reviewId, body), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "escalate" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.escalate(context, reviewId, body), headers);
    return true;
  }

  return false;
}
