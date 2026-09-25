import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { OrderService } from "./order-service.js";

/**
 * Admin order HTTP routes under `/api/v1/admin/orders`.
 *
 * Đổi trạng thái chỉ đi qua `POST /:id/actions/:action` theo bảng action KAN-60. Không
 * còn tuyến "đổi sang trạng thái X" hay tuyến huỷ riêng.
 */
export async function handleOrderRoute({ req, res, url, parts, context, headers, service }: RouteArgs<OrderService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "orders") return false;
  const requestMeta = { ipAddress: getRequestIp(req) };

  if (req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.list(context, url.searchParams), headers);
    return true;
  }

  if (req.method === "GET" && parts[4] === "summary" && parts.length === 5) {
    sendJson(res, 200, await service.summary(context), headers);
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

  if (req.method === "POST" && parts[5] === "actions" && parts[6] && parts.length === 7) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.performAction(context, orderId, parts[6], body, requestMeta), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "simulate-carrier" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.simulateCarrier(context, orderId, body), headers);
    return true;
  }

  if (req.method === "POST" && parts[5] === "payments" && parts[7] === "resolve" && parts.length === 8) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.resolvePayment(context, orderId, parts[6], body, requestMeta), headers);
    return true;
  }

  return false;
}
