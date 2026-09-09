import test from "node:test";
import assert from "node:assert/strict";
import { handleProductRoute } from "../../apps/api/src/products/product-router.js";

const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";

function mockReq(method, url, body) {
  const chunks = body ? [JSON.stringify(body)] : [];
  return {
    method,
    url,
    headers: { "x-forwarded-for": "127.0.0.1" },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    }
  };
}

function mockRes() {
  let _status, _headers, _body;
  return {
    get sent() { return { status: _status, body: _body }; },
    writeHead: (status, headers) => { _status = status; _headers = headers; },
    end: (body) => { _body = body; }
  };
}

const ctx = {
  authUser: { id: "auth-1" },
  profile: { user_id: "actor-1", is_active: true },
  isAdmin: true,
  roleCode: "super_admin",
  accessToken: "valid-token"
};

test("returns false for non-product v1 paths", async () => {
  const result = await handleProductRoute({
    req: mockReq("GET", "/api/v1/admin/orders"),
    res: mockRes(),
    url: new URL("http://localhost/api/v1/admin/orders"),
    parts: ["api", "v1", "admin", "orders"],
    context: ctx,
    headers: {},
    service: {}
  });
  assert.equal(result, false);
});

test("returns false for account v1 paths", async () => {
  const result = await handleProductRoute({
    req: mockReq("GET", "/api/v1/admin/accounts"),
    res: mockRes(),
    url: new URL("http://localhost/api/v1/admin/accounts"),
    parts: ["api", "v1", "admin", "accounts"],
    context: ctx,
    headers: {},
    service: {}
  });
  assert.equal(result, false);
});

