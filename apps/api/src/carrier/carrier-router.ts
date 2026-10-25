import { config } from "../config.js";
import { HttpError, getRequestIp, sendJson } from "../http.js";
import {
  CARRIER_EVENT_STATUSES,
  MAX_CARRIER_BODY_BYTES,
  carrierErrorMessage,
  normalizeCarrierEvent,
  verifyCarrierSignature,
} from "./carrier-contract.js";
import { asJsonObject, type HttpRequest, type HttpResponse, type RateLimiter, type RouteArgs } from "../types.js";
import type { CarrierService } from "./carrier-service.js";

/**
 * Route `/api/v1/webhooks/carrier/:provider` (KAN-106).
 *
 * Nhà vận chuyển không có token người dùng, nên route này được nối TRƯỚC khi `buildAuthContext`
 * chạy: nó không bao giờ đọc Authorization. Bù lại, thân gửi phải được ký HMAC bằng
 * `CARRIER_WEBHOOK_SECRET` trên đúng từng byte thô, và mỗi nhà vận chuyển bị giới hạn tốc độ theo
 * IP. Router chỉ parsing HTTP — toàn bộ nghiệp vụ ở `carrier-service.ts`.
 */
export async function handleCarrierWebhookRoute({
  req,
  res,
  parts,
  headers,
  service,
  limiter,
}: RouteArgs<CarrierService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "webhooks" || parts[3] !== "carrier") return false;

  // Đọc trạng thái surface cho phép CI và đội vận hành xác nhận webhook đã được nối mà không cần
  // bí mật ký. Cùng khuôn với `providers` của cổng thanh toán: chỉ trả về boolean và danh sách
  // trạng thái hợp lệ, không lộ giá trị cấu hình.
  if (req.method === "GET" && parts.length === 4) {
    sendJson(
      res,
      200,
      {
        surface: "carrier-webhook",
        configured: Boolean(config.carrierWebhookSecret),
        statuses: [...CARRIER_EVENT_STATUSES],
        signatureHeader: "x-carrier-signature",
      },
      headers,
    );
    return true;
  }

  if (req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Webhook vận tải chỉ nhận POST.");
  }

  const provider = String(parts[4] || "").toLowerCase();
  applyCarrierRateLimit(req, res, limiter, provider);

  if (!config.carrierWebhookSecret) {
    throw new HttpError(503, "CARRIER_WEBHOOK_NOT_CONFIGURED", carrierErrorMessage("CARRIER_WEBHOOK_NOT_CONFIGURED"));
  }
  const signature = headerValue(req.headers["x-carrier-signature"]);
  if (!signature) {
    throw new HttpError(401, "CARRIER_SIGNATURE_MISSING", carrierErrorMessage("CARRIER_SIGNATURE_MISSING"));
  }

  const rawBody = await readRawBody(req);
  if (!verifyCarrierSignature(rawBody, signature, config.carrierWebhookSecret)) {
    throw new HttpError(401, "CARRIER_SIGNATURE_INVALID", carrierErrorMessage("CARRIER_SIGNATURE_INVALID"));
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    throw new HttpError(422, "CARRIER_EVENT_REQUIRED", carrierErrorMessage("CARRIER_EVENT_REQUIRED"));
  }

  const result = normalizeCarrierEvent(provider, asJsonObject(payload));
  if (!result.ok) {
    throw new HttpError(422, result.code, result.message);
  }

  sendJson(res, 200, await service.handleEvent(result.event), headers);
  return true;
}

/**
 * Chặn flood từ một nhà vận chuyển (hoặc một IP giả danh nó) trước cả việc kiểm tra chữ ký, vì
 * HMAC trên body lớn là phần đắt nhất của route này.
 */
function applyCarrierRateLimit(req: HttpRequest, res: HttpResponse, limiter: RateLimiter | undefined, provider: string): void {
  if (!limiter) return;
  const rate = limiter.consume(`${provider || "unknown"}:${getRequestIp(req)}`);
  res.setHeader("x-ratelimit-remaining", String(rate.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1000)));
  if (!rate.allowed) {
    throw new HttpError(429, "RATE_LIMITED", "Quá nhiều yêu cầu webhook trong một phút. Gửi lại sau.");
  }
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

/**
 * Đọc nguyên văn body để ký/verify trên đúng byte nhà vận chuyển đã gửi.
 *
 * Không dùng `readJson`: JSON.parse lại rồi stringify sẽ không còn ra đúng chuỗi gốc, và chữ ký
 * HMAC mất nghĩa.
 */
async function readRawBody(req: HttpRequest): Promise<string> {
  const iterator = req[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    const preloaded = req as { rawBody?: unknown; body?: unknown };
    if (typeof preloaded.rawBody === "string") return limit(preloaded.rawBody);
    if (Buffer.isBuffer(preloaded.rawBody)) return limit(preloaded.rawBody.toString("utf8"));
    if (typeof preloaded.body === "string") return limit(preloaded.body);
    if (Buffer.isBuffer(preloaded.body)) return limit(preloaded.body.toString("utf8"));
    if (preloaded.body !== null && typeof preloaded.body === "object") return limit(JSON.stringify(preloaded.body));
    throw new HttpError(422, "CARRIER_EVENT_REQUIRED", carrierErrorMessage("CARRIER_EVENT_REQUIRED"));
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator.call(req) } as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk));
    size += buffer.length;
    if (size > MAX_CARRIER_BODY_BYTES) {
      throw new HttpError(413, "CARRIER_BODY_TOO_LARGE", carrierErrorMessage("CARRIER_BODY_TOO_LARGE"));
    }
    chunks.push(buffer);
  }
  return limit(Buffer.concat(chunks).toString("utf8"));
}

function limit(value: string): string {
  if (Buffer.byteLength(value) > MAX_CARRIER_BODY_BYTES) {
    throw new HttpError(413, "CARRIER_BODY_TOO_LARGE", carrierErrorMessage("CARRIER_BODY_TOO_LARGE"));
  }
  return value;
}
