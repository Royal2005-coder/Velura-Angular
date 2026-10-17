import { HttpError, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import { LoyaltyService } from "./loyalty-service.js";
import { createLoyaltyRepository } from "./loyalty-repository.js";

/** Production service shared by checkout and the account wallet, with no frontend event mutation API. */
export const loyaltyService = new LoyaltyService(createLoyaltyRepository());

/** GET /api/user/loyalty returns only the authenticated member's wallet/history/referral data. */
export async function handleLoyaltyRoute(args: RouteArgs<LoyaltyService>): Promise<boolean> {
  if (args.url.pathname !== "/api/user/loyalty") return false;
  if (args.req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Ví điểm chỉ hỗ trợ đọc thông tin.");
  if (!args.context) throw new HttpError(401, "UNAUTHORIZED", "Vui lòng đăng nhập.");
  const wallet = await args.service.snapshot(args.context, args.url.searchParams.get("before") || undefined);
  sendJson(args.res, 200, { success: true, wallet }, args.headers);
  return true;
}
