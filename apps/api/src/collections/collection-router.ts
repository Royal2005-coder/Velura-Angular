import { HttpError, readJson, sendJson } from "../http.js";
import { requireCmsPermission } from "../content/cms-permission.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse } from "../types.js";
import type { CollectionService } from "./collection-service.js";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collection-types.js";

export async function handleCollectionRoute(args: {
  req: HttpRequest;
  res: HttpResponse;
  url: URL;
  parts: string[];
  context: AuthContext;
  headers: HeaderMap;
  service: CollectionService;
}): Promise<boolean> {
  const { req, res, parts, context, headers, service } = args;

  // 1. Public routes: GET /api/v1/collections OR /api/content/collections
  const isPublicCollection =
    (parts[1] === "v1" && parts[2] === "collections") ||
    (parts[1] === "content" && parts[2] === "collections");

  if (isPublicCollection) {
    if (req.method === "GET") {
      const data = await service.listPublicCollections();
      sendJson(res, 200, { success: true, data }, headers);
      return true;
    }
  }

  // 2. Admin routes: /api/v1/admin/collections OR /api/v1/admin/content/collections
  const isAdminDirect = parts[1] === "v1" && parts[2] === "admin" && parts[3] === "collections";
  const isAdminNested = parts[1] === "v1" && parts[2] === "admin" && parts[3] === "content" && parts[4] === "collections";

  if (isAdminDirect || isAdminNested) {
    requireCmsPermission(context, req.method);
    const collectionId = isAdminNested ? (parts[5] || null) : (parts[4] || null);

    if (req.method === "GET") {
      if (collectionId) {
        const data = await service.getCollection(collectionId);
        sendJson(res, 200, { success: true, data }, headers);
      } else {
        const data = await service.listAdminCollections();
        sendJson(res, 200, { success: true, data }, headers);
      }
      return true;
    }

    if (req.method === "POST" && !collectionId) {
      const body = (await readJson(req)) as unknown as CreateCollectionInput;
      const data = await service.createCollection(body);
      sendJson(res, 201, { success: true, data }, headers);
      return true;
    }

    if (req.method === "PUT" && collectionId) {
      const body = (await readJson(req)) as unknown as UpdateCollectionInput;
      const data = await service.updateCollection(collectionId, body);
      sendJson(res, 200, { success: true, data }, headers);
      return true;
    }

    if (req.method === "DELETE" && collectionId) {
      const data = await service.deleteCollection(collectionId);
      sendJson(res, 200, data, headers);
      return true;
    }
  }

  return false;
}
