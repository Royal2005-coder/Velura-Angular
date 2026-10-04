import {
  asJsonObject,
  errorMessage,
  isJsonObject,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject
} from "./types.js";

/**
 * Domain HTTP error mapped to a JSON error body by `sendError`.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Write a JSON response with the given status.
 */
export function sendJson(
  res: HttpResponse,
  status: number,
  payload: unknown,
  extraHeaders: HeaderMap = {}
): void {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

/**
 * Write an empty 204 response.
 */
export function sendNoContent(res: HttpResponse, extraHeaders: HeaderMap = {}): void {
  res.writeHead(204, extraHeaders);
  res.end();
}

type ErrorLike = {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
};

function extractBusinessError(err: ErrorLike): { code: string; message: string; status?: number; details?: unknown } | null {
  const details = isJsonObject(err.details) ? err.details : {};
  const rawMsg = String(details.message || details.msg || err.message || "");
  const rawCode = String(details.code || err.code || "");
  const rawDetails = String(details.details || "");

  if (rawMsg.includes("users_email_key") || rawDetails.includes("email") || (rawCode === "23505" && rawMsg.includes("email"))) {
    return { code: "EMAIL_ALREADY_EXISTS", message: "Email này đã được sử dụng bởi tài khoản khác. Vui lòng đăng nhập hoặc sử dụng email khác.", status: 409 };
  }
  if (rawMsg.includes("users_phone_key") || rawDetails.includes("phone") || (rawCode === "23505" && rawMsg.includes("phone"))) {
    return { code: "PHONE_ALREADY_EXISTS", message: "Số điện thoại này đã được sử dụng. Vui lòng đăng nhập để tiếp tục.", status: 409 };
  }

  const businessCodes: Record<string, string> = {
    INSUFFICIENT_STOCK: "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.",
    VOUCHER_CHANGED: "Mã giảm giá đã thay đổi hoặc hết lượt sử dụng. Vui lòng kiểm tra lại đơn hàng.",
    ORDER_TOTAL_MISMATCH: "Tổng tiền đơn hàng không khớp với bảng giá hiện tại. Vui lòng thử lại.",
    INVALID_PAYMENT_METHOD: "Phương thức thanh toán không hợp lệ.",
    DUPLICATE_VARIANT: "Sản phẩm trong đơn hàng bị trùng lặp.",
    VARIANT_NOT_FOUND: "Không tìm thấy thông tin sản phẩm trong hệ thống.",
    ORDER_ITEMS_REQUIRED: "Đơn hàng phải có ít nhất một sản phẩm.",
    INVALID_QUANTITY: "Số lượng sản phẩm không hợp lệ.",
    ORDER_NOT_FOUND: "Không tìm thấy thông tin đơn hàng.",
    ORDER_CANNOT_CANCEL: "Đơn hàng đang ở trạng thái không thể hủy.",
    VERSION_CONFLICT: "Dữ liệu đơn hàng vừa được cập nhật bởi thao tác khác. Vui lòng thử lại.",
    QA_REQUIRED: "Yêu cầu kiểm tra chất lượng trước khi tiếp tục.",
    REFUND_ALREADY_REQUESTED: "Yêu cầu hoàn tiền cho đơn hàng này đã được gửi trước đó.",
    RETURN_WINDOW_CLOSED: "Thời hạn đổi/trả hàng cho sản phẩm này đã kết thúc.",
    EXCHANGE_SAME_PRODUCT_REQUIRED: "Chỉ được đổi sang cùng một sản phẩm với phân loại khác.",
    OTP_PHONE_RATE_LIMIT: "Bạn đã yêu cầu mã OTP quá nhiều lần. Vui lòng thử lại sau.",
    OTP_IP_RATE_LIMIT: "Kết nối mạng này đã gửi quá nhiều yêu cầu OTP. Vui lòng thử lại sau."
  };

  for (const [code, msg] of Object.entries(businessCodes)) {
    if (rawMsg === code || rawMsg.includes(code) || rawCode === code) {
      const status = code === "INSUFFICIENT_STOCK" || code === "VOUCHER_CHANGED" || code === "VERSION_CONFLICT" || code === "REFUND_ALREADY_REQUESTED"
        ? 409
        : code.includes("NOT_FOUND") ? 404 : code.includes("RATE_LIMIT") ? 429 : 422;
      return { code, message: msg, status, details };
    }
  }

  return null;
}

/**
 * Map an thrown value to the standard JSON error envelope.
 */
export function sendError(
  res: HttpResponse,
  error: unknown,
  extraHeaders: HeaderMap = {},
  requestId = ""
): void {
  const isHttpError = error instanceof HttpError;
  const err = error as ErrorLike;
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[Internal Server Error] RequestId: ${requestId}`, error);
  }
  const business = extractBusinessError(err);
  if (business) {
    const payload = {
      error: {
        code: business.code,
        message: business.message,
        details: isHttpError ? err.details : business.details,
        requestId: requestId || undefined,
        timestamp: new Date().toISOString()
      }
    };
    sendJson(res, business.status || status, payload, extraHeaders);
    return;
  }

  const isExplicit = isHttpError || Boolean(err.code && err.message && status !== 500);
  const isDatabaseError = err.code === "SUPABASE_ERROR" || /^(?:[0-9A-Z]{5}|PGRST\d+)$/.test(err.code || "");
  const message = isDatabaseError
    ? "Không thể xử lý dữ liệu. Vui lòng kiểm tra thông tin và thử lại."
    : isExplicit ? (err.message || errorMessage(error)) : (status >= 500 ? "Internal server error" : err.message || errorMessage(error));
  const payload = {
    error: {
      code: err.code || "INTERNAL_ERROR",
      message,
      details: isDatabaseError ? undefined : isExplicit ? err.details : (status >= 500 ? undefined : err.details),
      requestId: requestId || undefined,
      timestamp: new Date().toISOString()
    }
  };
  sendJson(res, status, payload, extraHeaders);
}

/**
 * Read and parse a JSON request body. Empty bodies become `{}`.
 */
export async function readJson(req: HttpRequest, maxBytes = 15728640): Promise<JsonObject> {
  const reqWithBody = req as { body?: unknown };
  if (reqWithBody.body && typeof reqWithBody.body === "object" && reqWithBody.body !== null) {
    return asJsonObject(reqWithBody.body);
  }
  if (typeof reqWithBody.body === "string" && reqWithBody.body.trim()) {
    try {
      return asJsonObject(JSON.parse(reqWithBody.body) as unknown);
    } catch {
      // fallback to streaming
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = req[Symbol.asyncIterator];
  if (typeof iterator !== "function") return {};

  for await (const chunk of { [Symbol.asyncIterator]: () => iterator.call(req) } as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
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
    return asJsonObject(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON", {
      parserMessage: errorMessage(error)
    });
  }
}

/**
 * Split a URL pathname into non-empty segments.
 */
export function parsePathname(url: URL, req?: HttpRequest): string[] {
  const vercelPath = req?.headers?.["x-matched-path"] as string | undefined;
  if (vercelPath && !vercelPath.startsWith("/api/index") && vercelPath !== "/api") {
    return vercelPath.split("/").filter(Boolean);
  }
  return url.pathname.split("/").filter(Boolean);
}

/**
 * Apply CORS headers for the request origin. Returns the header map for reuse.
 */
export function applyCors(
  req: HttpRequest,
  res: HttpResponse,
  corsOrigin: string | string[]
): HeaderMap {
  const requestOriginHeader = req.headers.origin;
  const requestOrigin = Array.isArray(requestOriginHeader)
    ? requestOriginHeader[0]
    : requestOriginHeader;
  const configured = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
  const wildcard = configured.includes("*");
  let allowOrigin = wildcard
    ? requestOrigin || "*"
    : requestOrigin && configured.includes(requestOrigin)
      ? requestOrigin
      : "";

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

  const headers: HeaderMap = {
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-request-id,x-guest-session-id",
    "access-control-max-age": "86400",
    vary: "origin"
  };

  if (allowOrigin) headers["access-control-allow-origin"] = allowOrigin;

  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  return headers;
}

/**
 * Set baseline security headers on every response.
 */
export function applySecurityHeaders(res: HttpResponse, nodeEnv = "development"): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (nodeEnv === "production") {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  }
}

/**
 * Best-effort client IP from `x-forwarded-for` or the socket.
 */
export function getRequestIp(req: HttpRequest): string {
  const forwardedHeader = req.headers["x-forwarded-for"];
  const forwardedRaw = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
  const forwarded = String(forwardedRaw || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "0.0.0.0";
}
