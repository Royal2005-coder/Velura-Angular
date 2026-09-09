export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

export function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, extraHeaders);
  res.end();
}

export function sendError(res, error, extraHeaders = {}, requestId = "") {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(`[Internal Server Error] RequestId: ${requestId}`, error);
  }
  const payload = {
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: status >= 500 ? "Internal server error" : error.message,
      details: status >= 500 ? undefined : error.details,
      requestId: requestId || undefined,
      timestamp: new Date().toISOString()
    }
  };
  sendJson(res, status, payload, extraHeaders);
}

export async function readJson(req, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON", {
      parserMessage: error.message
    });
  }
}

export function parsePathname(url) {
  return url.pathname.split("/").filter(Boolean);
}

export function applyCors(req, res, corsOrigin) {
  const requestOrigin = req.headers.origin;
  const configured = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
  const wildcard = configured.includes("*");
  let allowOrigin = wildcard ? requestOrigin || "*" : configured.includes(requestOrigin) ? requestOrigin : "";

  if (!allowOrigin && requestOrigin && process.env.NODE_ENV !== "production") {
    try {
      const originUrl = new URL(requestOrigin);
      if (
        originUrl.hostname === "localhost" ||
        originUrl.hostname === "127.0.0.1" ||
        originUrl.hostname.startsWith("192.168.") ||
        originUrl.hostname.startsWith("10.") ||
        originUrl.hostname.startsWith("172.") ||
        originUrl.hostname.startsWith("100.")
      ) {
        allowOrigin = requestOrigin;
      }
    } catch {
      // Ignore invalid origin URLs
    }
  }

  const headers = {
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-request-id,x-guest-session-id",
    "access-control-max-age": "86400",
    vary: "origin"
  };

  if (allowOrigin) headers["access-control-allow-origin"] = allowOrigin;

  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  return headers;
}

export function applySecurityHeaders(res, nodeEnv = "development") {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (nodeEnv === "production") {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  }
}

export function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "0.0.0.0";
}