test("GET /products list returns 200", async () => {
  let receivedParams;
  const service = {
    list: async (_ctx, params) => { receivedParams = params; return { rows: [], count: 0 }; }
  };
  const res = mockRes();
  const url = new URL("http://localhost/api/v1/admin/products?status=on_sale");
  const result = await handleProductRoute({
    req: mockReq("GET", url.pathname),
    res,
    url,
    parts: ["api", "v1", "admin", "products"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(receivedParams.get("status"), "on_sale");
});

test("GET /products/:id returns detail", async () => {
  let receivedId;
  const service = {
    get: async (_ctx, id) => { receivedId = id; return { product_id: id, name: "Test" }; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("GET", `/api/v1/admin/products/${PRODUCT_ID}`),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(receivedId, PRODUCT_ID);
});

test("POST /products create returns 201", async () => {
  let receivedBody;
  const service = {
    create: async (_ctx, body) => { receivedBody = body; return { product_id: PRODUCT_ID }; }
  };
  const res = mockRes();
  const body = { sku: "VL-AO001", name: "Test", categoryId: "cat-1", basePrice: 100, expectedVersion: 0 };
  const result = await handleProductRoute({
    req: mockReq("POST", "/api/v1/admin/products", body),
    res,
    url: new URL("http://localhost/api/v1/admin/products"),
    parts: ["api", "v1", "admin", "products"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 201);
  assert.ok(receivedBody);
});

test("PATCH /products/:id returns 200", async () => {
  let receivedId;
  const service = {
    update: async (_ctx, id) => { receivedId = id; return { product_id: id }; }
  };
  const res = mockRes();
  const body = { name: "Updated", expectedVersion: 2 };
  const result = await handleProductRoute({
    req: mockReq("PATCH", `/api/v1/admin/products/${PRODUCT_ID}`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(receivedId, PRODUCT_ID);
});

test("GET /products/categories returns category list", async () => {
  let called = false;
  const service = {
    categories: async () => { called = true; return [{ category_id: "cat-1" }]; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("GET", "/api/v1/admin/products/categories"),
    res,
    url: new URL("http://localhost/api/v1/admin/products/categories"),
    parts: ["api", "v1", "admin", "products", "categories"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test("GET /products/low-stock returns stock warnings", async () => {
  let called = false;
  const service = {
    lowStock: async () => { called = true; return []; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("GET", "/api/v1/admin/products/low-stock"),
    res,
    url: new URL("http://localhost/api/v1/admin/products/low-stock"),
    parts: ["api", "v1", "admin", "products", "low-stock"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test("POST /products/:id/change-status delegates to service", async () => {
  let receivedArgs;
  const service = {
    changeStatus: async (_ctx, id, body) => { receivedArgs = { id, body }; return { product_id: id }; }
  };
  const res = mockRes();
  const body = { status: "hidden", expectedVersion: 1 };
  const result = await handleProductRoute({
    req: mockReq("POST", `/api/v1/admin/products/${PRODUCT_ID}/change-status`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/change-status`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "change-status"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(receivedArgs.id, PRODUCT_ID);
  assert.equal(receivedArgs.body.status, "hidden");
});

test("POST /products/:id/update-stock delegates to service", async () => {
  let receivedArgs;
  const service = {
    updateStock: async (_ctx, id, body) => { receivedArgs = { id, body }; return { variant_id: "v-1" }; }
  };
  const res = mockRes();
  const body = { variantId: "variant-1", delta: -5, expectedVersion: 3 };
  const result = await handleProductRoute({
    req: mockReq("POST", `/api/v1/admin/products/${PRODUCT_ID}/update-stock`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/update-stock`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "update-stock"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(receivedArgs.id, PRODUCT_ID);
});

test("POST /products/:id/variants creates a stock variant", async () => {
  let receivedArgs;
  const service = {
    createVariant: async (_ctx, id, body) => { receivedArgs = { id, body }; return { variant_id: "variant-1" }; }
  };
  const res = mockRes();
  const body = { color: "Den", size: "M", stockQuantity: 10 };
  const result = await handleProductRoute({
    req: mockReq("POST", `/api/v1/admin/products/${PRODUCT_ID}/variants`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/variants`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "variants"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 201);
  assert.equal(receivedArgs.id, PRODUCT_ID);
  assert.equal(receivedArgs.body.stockQuantity, 10);
});

test("GET /products/:id/audit-logs returns logs", async () => {
  let called = false;
  const service = {
    listAuditLogs: async () => { called = true; return { rows: [], count: 0 }; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("GET", `/api/v1/admin/products/${PRODUCT_ID}/audit-logs`),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/audit-logs`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "audit-logs"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(called, true);
});

test("POST /products/import-csv uses the collection route", async () => {
  const req = mockReq("POST", "/api/v1/admin/products/import-csv", { csv: "sku,name" });
  const res = mockRes();
  let csv;
  const handled = await handleProductRoute({
    req, res,
    url: new URL("http://localhost/api/v1/admin/products/import-csv"),
    parts: ["api", "v1", "admin", "products", "import-csv"],
    context: ctx, headers: {},
    service: { parseCsv: async (_context, value) => { csv = value; return { validRows: 0 }; } }
  });
  assert.equal(handled, true);
  assert.equal(res.sent.status, 200);
  assert.equal(csv, "sku,name");
});

test("GET /products/:id/combo-items calls service", async () => {
  let calledId;
  const service = {
    getComboItems: async (_ctx, id) => { calledId = id; return []; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("GET", `/api/v1/admin/products/${PRODUCT_ID}/combo-items`),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/combo-items`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "combo-items"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(calledId, PRODUCT_ID);
});

test("POST /products/:id/combo-items calls service", async () => {
  let calledId, calledBody;
  const service = {
    addComboItem: async (_ctx, id, body) => { calledId = id; calledBody = body; return { combo_item_id: "ci-1" }; }
  };
  const res = mockRes();
  const body = { componentProductId: "comp-1", componentVariantId: null, quantity: 2 };
  const result = await handleProductRoute({
    req: mockReq("POST", `/api/v1/admin/products/${PRODUCT_ID}/combo-items`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/combo-items`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "combo-items"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 201);
  assert.equal(calledId, PRODUCT_ID);
  assert.equal(calledBody.componentProductId, "comp-1");
  assert.equal(calledBody.quantity, 2);
});

test("PATCH /products/:id/combo-items/:itemId calls service", async () => {
  let calledId, calledItemId, calledBody;
  const service = {
    updateComboItem: async (_ctx, id, itemId, body) => { calledId = id; calledItemId = itemId; calledBody = body; return { combo_item_id: itemId }; }
  };
  const res = mockRes();
  const body = { quantity: 5 };
  const result = await handleProductRoute({
    req: mockReq("PATCH", `/api/v1/admin/products/${PRODUCT_ID}/combo-items/ci-1`, body),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/combo-items/ci-1`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "combo-items", "ci-1"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(calledId, PRODUCT_ID);
  assert.equal(calledItemId, "ci-1");
  assert.equal(calledBody.quantity, 5);
});

test("DELETE /products/:id/combo-items/:itemId calls service", async () => {
  let calledId, calledItemId;
  const service = {
    removeComboItem: async (_ctx, id, itemId) => { calledId = id; calledItemId = itemId; return { success: true }; }
  };
  const res = mockRes();
  const result = await handleProductRoute({
    req: mockReq("DELETE", `/api/v1/admin/products/${PRODUCT_ID}/combo-items/ci-1`),
    res,
    url: new URL(`http://localhost/api/v1/admin/products/${PRODUCT_ID}/combo-items/ci-1`),
    parts: ["api", "v1", "admin", "products", PRODUCT_ID, "combo-items", "ci-1"],
    context: ctx,
    headers: {},
    service
  });
  assert.equal(result, true);
  assert.equal(res.sent.status, 200);
  assert.equal(calledId, PRODUCT_ID);
  assert.equal(calledItemId, "ci-1");
});
