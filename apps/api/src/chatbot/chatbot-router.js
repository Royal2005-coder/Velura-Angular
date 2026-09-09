import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleChatbotRoute({ req, res, url, parts, context, headers, service, limiter }) {
  if (parts[0] !== "api" || parts[1] !== "v1") return false;

  const requestMeta = { ipAddress: getRequestIp(req) };

  if (parts[2] === "chat") {
    if (req.method === "GET" && parts[3] === "sessions" && parts.length === 4) {
      sendJson(res, 200, await service.listSessions(context, url.searchParams), headers);
      return true;
    }

    if (req.method === "POST" && parts[3] === "sessions" && parts.length === 4) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 201, await service.createSession(context, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[3] === "messages" && parts.length === 4) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.sendMessage(context, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[3] === "favorites" && parts.length === 4) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.saveFavorite(context, body), headers);
      return true;
    }

    if (req.method === "POST" && parts[3] === "favorites" && parts[4] === "sync" && parts.length === 5) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.syncFavorites(context, body), headers);
      return true;
    }

    const sessionId = parts[3];
    if (!sessionId) return false;

    if (req.method === "GET" && parts[4] === "messages" && parts.length === 5) {
      sendJson(res, 200, await service.getMessages(context, sessionId, url.searchParams), headers);
      return true;
    }

    if (req.method === "DELETE" && parts.length === 4) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes).catch(() => ({}));
      sendJson(res, 200, await service.deleteSession(context, sessionId, body), headers);
      return true;
    }
  }

  if (parts[2] === "admin" && parts[3] === "chat-sessions") {
    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, await service.listAdminSessions(context, url.searchParams), headers);
      return true;
    }

    const sessionId = parts[4];
    if (req.method === "GET" && sessionId && parts[5] === "messages" && parts.length === 6) {
      sendJson(res, 200, await service.getAdminMessages(context, sessionId, url.searchParams), headers);
      return true;
    }

    if (req.method === "POST" && sessionId && parts[5] === "reply" && parts.length === 6) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.agentReply(context, sessionId, body), headers);
      return true;
    }

    if (req.method === "POST" && sessionId && parts[5] === "assign" && parts.length === 6) {
      applyChatRateLimit(req, res, limiter, requestMeta.ipAddress);
      const body = await readJson(req, config.maxBodyBytes);
      sendJson(res, 200, await service.assignSession(context, sessionId, body), headers);
      return true;
    }
  }

  return false;
}

function applyChatRateLimit(req, res, limiter, ipAddress) {
  if (!limiter) return;
  const rate = limiter.consume(ipAddress || getRequestIp(req));
  res.setHeader("x-ratelimit-remaining", String(rate.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1000)));
  if (!rate.allowed) {
    const error = new Error("Too many chatbot requests");
    error.name = "HttpError";
    error.status = 429;
    error.code = "RATE_LIMITED";
    throw error;
  }
}
