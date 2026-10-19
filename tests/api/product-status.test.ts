import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import { createProductRepository, type ProductRepository } from "../../apps/api/src/products/product-repository.js";
import { createProductService } from "../../apps/api/src/products/product-service.js";
import { loadCatalog } from "../../apps/api/src/user/cart-catalog.js";
import { priceOrder } from "../../apps/api/src/user/order-pricing.js";
import { handleProductsRoute, invalidateCatalogCache } from "../../apps/api/src/user/products.js";
import type { AuthContext, HttpRequest, HttpResponse, JsonObject } from "../../apps/api/src/types.js";

const PRODUCT_ID = "62000000-0000-4000-8000-000000000010";
const VARIANT_IDS = ["62000000-0000-4000-8000-000000000020", "62000000-0000-4000-8000-000000000021"];
const context = {
  authUser: { id: "62000000-0000-4000-8000-000000000001" }, profile: { is_active: true },
  isAdmin: true, roleCode: "super_admin", accessToken: "status-admin-token"
} as AuthContext;

async function withCatalogFixture(run: (fixture: {
  product: JsonObject;
}) => Promise<void>): Promise<void> {
  const savedConfig = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(config, { supabaseUrl: "https://status-catalog.test", supabaseServiceRoleKey: "service-test", supabaseAnonKey: "anon-test" });
  const variants = [50, 30].map((stock, index) => ({
    variant_id: VARIANT_IDS[index], product_id: PRODUCT_ID, sku: `VL-STATUS-${index ? "L" : "M"}`,
    color: "Black", color_hex: "#000000", size: index ? "L" : "M", stock_quantity: stock,
    reserved_quantity: index + 1, low_stock_threshold: 5, version: index + 3,
    size_measurements: { bust: 90 + index * 5 }, updated_at: "2026-10-18T00:00:00Z"
  }));
  const product: JsonObject = { product_id: PRODUCT_ID, sku: "VL-STATUS", name: "Status garment", slug: "status-garment",
    status: "on_sale", version: 1, base_price: 500000, sale_price: 450000, images: ["/assets/status.jpg"],
    variants, category: null };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    let result: unknown = [];
    if (url.pathname.endsWith("/rpc/admin_change_product_status")) {
      const payload = JSON.parse(String(init?.body)) as JsonObject;
      product.status = payload.p_new_status;
      product.version = Number(product.version) + 1;
      result = product;
    } else if (url.pathname.endsWith("/product")) {
      const status = url.searchParams.get("status");
      const ids = url.searchParams.get("product_id");
      const matchesId = !ids || ids.includes(PRODUCT_ID);
      const matchesStatus = !status || (status === "eq.on_sale" ? product.status === "on_sale" : ["on_sale", "out_of_stock"].includes(String(product.status)));
      result = matchesId && matchesStatus ? [product] : [];
    } else if (url.pathname.endsWith("/variant")) {
      result = variants.map((variant) => ({ ...variant, product }));
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try { await run({ product }); }
  finally { globalThis.fetch = originalFetch; Object.assign(config, savedConfig); invalidateCatalogCache(); }
}

async function storefront(detail: boolean): Promise<unknown> {
  let body = "";
  const response: HttpResponse = { writeHead() {}, end(chunk) { body += String(chunk || ""); }, setHeader() {} };
  const route = detail ? `/api/user/products/${PRODUCT_ID}` : "/api/user/products";
  await handleProductsRoute({ method: "GET", url: route, headers: {} } as HttpRequest, response, "products", detail ? PRODUCT_ID : undefined, {});
  return JSON.parse(body) as unknown;
}

test("status cycle removes hidden and discontinued products from storefront, then restores active visibility", async () => {
  await withCatalogFixture(async ({ product }) => {
    // Omit startup batch listing: this consumer exercises explicit status transitions only.
    const repository = createProductRepository();
    const service = createProductService({ repository: { findById: repository.findById, changeStatus: repository.changeStatus } as ProductRepository });
    for (const status of ["hidden", "discontinued", "on_sale"]) {
      await service.changeStatus(context, PRODUCT_ID, { status, reason: "Operator visibility change",
        expectedVersion: Number(product.version) }, { ipAddress: "127.0.0.1" });
      if (status === "on_sale") {
        assert.equal((await storefront(false) as JsonObject[]).length, 1);
        assert.equal((await storefront(true) as JsonObject).product_id, PRODUCT_ID);
      } else {
        assert.deepEqual(await storefront(false), []);
        await assert.rejects(() => storefront(true), (error: unknown) => error instanceof HttpError && error.status === 404);
      }
    }
  });
});

test("checkout pricing rejects hidden, discontinued and out-of-stock real variants and product-id fallback", async () => {
  await withCatalogFixture(async ({ product }) => {
    for (const status of ["on_sale", "hidden", "discontinued", "out_of_stock", "on_sale"]) {
      product.status = status;
      const catalog = await loadCatalog([VARIANT_IDS[0], PRODUCT_ID]);
      for (const variantId of [VARIANT_IDS[0], PRODUCT_ID]) {
        const priced = priceOrder([{ variantId, quantity: 1, claimedUnitPrice: 450000 }], catalog, "standard");
        assert.equal(priced.ok, status === "on_sale", `${status}: ${variantId}`);
        if (!priced.ok) assert.equal(priced.code, "UNKNOWN_VARIANT");
      }
    }
  });
});

test("a rejected status RPC never retries via hidden or increments another version", async () => {
  const originalFetch = globalThis.fetch;
  const savedConfig = { ...config };
  const writes: JsonObject[] = [];
  Object.assign(config, { supabaseUrl: "https://status-catalog.test", supabaseServiceRoleKey: "service-test", supabaseAnonKey: "anon-test" });
  globalThis.fetch = async (_input, init) => {
    writes.push(JSON.parse(String(init?.body)) as JsonObject);
    return new Response(JSON.stringify({ code: "PT422", message: "INVALID_STATUS_TRANSITION" }), { status: 422 });
  };
  try {
    await assert.rejects(() => createProductRepository().changeStatus(PRODUCT_ID,
      { status: "on_sale", reason: "Restore visible product", expectedVersion: 3 }, context.accessToken));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].p_new_status, "on_sale");
    assert.equal(writes[0].p_expected_version, 3);
  } finally { globalThis.fetch = originalFetch; Object.assign(config, savedConfig); }
});

test("inventory synchronization does not republish hidden or discontinued products", async () => {
  await withCatalogFixture(async () => {
    for (const status of ["hidden", "discontinued"]) {
      let stock = 50;
      const repository = {
        findById: async () => ({ product_id: PRODUCT_ID, status, version: 1 }),
        listVariants: async () => ({ rows: [{ variant_id: VARIANT_IDS[0], stock_quantity: stock, version: 1, low_stock_threshold: 5 }] }),
        updateStock: async (_id: string, _variantId: string, input: JsonObject) => { stock += Number(input.delta); return { stock_quantity: stock }; },
        changeStatus: async () => assert.fail("Stock synchronization changed operator visibility")
      } as unknown as ProductRepository;
      const service = createProductService({ repository });
      await service.updateStock(context, PRODUCT_ID, { variantId: VARIANT_IDS[0], delta: -50, reason: "Warehouse adjustment to zero", expectedVersion: 1 }, {});
      assert.equal(stock, 0);
      await service.updateStock(context, PRODUCT_ID, { variantId: VARIANT_IDS[0], delta: 30, reason: "Warehouse stock replenishment", expectedVersion: 1 }, {});
      assert.equal(stock, 30);
    }
  });
});
