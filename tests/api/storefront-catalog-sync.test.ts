import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError, sendError } from "../../apps/api/src/http.js";
import { cartUnavailableReason } from "../../apps/api/src/user/cart-catalog.js";
import { filterCatalogProducts, parseCatalogFilters, textMatchesAllWords } from "../../apps/api/src/user/catalog-search.js";
import { handleProductsRoute, invalidateCatalogCache } from "../../apps/api/src/user/products.js";
import type { HttpRequest, HttpResponse, JsonObject } from "../../apps/api/src/types.js";

const PRODUCT_ID = "71000000-0000-4000-8000-000000000001";
const OTHER_ID = "71000000-0000-4000-8000-000000000002";

interface Captured {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function productRow(id: string, name: string, extra: JsonObject = {}): JsonObject {
  return {
    product_id: id, sku: `VL-${id.slice(-2)}`, name, slug: name.toLowerCase().replace(/\W+/g, "-"), status: "on_sale",
    base_price: 400000, sale_price: null, images: ["/assets/a.jpg"], image_colors: {}, version: 1,
    description: "Mô tả sản phẩm\nChất liệu: Cotton", style_tags: [], occasions: [], is_combo: false,
    category: { category_id: "c1", name: "Áo thun", slug: "ao-thun" },
    variants: [{ variant_id: `${id}-v1`, color: "Đen", color_hex: "#000000", size: "M", stock_quantity: 5, reserved_quantity: 0 }],
    ...extra
  };
}

/** Fake PostgREST: honors the `status=in.(…)`/`eq.` filter exactly like the database would. */
async function withCatalog(
  products: JsonObject[],
  run: (calls: { productKeys: string[] }) => Promise<void>
): Promise<void> {
  const savedConfig = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(config, { supabaseUrl: "https://storefront-sync.test", supabaseServiceRoleKey: "service-key", supabaseAnonKey: "anon-key" });
  const calls = { productKeys: [] as string[] };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    let rows: unknown[] = [];
    if (url.pathname.endsWith("/product")) {
      calls.productKeys.push(new Headers(init?.headers).get("apikey") ?? "");
      const status = url.searchParams.get("status") || "";
      const allowed = status.startsWith("in.(") ? status.slice(4, -1).split(",") : status.startsWith("eq.") ? [status.slice(3)] : null;
      const id = url.searchParams.get("product_id");
      rows = products.filter((row) =>
        (!allowed || allowed.includes(String(row.status))) && (!id || id === `eq.${row.product_id}`));
    } else if (url.pathname.endsWith("/variant")) {
      const id = url.searchParams.get("product_id");
      rows = products.filter((row) => id === `eq.${row.product_id}`).flatMap((row) => row.variants as JsonObject[]);
    } else if (url.pathname.endsWith("/category")) {
      rows = [{ category_id: "c1", name: "Áo thun", slug: "ao-thun" }];
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-range": `0-${rows.length}/${rows.length}` } });
  };
  invalidateCatalogCache();
  try { await run(calls); }
  finally { globalThis.fetch = originalFetch; Object.assign(config, savedConfig); invalidateCatalogCache(); }
}

async function get(route: string, action?: string): Promise<Captured & { json: unknown }> {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const response: HttpResponse = {
    writeHead(status, headers) { captured.status = status; captured.headers = (headers || {}) as Record<string, unknown>; },
    end(chunk) { captured.body += String(chunk || ""); },
    setHeader() {}
  };
  const sub = route.includes("/categories") ? "categories" : "products";
  await handleProductsRoute({ method: "GET", url: route, headers: {} } as HttpRequest, response, sub, action, {});
  return { ...captured, json: JSON.parse(captured.body) as unknown };
}

const names = (json: unknown): string[] => (json as JsonObject[]).map((row) => String(row.name));

test("renamed product is found by its new name at once and no longer by the old name (UAT 3.1.10-25)", async () => {
  const target = productRow(PRODUCT_ID, "Áo thun basic");
  await withCatalog([target, productRow(OTHER_ID, "Quần jeans")], async () => {
    assert.deepEqual(names((await get("/api/user/products?q=Áo%20thun%20basic")).json), ["Áo thun basic"]);

    // Admin renames; server.ts / product-service call invalidateCatalogCache() after the write.
    target.name = "Premium Cotton 100%";
    invalidateCatalogCache();

    assert.deepEqual(names((await get(`/api/user/products?q=${encodeURIComponent("Premium Cotton 100%")}`)).json), ["Premium Cotton 100%"]);
    // The old name shares the category word "áo thun" but not "basic": it must not match anymore.
    assert.deepEqual((await get("/api/user/products?q=Áo%20thun%20basic")).json, []);
    // Same for the lite list used by search suggestions.
    assert.deepEqual(names((await get(`/api/user/products?lite=1&q=${encodeURIComponent("premium cotton 100")}`)).json), ["Premium Cotton 100%"]);
  });
});

test("category and material filters find the renamed product, accent-insensitively", async () => {
  const target = productRow(PRODUCT_ID, "Premium Cotton 100%");
  await withCatalog([target, productRow(OTHER_ID, "Quần lanh", {
    description: "Chất liệu: Lanh", category: { category_id: "c2", name: "Quần", slug: "quan" }
  })], async () => {
    assert.deepEqual(names((await get("/api/user/products?category=ao-thun")).json), ["Premium Cotton 100%"]);
    assert.deepEqual(names((await get("/api/user/products?category=Áo%20thun")).json), ["Premium Cotton 100%"]);
    assert.deepEqual(names((await get("/api/user/products?material=cotton")).json), ["Premium Cotton 100%"]);
    assert.deepEqual(names((await get("/api/user/products?material=L%C3%A1nh")).json), ["Quần lanh"]);
    assert.deepEqual(names((await get("/api/user/products?material=cotton&category=quan")).json), []);
    // Material text in the description is searchable too.
    assert.deepEqual(names((await get("/api/user/products?q=ch%E1%BA%A5t%20li%E1%BB%87u%20cotton")).json), ["Premium Cotton 100%"]);
  });
});

test("special characters in the query never act as wildcards or break the request", async () => {
  await withCatalog([productRow(PRODUCT_ID, "Premium Cotton 100%"), productRow(OTHER_ID, "Quần jeans")], async () => {
    for (const q of ["%", "*", "%%", "100%", "a,b)", "(name.ilike.*)", "\\", "_"]) {
      const response = await get(`/api/user/products?q=${encodeURIComponent(q)}`);
      assert.equal(response.status, 200, q);
      // A lone wildcard matches nothing unless the text really contains it.
      if (q === "%" || q === "100%") assert.deepEqual(names(response.json), ["Premium Cotton 100%"], q);
      else assert.deepEqual(response.json, [], q);
    }
  });
  assert.equal(textMatchesAllWords("Quần jeans", "*"), false);
  assert.equal(textMatchesAllWords("Đầm Lụa", "dam lua"), true);
  assert.equal(parseCatalogFilters(new URLSearchParams({ q: "x".repeat(500) })).query.length, 200);
});

test("filtering never mutates the shared cache rows", () => {
  const rows = [productRow(PRODUCT_ID, "Premium Cotton 100%"), productRow(OTHER_ID, "Quần jeans")];
  assert.equal(filterCatalogProducts(rows, { query: "jeans", category: "", material: "" }).length, 1);
  assert.equal(rows.length, 2);
});

test("a stock or variant change that invalidates mid-request never re-fills the cache with the old rows", async () => {
  const target = productRow(PRODUCT_ID, "Áo thun basic");
  const savedConfig = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(config, { supabaseUrl: "https://storefront-sync.test", supabaseServiceRoleKey: "service-key", supabaseAnonKey: "anon-key" });
  const gate = Promise.withResolvers<void>();
  const productReadStarted = Promise.withResolvers<void>();
  let first = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/product")) return new Response("[]", { status: 200 });
    const snapshot = JSON.stringify([target]);
    if (first) {
      first = false;
      productReadStarted.resolve();
      await gate.promise;
    }
    return new Response(snapshot, { status: 200 });
  };
  invalidateCatalogCache();
  try {
    const slowRead = get("/api/user/products");
    await productReadStarted.promise;
    target.name = "Premium Cotton 100%";
    invalidateCatalogCache();
    gate.resolve();
    await slowRead;
    // The slow read started before the rename, so its rows must not be cached.
    assert.deepEqual(names((await get("/api/user/products")).json), ["Premium Cotton 100%"]);
  } finally { globalThis.fetch = originalFetch; Object.assign(config, savedConfig); invalidateCatalogCache(); }
});

