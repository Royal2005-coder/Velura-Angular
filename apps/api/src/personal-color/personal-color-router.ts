import { HttpError, readJson, sendJson } from "../http.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";
import { PersonalColorService } from "./personal-color-service.js";
import type { ColorPrincipal } from "./personal-color-types.js";

/** Verified auth identity or the existing guest-session header owns all color operations. */
export function colorPrincipal(req: HttpRequest, context: AuthContext): ColorPrincipal {
  const userId = context.profile?.user_id || context.authUser?.id;
  if (context.authUser && context.profile?.is_active !== false && userId) {
    return { owner: `member:${context.authUser.id}`, userId, context };
  }
  if (req.headers.authorization || context.authUser) throw new HttpError(401, "AUTH_REQUIRED", "Phiên đăng nhập không hợp lệ.");
  const guest = req.headers["x-guest-session-id"];
  if (typeof guest !== "string" || !/^gs_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(guest)) throw new HttpError(401, "GUEST_SESSION_REQUIRED", "Hãy mở lại phiên trình duyệt.");
  return { owner: `guest:${guest}`, guestId: guest };
}

/** Handles /api/user/personal-color; call before generic user dispatch, returning false for other routes. */
export async function handlePersonalColorRoute(req: HttpRequest, res: HttpResponse, parts: string[], headers: HeaderMap, context: AuthContext, service: PersonalColorService): Promise<boolean> {
  if (parts[1] !== "user" || parts[2] !== "personal-color") return false;
  const responseHeaders = { ...headers, "cache-control": "private, no-store" };
  if (parts[3] === "capabilities" && parts.length === 4 && req.method === "GET") {
    sendJson(res, 200, service.capabilities(), responseHeaders);
    return true;
  }
  const principal = colorPrincipal(req, context);
  if (parts[3] === "profile" && parts.length === 4 && req.method === "GET") {
    sendJson(res, 200, await service.profile(principal), responseHeaders);
  } else if (parts[3] === "analyses" && parts.length === 4 && req.method === "POST") {
    sendJson(res, 202, await service.analyze(principal, await readJson(req)), responseHeaders);
  } else if (parts[3] === "analyses" && parts.length >= 5 && /^[a-f0-9-]{36}$/i.test(parts[4])) {
    if (parts.length === 5 && req.method === "GET") sendJson(res, 200, await service.get(principal, parts[4]), responseHeaders);
    else if (parts.length === 6 && req.method === "POST" && parts[5] === "cancel") sendJson(res, 200, await service.cancel(principal, parts[4]), responseHeaders);
    else if (parts.length === 6 && req.method === "POST" && parts[5] === "confirm") sendJson(res, 200, await service.confirm(principal, parts[4], (await readJson(req)).expected_version), responseHeaders);
    else throw new HttpError(404, "NOT_FOUND", "Không tìm thấy thao tác phân tích màu.");
  } else throw new HttpError(404, "NOT_FOUND", "Không tìm thấy thao tác phân tích màu.");
  return true;
}
