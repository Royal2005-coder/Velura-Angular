import { HttpError, readJson, sendJson } from "../http.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";
import { aiOwner } from "../ai/ai-router.js";
import { readVisualUpload } from "../visual-search/visual-search-router.js";
import { ShopVisualSearchRepository } from "../visual-search/visual-search-repository.js";
import { uuid } from "../visual-search/visual-search-types.js";
import { AiSearchService } from "./ai-search-service.js";
import { validateSearchText } from "./ai-search-text.js";

const service = new AiSearchService(new ShopVisualSearchRepository());
/** Register before generic /api/user routing; text and composed search share one bounded lifecycle. */
export async function handleAiSearchRoute(req: HttpRequest, res: HttpResponse, parts: string[], headers: HeaderMap, context: AuthContext): Promise<boolean> {
  if (!(parts[1] === "user" && parts[2] === "ai-search")) return false;
  const owner = aiOwner(req, context);
  const memberUserId = context.authUser ? context.profile?.user_id : undefined;
  if (context.authUser && !memberUserId) throw new HttpError(403, "MEMBER_PROFILE_REQUIRED", "Hồ sơ thành viên chưa sẵn sàng.");
  if (parts[3] === "requests" && parts[4] && req.method === "DELETE") {
    if (!uuid(parts[4])) throw new HttpError(400, "AI_SEARCH_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
    service.cancel(owner, parts[4]); sendJson(res, 200, { cancelled: true }, headers); return true;
  }
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Chỉ hỗ trợ POST.");
  if (parts[3] === "text" && parts.length === 4) {
    service.consume(owner);
    const body = await readJson(req, 16_384);
    const requestId = String(body.request_id || "");
    if (!uuid(requestId)) throw new HttpError(400, "AI_SEARCH_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
    const query = validateSearchText(body.query, "query");
    sendJson(res, 200, await service.textSearch(owner, requestId, query, body.filters, memberUserId), { ...headers, "cache-control": "no-store" });
    return true;
  }
  if (parts[3] === "composed" && parts.length === 4) {
    service.consume(owner);
    const upload = await readVisualUpload(req);
    try {
      if (upload.metadata.consent !== true || upload.metadata.confirmed !== true) throw new HttpError(400, "CONSENT_REQUIRED", "Xác nhận vùng ảnh và đồng ý xử lý trước khi tìm.");
      if (!uuid(String(upload.metadata.request_id || ""))) throw new HttpError(400, "AI_SEARCH_REQUEST_INVALID", "Yêu cầu không hợp lệ.");
      const modifier = validateSearchText(upload.metadata.modifier, "modifier");
      sendJson(res, 200, await service.composedSearch(owner, String(upload.metadata.request_id), upload.bytes, upload.mime, modifier, upload.metadata.filters, memberUserId), { ...headers, "cache-control": "no-store" });
    } finally { upload.release(); }
    return true;
  }
  return false;
}