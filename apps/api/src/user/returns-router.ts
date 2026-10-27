import { HttpError, readJson, sendJson } from "../http.js";
import { requireUserAuth } from "./auth.js";
import { createUserReturnsRepository } from "./returns-repository.js";
import { createUserReturnsService } from "./returns-service.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";

const returnsService = createUserReturnsService(createUserReturnsRepository());

/**
 * Authenticated return/exchange create, list, and customer cancel. Parses HTTP only — every
 * rule lives in `returns-service.ts`.
 */
export async function handleReturnsRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const guestToken = (url.searchParams.get("guest_access_token") || url.searchParams.get("order_access_token")
    || String(req.headers["x-guest-access-token"] || "")).trim();

  // POST /api/user/returns/guest — khách vãng lai, không cần đăng nhập
  if (req.method === "POST" && action === "guest" && !parts[4]) {
    const body = await readJson(req);
    const created = await returnsService.createForGuest(body);
    return sendJson(res, 201, { success: true, return: created }, corsHeaders);
  }

  // GET /api/user/returns/guest/:id — one request with shipment, evidence and timeline
  if (action === "guest" && req.method === "GET" && parts[4]) {
    const detail = await returnsService.detailForGuest(parts[4], guestToken);
    return sendJson(res, 200, { success: true, return: detail }, corsHeaders);
  }

  // POST /api/user/returns/guest/:id/evidence — packing video/photo for a verified guest
  if (action === "guest" && req.method === "POST" && parts[4] && parts[5] === "evidence") {
    const evidence = await returnsService.addPackingEvidenceForGuest(
      parts[4],
      url.searchParams.get("kind") || "",
      url.searchParams.get("note") || "",
      guestToken,
      req
    );
    return sendJson(res, 200, evidence, corsHeaders);
  }

  if (action === "guest" && req.method === "GET") {
    const returns = await returnsService.listForGuest({order_id:url.searchParams.get("order_id"),guest_access_token: url.searchParams.get("guest_access_token") || url.searchParams.get("order_access_token")});
    return sendJson(res,200,{success:true,returns},corsHeaders);
  }
  if (action === "guest-cancel" && req.method === "POST") {
    const updated = await returnsService.cancelForGuest(await readJson(req));
    return sendJson(res,200,{success:true,return:updated},corsHeaders);
  }
  // POST /api/user/returns/guest-refund-receiver — same for a verified guest session
  if (action === "guest-refund-receiver" && req.method === "POST") {
    return sendJson(res, 200, await returnsService.saveRefundReceiverForGuest(await readJson(req)), corsHeaders);
  }
  const profile = requireUserAuth(context);

  // GET /api/user/returns/:id — full customer tracking detail
  if (req.method === "GET" && action && !parts[4]) {
    const detail = await returnsService.detailForMember(profile, action);
    return sendJson(res, 200, { success: true, return: detail }, corsHeaders);
  }

  // POST /api/user/returns/:id/evidence?kind=packing_video
  if (req.method === "POST" && action && parts[4] === "evidence") {
    const evidence = await returnsService.addPackingEvidenceForMember(
      profile,
      action,
      url.searchParams.get("kind") || "",
      url.searchParams.get("note") || "",
      req
    );
    return sendJson(res, 200, evidence, corsHeaders);
  }

  // POST /api/user/returns/cancel
  if (req.method === "POST" && action === "cancel") {
    const body = await readJson(req);
    const updated = await returnsService.cancelForMember(profile, body.return_id, body.expectedVersion);
    return sendJson(res, 200, { success: true, return: updated }, corsHeaders);
  }

  // POST /api/user/returns/refund-receiver — COD receiving account for the member's own refund request
  if (req.method === "POST" && action === "refund-receiver") {
    return sendJson(res, 200, await returnsService.saveRefundReceiverForMember(profile, await readJson(req)), corsHeaders);
  }

  // POST /api/user/returns
  if (req.method === "POST" && !action) {
    const body = await readJson(req);
    const created = await returnsService.createForMember(profile, body);
    return sendJson(res, 200, { success: true, return: created }, corsHeaders);
  }

  // GET /api/user/returns?order_id=...
  if (req.method === "GET") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const orderId = url.searchParams.get("order_id");
    const returns = await returnsService.listForMember(profile, orderId);
    return sendJson(res, 200, { success: true, returns }, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Route returns not found");
}
