import { config } from "../config.js";
import { readJson, sendJson } from "../http.js";
import type { RouteArgs } from "../types.js";
import type { CatalogContentService } from "./catalog-content-service.js";

/** Product-admin scoped description/SEO generation and review routes; no mutation is inferred from generation. */
export async function handleCatalogContentRoute({ req, res, parts, context, headers, service }: RouteArgs<CatalogContentService>): Promise<boolean> {
  if (parts.slice(0, 4).join("/") !== "api/v1/admin/catalog-content") return false;
  const section = parts[4], id = parts[5];
  let result: unknown;
  if (section === "batches" && parts.length === 5 && req.method === "POST") {
    result = await service.enqueue(context, await readJson(req, config.maxBodyBytes));
    sendJson(res, 202, result, headers);
    return true;
  }
  if (section === "batches" && id && parts.length === 6 && req.method === "GET") result = await service.batch(context, id);
  else if (section === "products" && id && parts.length === 7 && parts[6] === "drafts" && req.method === "GET") result = await service.drafts(context, id);
  else if (section === "products" && id && parts.length === 7 && parts[6] === "facts" && req.method === "PUT") result = await service.facts(context, id, await readJson(req, config.maxBodyBytes));
  else if (section === "drafts" && id && parts.length === 6 && req.method === "GET") result = await service.draft(context, id);
  else if (section === "drafts" && id && parts.length === 7 && parts[6] === "review" && req.method === "POST") result = await service.review(context, id, await readJson(req, config.maxBodyBytes));
  else if (section === "drafts" && id && parts.length === 7 && parts[6] === "publish" && req.method === "POST") result = await service.publish(context, id, await readJson(req, config.maxBodyBytes));
  else return false;
  sendJson(res, 200, result, headers);
  return true;
}
