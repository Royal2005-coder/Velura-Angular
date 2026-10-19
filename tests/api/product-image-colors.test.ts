import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { createProductRepository } from "../../apps/api/src/products/product-repository.js";
import { handleProductsRoute, invalidateCatalogCache } from "../../apps/api/src/user/products.js";
import type { HttpRequest, HttpResponse, JsonObject } from "../../apps/api/src/types.js";

const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";

test("product RPC associations round-trip through admin and full, lite and detail storefront consumers", async () => {
  const originalFetch = globalThis.fetch;
  const savedConfig = { ...config };
  Object.assign(config, { supabaseUrl: "https://image-catalog.test", supabaseServiceRoleKey: "service-test", supabaseAnonKey: "anon-test" });
  let product: JsonObject = {};
  const requests: Array<{ path: string; payload: JsonObject }> = [];
  const images = ["https://images.test/primary.jpg", "https://images.test/second.jpg", "https://images.test/common.jpg"];
  const imageColors = { [images[0]]: "Đỏ", [images[1]]: "Đen" };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const payload = init?.body ? JSON.parse(String(init.body)) as JsonObject : {};
    requests.push({ path: url.pathname, payload });
    let data: unknown = [];
    if (url.pathname.endsWith("/rpc/admin_create_product")) {
      assert.deepEqual(payload.p_image_colors, imageColors);
      assert.equal((payload.p_variants as JsonObject[]).length, 2);
      product = { product_id: PRODUCT_ID, name: "Color garment", slug: "color-garment", images: payload.p_images,
        image_colors: payload.p_image_colors, status: "on_sale", version: 1, variants: [], category: null };
      data = product;
    } else if (url.pathname.endsWith("/rpc/admin_update_product")) {
      if (payload.p_image_colors !== null) product.image_colors = payload.p_image_colors;
      if (payload.p_images !== null) product.images = payload.p_images;
      data = product;
    } else if (url.pathname.endsWith("/product")) {
      const select = url.searchParams.get("select") || "";
      assert.ok(select.includes("image_colors") || select.startsWith("*"), "Every product projection includes the association map");
      data = [product];
    }
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    const repository = createProductRepository();
    const created = await repository.createProduct({ images, imageColors,
      variants: [{ color: "Đỏ", size: "M" }, { color: "Đen", size: "M" }] }, "admin-token");
    assert.deepEqual((created as JsonObject).image_colors, imageColors);
    assert.deepEqual((await repository.findById(PRODUCT_ID, "admin-token"))?.image_colors, imageColors);
    await repository.updateProduct(PRODUCT_ID, { name: "Metadata", expectedVersion: 1 }, "admin-token");
    assert.equal(requests.find((request) => request.path.endsWith("/rpc/admin_update_product"))?.payload.p_image_colors, null);
    for (const route of ["/api/user/products", "/api/user/products?lite=1", `/api/user/products/${PRODUCT_ID}`]) {
      invalidateCatalogCache();
      let status = 0;
      let body = "";
      const response: HttpResponse = {
        writeHead(code) { status = code; }, end(chunk) { body += String(chunk || ""); }, setHeader() {}
      };
      await handleProductsRoute({ method: "GET", url: route, headers: {} } as HttpRequest, response, "products", route.endsWith(PRODUCT_ID) ? PRODUCT_ID : undefined, {});
      assert.equal(status, 200);
      const parsed: unknown = JSON.parse(body);
      const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as JsonObject;
      assert.deepEqual(entry.image_colors, imageColors);
      assert.deepEqual(entry.images, images, "Primary stays at index zero, common image stays unmapped");
    }
    await repository.updateProduct(PRODUCT_ID, { imageColors: {}, expectedVersion: 1 }, "admin-token");
    assert.deepEqual(product.image_colors, {}, "An explicit empty map clears all color associations");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, savedConfig);
    invalidateCatalogCache();
  }
});
