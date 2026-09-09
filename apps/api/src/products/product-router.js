import { config } from "../config.js";
import { getRequestIp, readJson, sendJson } from "../http.js";

export async function handleProductRoute({ req, res, url, parts, context, headers, service }) {
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "admin") return false;

  const requestMeta = { ipAddress: getRequestIp(req) };

  if (parts[3] !== "products") return false;

  // GET /api/v1/admin/products - list products
  if (req.method === "GET" && parts.length === 4) {
    sendJson(res, 200, await service.list(context, url.searchParams), headers);
    return true;
  }

  // POST /api/v1/admin/products - create product (must check before :id routes)
  if (req.method === "POST" && parts.length === 4) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 201, await service.create(context, body, requestMeta), headers);
    return true;
  }

  // GET /api/v1/admin/products/categories
  if (req.method === "GET" && parts[4] === "categories" && parts.length === 5) {
    sendJson(res, 200, { data: await service.categories(context) }, headers);
    return true;
  }

  // GET /api/v1/admin/products/low-stock
  if (req.method === "GET" && parts[4] === "low-stock" && parts.length === 5) {
    sendJson(res, 200, { data: await service.lowStock(context) }, headers);
    return true;
  }

  if (req.method === "GET" && parts[4] === "audit-logs" && parts.length === 5) {
    sendJson(res, 200, await service.listAuditLogs(context, url.searchParams), headers);
    return true;
  }

  // POST /api/v1/admin/products/import-csv - validate and preview a CSV file.
  if (req.method === "POST" && parts[4] === "import-csv" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    const result = await service.parseCsv(context, body.csv || "");
    sendJson(res, 200, result, headers);
    return true;
  }

  // POST /api/v1/admin/products/import-csv/commit - commit CSV import
  if (req.method === "POST" && parts[4] === "import-csv" && parts[5] === "commit" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    const result = await service.commitCsv(context, body.csv || "", requestMeta);
    sendJson(res, 200, result, headers);
    return true;
  }

  // All routes below require a productId
  const productId = parts[4];
  if (!productId) return false;

  // GET /api/v1/admin/products/:id - get product detail
  if (req.method === "GET" && parts.length === 5) {
    sendJson(res, 200, await service.get(context, productId), headers);
    return true;
  }

  // PATCH /api/v1/admin/products/:id - update product
  if (req.method === "PATCH" && parts.length === 5) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.update(context, productId, body, requestMeta), headers);
    return true;
  }

  // GET /api/v1/admin/products/:id/variants
  if (req.method === "GET" && parts[5] === "variants" && parts.length === 6) {
    sendJson(res, 200, { data: await service.getVariants(context, productId) }, headers);
    return true;
  }

  // GET /api/v1/admin/products/:id/combo-items
  if (req.method === "GET" && parts[5] === "combo-items" && parts.length === 6) {
    sendJson(res, 200, { data: await service.getComboItems(context, productId) }, headers);
    return true;
  }

  // POST /api/v1/admin/products/:id/combo-items - add item to combo
  if (req.method === "POST" && parts[5] === "combo-items" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 201, await service.addComboItem(context, productId, body, requestMeta), headers);
    return true;
  }

  // PATCH /api/v1/admin/products/:id/combo-items/:itemId - update combo item quantity
  if (req.method === "PATCH" && parts[5] === "combo-items" && parts.length === 7) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.updateComboItem(context, productId, parts[6], body, requestMeta), headers);
    return true;
  }

  // DELETE /api/v1/admin/products/:id/combo-items/:itemId - remove item from combo
  if (req.method === "DELETE" && parts[5] === "combo-items" && parts.length === 7) {
    sendJson(res, 200, await service.removeComboItem(context, productId, parts[6]), headers);
    return true;
  }

  // POST /api/v1/admin/products/:id/variants
  if (req.method === "POST" && parts[5] === "variants" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 201, await service.createVariant(context, productId, body, requestMeta), headers);
    return true;
  }

  // GET /api/v1/admin/products/:id/audit-logs
  if (req.method === "GET" && parts[5] === "audit-logs" && parts.length === 6) {
    const filters = new URLSearchParams(url.searchParams);
    filters.set("targetId", productId);
    sendJson(res, 200, await service.listAuditLogs(context, filters), headers);
    return true;
  }

  // POST /api/v1/admin/products/:id/change-status
  if (req.method === "POST" && parts[5] === "change-status" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.changeStatus(context, productId, body, requestMeta), headers);
    return true;
  }

  // POST /api/v1/admin/products/:id/update-stock
  if (req.method === "POST" && parts[5] === "update-stock" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.updateStock(context, productId, body, requestMeta), headers);
    return true;
  }

  // POST /api/v1/admin/products/:id/bulk-stock
  if (req.method === "POST" && parts[5] === "bulk-stock" && parts.length === 6) {
    const body = await readJson(req, config.maxBodyBytes);
    sendJson(res, 200, await service.bulkUpdateStock(context, productId, body, requestMeta), headers);
    return true;
  }

  return false;
}
