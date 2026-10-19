import test from "node:test";
import assert from "node:assert/strict";
import type { OutgoingHttpHeaders } from "node:http";
import { config } from "../../apps/api/src/config.js";
import type { HttpResponse } from "../../apps/api/src/types.js";
import { handleProductsRoute, invalidateCatalogCache } from "../../apps/api/src/user/products.js";

test("full, lite, cached and detail catalog reads cannot replay a pre-rename HTTP response", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  const id = "30000000-0000-4000-8000-000000000001";
  let name = "UAT-Khai Áo Thun Basic";
  Object.assign(config, { supabaseUrl: "https://catalog.test", supabaseAnonKey: "fixture" });
  globalThis.fetch = async input => {
    const rows = new URL(String(input)).pathname.endsWith("/product")
      ? [{ product_id: id, name, slug: "uat-khai", is_combo: false, category: { slug: "ao", name: "Áo" }, variants: [] }]
      : [];
    return Response.json(rows);
  };
  async function read(query = "", action?: string) {
    let status = 0;
    let headers: OutgoingHttpHeaders = {};
    let body = "";
    const res: HttpResponse = {
      writeHead(code, values) { status = code; headers = values || {}; },
      end(chunk) { body = String(chunk); },
      setHeader() {},
    };
    await handleProductsRoute({ method: "GET", url: `/api/user/products${query}`, headers: {} }, res, "products", action, {});
    assert.equal(status, 200);
    assert.equal(headers["cache-control"], "no-store");
    return JSON.parse(body);
  }
  invalidateCatalogCache();
  try {
    for (const query of ["", "?lite=1"]) {
      assert.equal((await read(query))[0].name, name);
      assert.equal((await read(query))[0].name, name);
    }
    name = "UAT-Khai Áo Thun Premium Cotton 100%";
    invalidateCatalogCache();
    for (const query of ["?q=Premium%20Cotton%20100%25", "?lite=1&q=Premium%20Cotton%20100%25"]) {
      assert.equal((await read(query))[0].name, name);
    }
    assert.equal((await read("", id)).name, name);
  } finally {
    invalidateCatalogCache();
    globalThis.fetch = originalFetch;
    Object.assign(config, saved);
  }
});
