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
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  // POST /api/user/returns/guest — khách vãng lai, không cần đăng nhập
  if (req.method === "POST" && action === "guest") {
    const body = await readJson(req);
    const created = await returnsService.createForGuest(body);
    return sendJson(res, 201, { success: true, return: created }, corsHeaders);
  }

  if (action === "guest" && req.method === "GET") {
    const url = new URL(req.url || "/", "http://localhost");
    const returns = await returnsService.listForGuest({order_id:url.searchParams.get("order_id"),guest_access_token:url.searchParams.get("guest_access_token") || url.searchParams.get("order_access_token")});
    return sendJson(res,200,{success:true,returns},corsHeaders);
  }
  if (action === "guest-cancel" && req.method === "POST") {
    const updated = await returnsService.cancelForGuest(await readJson(req));
    return sendJson(res,200,{success:true,return:updated},corsHeaders);
  }
  const profile = requireUserAuth(context);

  // POST /api/user/returns/cancel
  if (req.method === "POST" && action === "cancel") {
    const body = await readJson(req);
    const updated = await returnsService.cancelForMember(profile, body.return_id, body.expectedVersion);
    return sendJson(res, 200, { success: true, return: updated }, corsHeaders);
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