test("catalog responses are never cached by the browser, Vercel edge or a CDN", async () => {
  await withCatalog([productRow(PRODUCT_ID, "Áo thun basic")], async () => {
    for (const [route, action] of [
      ["/api/user/products", undefined], ["/api/user/products?lite=1", undefined], ["/api/user/categories", undefined],
      [`/api/user/products/${PRODUCT_ID}`, PRODUCT_ID]
    ] as const) {
      // Twice: the first call fills the process cache, the second one is served from it.
      for (let pass = 0; pass < 2; pass += 1) {
        const cacheControl = String((await get(route, action)).headers["cache-control"]);
        assert.match(cacheControl, /no-store/, route);
        assert.doesNotMatch(cacheControl, /s-maxage|stale-while-revalidate|max-age=[1-9]/, route);
      }
    }
  });
});

test("storefront lists on_sale and out_of_stock only; discontinued opens by direct link, hidden never (UAT 3.1.10-01)", async () => {
  const target = productRow(PRODUCT_ID, "Áo thun basic");
  await withCatalog([target, productRow(OTHER_ID, "Quần jeans", { status: "out_of_stock" })], async (calls) => {
    assert.deepEqual(names((await get("/api/user/products")).json).sort(), ["Quần jeans", "Áo thun basic"].sort());
    // out_of_stock products and variants are invisible to the anon RLS policy (migration 006): read with the service key.
    assert.ok(calls.productKeys.length > 0 && calls.productKeys.every((key) => key === "service-key"));

    target.status = "discontinued";
    invalidateCatalogCache();
    assert.deepEqual(names((await get("/api/user/products")).json), ["Quần jeans"]);
    assert.deepEqual(names((await get("/api/user/products?q=basic")).json), []);
    const detail = (await get(`/api/user/products/${PRODUCT_ID}`, PRODUCT_ID)).json as JsonObject;
    assert.equal(detail.status, "discontinued");
    assert.equal(detail.product_id, PRODUCT_ID);

    target.status = "hidden";
    invalidateCatalogCache();
    assert.deepEqual(names((await get("/api/user/products")).json), ["Quần jeans"]);
    assert.deepEqual(names((await get("/api/user/products?lite=1&q=basic")).json), []);
    await assert.rejects(() => get(`/api/user/products/${PRODUCT_ID}`, PRODUCT_ID),
      (error: unknown) => error instanceof HttpError && error.status === 404);
  });
});

test("cart and checkout reject discontinued and hidden products with Vietnamese messages", () => {
  assert.equal(cartUnavailableReason("on_sale", "Áo"), null);
  assert.equal(cartUnavailableReason("out_of_stock", "Áo"), null);
  assert.equal(cartUnavailableReason("discontinued", "Áo thun"), "Sản phẩm 'Áo thun' đã ngừng kinh doanh và không thể thêm vào giỏ hàng.");
  assert.match(cartUnavailableReason("hidden", "") ?? "", /^Sản phẩm 'Sản phẩm' hiện không được bán/);

  let status = 0;
  let body = "";
  const response: HttpResponse = { writeHead(code) { status = code; }, end(chunk) { body += String(chunk || ""); }, setHeader() {} };
  sendError(response, new HttpError(400, "UNKNOWN_VARIANT", "Không tìm thấy biến thể sản phẩm."), {}, "req-1");
  assert.equal(status, 422);
  const parsed: unknown = JSON.parse(body);
  assert.match(JSON.stringify(parsed), /ngừng kinh doanh/);
});
