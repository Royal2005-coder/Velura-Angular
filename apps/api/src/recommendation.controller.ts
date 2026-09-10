import { HttpError, sendJson } from "./http.js";
import { buildStyleProfileRecommendations } from "./recommendation-service.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "./types.js";

/**
 * GET /api/user/recommendations/style-profile
 * Hybrid RAG recommendation endpoint for the Velura AI suggestions page.
 */
export async function handleRecommendationRoute(
  req: HttpRequest,
  res: HttpResponse,
  _parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ");
  }

  const authHeader = req.headers.authorization || "";
  if (authHeader && /^Bearer\s+(.+)$/i.test(authHeader) && (!context.authUser || !context.profile)) {
    throw new HttpError(401, "UNAUTHORIZED", "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  }

  const payload = await buildStyleProfileRecommendations(context, req);
  return sendJson(res, 200, payload, corsHeaders);
}
