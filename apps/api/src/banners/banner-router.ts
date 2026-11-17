import { HttpError, readJson, sendJson } from "../http.js";
import { requireCmsPermission } from "../content/cms-permission.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";
import type { BannerService } from "./banner-service.js";
import type { CreateBannerInput, UpdateBannerInput } from "./banner-types.js";

export async function handleBannerRoute(args: {
  req: HttpRequest;
  res: HttpResponse;
  url: URL;
  parts: string[];
  context: AuthContext;
  headers: HeaderMap;
  service: BannerService;
}): Promise<boolean> {
  const { req, res, url, parts, context, headers, service } = args;

  // 1. Public route: GET /api/v1/banners OR /api/content/banners
  const isPublicBanner =
    (parts[1] === "v1" && parts[2] === "banners") ||
    (parts[1] === "content" && parts[2] === "banners");

  if (isPublicBanner) {
    if (req.method === "GET") {
      const placement = url.searchParams.get("placement") || undefined;
      const data = await service.listPublicBanners(placement);
      sendJson(res, 200, { success: true, data }, headers);
      return true;
    }
  }

  // 2. Admin routes: /api/v1/admin/banners OR /api/v1/admin/content/banners
  const isAdminDirect = parts[1] === "v1" && parts[2] === "admin" && parts[3] === "banners";
  const isAdminNested = parts[1] === "v1" && parts[2] === "admin" && parts[3] === "content" && parts[4] === "banners";

  if (isAdminDirect || isAdminNested) {
    requireCmsPermission(context, req.method);
    const bannerId = isAdminNested ? (parts[5] || null) : (parts[4] || null);

    if (req.method === "GET") {
      if (bannerId) {
        const data = await service.getBanner(bannerId);
        sendJson(res, 200, { success: true, data }, headers);
      } else {
        const placement = url.searchParams.get("placement") || undefined;
        const data = await service.listAdminBanners(placement);
        sendJson(res, 200, { success: true, data }, headers);
      }
      return true;
    }

    if (req.method === "POST" && !bannerId) {
      const body = (await readJson(req)) as unknown as CreateBannerInput;
      const data = await service.createBanner(body);
      sendJson(res, 201, { success: true, data }, headers);
      return true;
    }

    if (req.method === "PUT" && bannerId) {
      const body = (await readJson(req)) as unknown as UpdateBannerInput;
      const data = await service.updateBanner(bannerId, body);
      sendJson(res, 200, { success: true, data }, headers);
      return true;
    }

    if (req.method === "DELETE" && bannerId) {
      const data = await service.deleteBanner(bannerId);
      sendJson(res, 200, data, headers);
      return true;
    }
  }

  return false;
}
