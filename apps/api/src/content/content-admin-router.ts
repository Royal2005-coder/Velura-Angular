import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { ContentAdminService } from "./content-admin-service.js";

/**
 * Admin CMS HTTP routes under `/api/v1/admin/content/blogs` (KAN-106).
 *
 * Router chỉ đọc HTTP: parse path, parse body, gọi service. Nội dung public vẫn đi qua
 * `GET /api/content/*` cũ — route này thêm quyền xem cả bản nháp và quyền biên tập.
 */
export async function handleContentAdminRoute({
  req,
  res,
  url,
  parts,
  context,
  headers,
  service,
}: RouteArgs<ContentAdminService>): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin" || parts[3] !== "content" || parts[4] !== "blogs") {
    return false;
  }

  if (req.method === "GET" && parts.length === 5) {
    sendJson(res, 200, await service.listBlogs(context, url.searchParams), headers);
    return true;
  }

  if (req.method === "POST" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 201, await service.createBlog(context, body, { ipAddress: getRequestIp(req) }), headers);
    return true;
  }

  if (req.method === "POST" && parts.length === 6 && parts[5] === "ai-suggest") {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.suggestSeo(context, body), headers);
    return true;
  }

  const blogId = parts[5];
  if (req.method === "PATCH" && blogId && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.updateBlog(context, blogId, body, { ipAddress: getRequestIp(req) }), headers);
    return true;
  }

  return false;
}
