import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import { handleProductRoute } from "../../apps/api/src/products/product-router.js";
import { SKU_DUPLICATE_MESSAGE } from "../../apps/api/src/products/product-constants.js";
import { createProductRepository, type ProductRepository } from "../../apps/api/src/products/product-repository.js";
import { createProductService, validateCreateProduct, type LowStockAlert } from "../../apps/api/src/products/product-service.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";

/** KAN-105 UAT 3.1.10 regression tests: status transitions, SKU uniqueness, audit filters, CSV, low stock. */

const PRODUCT_ID = "70000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "70000000-0000-4000-8000-000000000002";
const BLACK_ID = "70000000-0000-4000-8000-000000000011";
const WHITE_ID = "70000000-0000-4000-8000-000000000012";

const adminContext = {
  authUser: { id: "70000000-0000-4000-8000-0000000000aa" }, profile: { is_active: true },
  isAdmin: true, roleCode: "super_admin", accessToken: "admin-token"
} as AuthContext;
const viewerContext = { ...adminContext, roleCode: "admin_viewer" } as AuthContext;

interface RecordedRequest { method: string; path: string; search: string; body: JsonObject | null }

/** Run `run` against a recorded fake PostgREST. */
async function withSupabase(
  handler: (request: RecordedRequest) => { status?: number; body: unknown },
  run: (requests: RecordedRequest[]) => Promise<void>
): Promise<void> {
  const savedConfig = { ...config };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const requests: RecordedRequest[] = [];
  Object.assign(config, { supabaseUrl: "https://uat-3110.test", supabaseServiceRoleKey: "service-test", supabaseAnonKey: "anon-test" });
  console.error = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      method: init?.method || "GET", path: url.pathname, search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) as JsonObject : null
    };
    requests.push(request);
    const reply = handler(request);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  try { await run(requests); }
  finally { globalThis.fetch = originalFetch; console.error = originalError; Object.assign(config, savedConfig); }
}

// ---------------------------------------------------------------- 3.1.10-01 status transitions

test("3.1.10-01 discontinued product can move back to on_sale, hidden or out_of_stock", async () => {
  for (const target of ["on_sale", "hidden", "out_of_stock"]) {
    const calls: JsonObject[] = [];
    const service = createProductService({ repository: {
      findById: async () => ({ product_id: PRODUCT_ID, status: "discontinued", images: ["/assets/a.jpg"], version: 4 }),
      changeStatus: async (_id: string, input: JsonObject) => { calls.push(input); return { product_id: PRODUCT_ID, status: input.status }; }
    } as unknown as ProductRepository });
    const result = await service.changeStatus(adminContext, PRODUCT_ID, {
      status: target, reason: "Bán lại sau khi kiểm tra hàng tồn", expectedVersion: 4
    }, { ipAddress: "127.0.0.1" }) as JsonObject;
    assert.equal(result.status, target);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedVersion, 4);
  }
});

test("3.1.10-01 status errors are Vietnamese: unchanged, missing primary image, short reason", async () => {
  const service = createProductService({ repository: {
    findById: async () => ({ product_id: PRODUCT_ID, status: "discontinued", images: [], version: 4 }),
    changeStatus: async () => assert.fail("must not write")
  } as unknown as ProductRepository });
  const rejected = async (body: JsonObject) => {
    try { await service.changeStatus(adminContext, PRODUCT_ID, { expectedVersion: 4, ...body }, {}); }
    catch (error) { return (error as HttpError).details as Record<string, string[]>; }
    return assert.fail("expected a validation error");
  };
  assert.match((await rejected({ status: "discontinued", reason: "Không đổi trạng thái" })).status[0], /đã ở trạng thái Ngừng kinh doanh/);
  assert.match((await rejected({ status: "on_sale", reason: "Mở bán lại sản phẩm này" })).images[0], /ảnh chính/);
  assert.match((await rejected({ status: "hidden", reason: "ngắn" })).reason[0], /từ 10 đến 500 ký tự/);
  assert.match((await rejected({ status: "bogus", reason: "Mở bán lại sản phẩm này" })).status[0], /Trạng thái không hợp lệ/);
});

test("3.1.10-01 a database transition rejection reaches the admin as a Vietnamese message", async () => {
  await withSupabase(() => ({ status: 422, body: { code: "PT422", message: "INVALID_STATUS_TRANSITION", details: null, hint: null } }), async () => {
    await assert.rejects(
      () => createProductRepository().changeStatus(PRODUCT_ID, { status: "on_sale", reason: "Bán lại sản phẩm", expectedVersion: 2 }, "admin-token"),
      (error: unknown) => error instanceof HttpError && error.code === "INVALID_STATUS_TRANSITION" && /Không thể chuyển sang trạng thái này/.test(error.message)
    );
  });
});

// ---------------------------------------------------------------- 3.1.10-19 status never touches variants

test("3.1.10-19 Hidden -> Discontinued -> Active writes only the status RPC; stock, SKU and price are untouched", async () => {
  const variants = [
    { variant_id: BLACK_ID, product_id: PRODUCT_ID, sku: "VL-UAT19-DEN", color: "Đen", size: "M", stock_quantity: 50, reserved_quantity: 0, low_stock_threshold: 5, version: 3 },
    { variant_id: WHITE_ID, product_id: PRODUCT_ID, sku: "VL-UAT19-TRANG", color: "Trắng", size: "M", stock_quantity: 30, reserved_quantity: 0, low_stock_threshold: 5, version: 2 }
  ];
  const product: JsonObject = { product_id: PRODUCT_ID, sku: "VL-UAT19", name: "Áo UAT 19", status: "on_sale", version: 1,
    base_price: 250000, sale_price: 250000, images: ["/assets/uat19.jpg"], variants };
  const snapshot = JSON.stringify({ variants, sku: product.sku, base: product.base_price, sale: product.sale_price });
  await withSupabase((request) => {
    if (request.path.endsWith("/rpc/admin_change_product_status")) {
      product.status = request.body?.p_new_status;
      product.version = Number(product.version) + 1;
      return { body: product };
    }
    return { body: request.path.endsWith("/product") ? [product] : variants };
  }, async (requests) => {
    const repository = createProductRepository();
    const service = createProductService({ repository: { findById: repository.findById, changeStatus: repository.changeStatus } as unknown as ProductRepository });
    for (const status of ["hidden", "discontinued", "on_sale"]) {
      await service.changeStatus(adminContext, PRODUCT_ID, { status, reason: "Chu kỳ trạng thái UAT AD_PRODUCT_14", expectedVersion: Number(product.version) }, {});
      assert.equal(product.status, status);
    }
    const writes = requests.filter((request) => request.method !== "GET");
    assert.deepEqual(writes.map((request) => request.path.split("/").pop()), Array(3).fill("admin_change_product_status"));
    assert.deepEqual(writes.map((request) => request.body?.p_new_status), ["hidden", "discontinued", "on_sale"]);
    assert.equal(JSON.stringify({ variants, sku: product.sku, base: product.base_price, sale: product.sale_price }), snapshot);
    assert.deepEqual(variants.map((variant) => [variant.color, variant.stock_quantity]), [["Đen", 50], ["Trắng", 30]]);
  });
});

// ---------------------------------------------------------------- 3.1.10-10 duplicate SKU message

test("3.1.10-10 create refuses a SKU that already exists on another product or variant with the Vietnamese message", async () => {
  let created = false;
  const service = createProductService({ repository: {
    findSkuOwner: async (sku: string) => sku === "VL-AO001" ? { kind: "product", productId: PRODUCT_ID } : null,
    createProduct: async () => { created = true; return {}; }
  } as unknown as ProductRepository });
  await assert.rejects(
    () => service.create(adminContext, { sku: "vl-ao001", name: "Áo trùng", categoryId: CATEGORY_ID, basePrice: 1000, status: "hidden", expectedVersion: 0 }, {}),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "SKU_DUPLICATE" && error.message === SKU_DUPLICATE_MESSAGE
  );
  await assert.rejects(
    () => service.create(adminContext, {
      sku: "VL-AO100", name: "Áo trùng biến thể", categoryId: CATEGORY_ID, basePrice: 1000, status: "hidden", expectedVersion: 0,
      variants: [{ sku: "VL-AO001", color: "Đen", size: "S", stockQuantity: 1 }]
    }, {}),
    (error: unknown) => error instanceof HttpError && error.message === SKU_DUPLICATE_MESSAGE
  );
  assert.equal(created, false);
  assert.equal(SKU_DUPLICATE_MESSAGE, "Mã SKU đã tồn tại, SKU phải là duy nhất trên toàn hệ thống");
});

test("3.1.10-10 duplicate SKUs inside the same form and duplicate color/size are rejected before any request", () => {
  const base = { sku: "VL-AO200", name: "Áo form", categoryId: CATEGORY_ID, basePrice: 1000, status: "hidden", expectedVersion: 0 };
  assert.throws(
    () => validateCreateProduct({ ...base, variants: [
      { sku: "VL-AO200-DEN-S", color: "Đen", size: "S", stockQuantity: 1 },
      { sku: " vl-ao200-den-s ", color: "Trắng", size: "S", stockQuantity: 1 }
    ] }),
    (error: unknown) => error instanceof HttpError && (error.details as Record<string, string[]>).sku[0] === SKU_DUPLICATE_MESSAGE
  );
  assert.throws(
    () => validateCreateProduct({ ...base, variants: [
      { sku: "VL-AO200-A", color: "Đen", size: "S", stockQuantity: 1 },
      { sku: "VL-AO200-B", color: "đen", size: "S", stockQuantity: 1 }
    ] }),
    (error: unknown) => error instanceof HttpError && Boolean((error.details as Record<string, string[]>).variants)
  );
});

test("3.1.10-10 raw unique violations and database duplicate codes map to the same Vietnamese message", async () => {
  for (const body of [
    { code: "23505", message: 'duplicate key value violates unique constraint "product_sku_key"', details: "Key (sku)=(VL-AO001) already exists." },
    { code: "23505", message: 'duplicate key value violates unique constraint "variant_sku_normalized_unique"' },
    { code: "PT409", message: "SKU_DUPLICATE" }
  ]) {
    await withSupabase(() => ({ status: 409, body }), async () => {
      await assert.rejects(
        () => createProductRepository().createProduct({ sku: "VL-AO001", variants: [] }, "admin-token"),
        (error: unknown) => error instanceof HttpError && error.code === "SKU_DUPLICATE" && error.message === SKU_DUPLICATE_MESSAGE
      );
    });
  }
});

test("3.1.10-10 inline SKU check endpoint reports duplicate, own-product and malformed SKUs", async () => {
  const service = createProductService({ repository: {
    findSkuOwner: async (sku: string) => sku === "VL-AO001" ? { kind: "variant", productId: PRODUCT_ID } : null
  } as unknown as ProductRepository });
  const check = async (query: string) => service.checkSku(viewerContext, new URLSearchParams(query)) as Promise<JsonObject>;
  assert.deepEqual(await check("sku=vl-ao001"), { sku: "VL-AO001", available: false, code: "SKU_DUPLICATE", message: SKU_DUPLICATE_MESSAGE });
  assert.equal((await check(`sku=VL-AO001&excludeProductId=${PRODUCT_ID}`)).available, true);
  assert.equal((await check("sku=VL-NEW001")).available, true);
  assert.equal((await check("sku=bad")).code, "SKU_INVALID");

  let sent: { status?: number; body?: string } = {};
  const handled = await handleProductRoute({
    req: { method: "GET", url: "/api/v1/admin/products/sku-check?sku=VL-AO001", headers: {} },
    res: { writeHead: (status: number) => { sent.status = status; }, end: (body: string) => { sent.body = body; } },
    url: new URL("http://localhost/api/v1/admin/products/sku-check?sku=VL-AO001"),
    parts: ["api", "v1", "admin", "products", "sku-check"], context: viewerContext, headers: {}, service
  } as unknown as Parameters<typeof handleProductRoute>[0]);
  assert.equal(handled, true);
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(String(sent.body)).message, SKU_DUPLICATE_MESSAGE);
});

// ---------------------------------------------------------------- 3.1.10-05 audit log filters

test("3.1.10-05 audit log filters (date range, product, action type, user) are sent to the database RPC", async () => {
  await withSupabase(() => ({ body: [{
    audit_id: "a1", actor_id: "u1", actor_role: "admin_operator_sanpham", action: "update", module: "products", target_id: PRODUCT_ID,
    old_value: { status: "discontinued" }, new_value: { status: "on_sale", reason: "Bán lại sau kiểm kê" }, ip_address: "1.1.1.1",
    timestamp: "2026-10-19T03:00:00+00:00", action_type: "UPDATE_STATUS", actor_name: "Khải", actor_email: "khai@velura.vn",
    product_id: PRODUCT_ID, product_sku: "VL-AO001", product_name: "Áo thun", total_count: 7
  }] }), async (requests) => {
    const service = createProductService({ repository: { listAuditLogs: createProductRepository().listAuditLogs } as unknown as ProductRepository });
    const result = await service.listAuditLogs(viewerContext, new URLSearchParams(
      "from=2026-10-01&to=2026-10-19&product=Áo thun&actionType=UPDATE_STATUS&user=khai@velura.vn&limit=20&offset=40"
    )) as { rows: JsonObject[]; count: number };
    const rpc = requests.find((request) => request.path.endsWith("/rpc/admin_list_product_audit_logs"));
    assert.deepEqual(rpc?.body, {
      p_from: "2026-10-01T00:00:00+07:00", p_to: "2026-10-19T23:59:59.999+07:00", p_product: "Áo thun",
      p_action_type: "UPDATE_STATUS", p_user: "khai@velura.vn", p_target_id: null, p_limit: 20, p_offset: 40
    });
    assert.equal(result.count, 7, "count comes from the SQL window total, not the page length");
    const row = result.rows[0];
    assert.equal(row.actor_email, "khai@velura.vn");
    assert.equal(row.action_label, "Đổi trạng thái");
    assert.equal(row.reason, "Bán lại sau kiểm kê");
    assert.equal(row.change_summary, "Ngừng kinh doanh → Đang bán");
    assert.equal("total_count" in row, false);
  });
});

test("3.1.10-05 audit log filters reject malformed dates, reversed ranges and unknown action types in Vietnamese", async () => {
  const service = createProductService({ repository: { listAuditLogs: async () => ({ rows: [], count: 0 }) } as unknown as ProductRepository });
  const message = async (query: string) => {
    try { await service.listAuditLogs(viewerContext, new URLSearchParams(query)); }
    catch (error) { return Object.values((error as HttpError).details as Record<string, string[]>)[0][0]; }
    return assert.fail("expected validation error");
  };
  assert.match(await message("from=19/10/2026"), /YYYY-MM-DD/);
  assert.match(await message("from=2026-10-19&to=2026-10-01"), /Ngày kết thúc/);
  assert.match(await message("actionType=DELETE_ALL"), /Loại hành động không hợp lệ/);
});

// ---------------------------------------------------------------- 3.1.10-20 / 3.1.10-21 CSV

const csvHeader = "sku,name,base_price,category_id,status,color,size,stock_quantity";

test("3.1.10-20 duplicate SKU rows in one file are rejected in preview and commit never writes", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null,
    importCsv: async () => assert.fail("a file with duplicate SKUs must not import")
  } as unknown as ProductRepository });
  const csv = [csvHeader,
    `VL-DUP001,Áo A,100000,${CATEGORY_ID},hidden,Đen,S,5`,
    `VL-OK0001,Áo B,100000,${CATEGORY_ID},hidden,Đen,S,5`,
    ` vl-dup001 ,Áo C,100000,${CATEGORY_ID},hidden,Trắng,S,5`].join("\n");
  const preview = await service.parseCsv(adminContext, csv) as { errors: JsonObject[]; rows: JsonObject[]; validRows: number };
  assert.deepEqual(preview.errors.filter((error) => error.field === "sku").map((error) => error.row), [2, 4]);
  assert.match(String(preview.errors[0].message), /bị lặp trong file \(cùng dòng 4\)/);
  assert.deepEqual(preview.rows.map((row) => row.sku), ["VL-OK0001"], "only the non-duplicated row stays valid");
  await assert.rejects(() => service.commitCsv(adminContext, csv, {}), (error: unknown) => error instanceof HttpError && error.code === "CSV_VALIDATION_FAILED");
});

test("3.1.10-20 an existing variant SKU updates that variant while a new SKU creates; nothing is deleted", async () => {
  const parent = { product_id: PRODUCT_ID, sku: "VL-UAT20", base_price: 250000, sale_price: 250000, version: 3, images: [] };
  const variant = { variant_id: BLACK_ID, product_id: PRODUCT_ID, sku: "VL-UAT20-DEN", stock_quantity: 50, reserved_quantity: 0, version: 2 };
  let received: JsonObject[] = [];
  const service = createProductService({ repository: {
    findBySku: async (sku: string) => sku === parent.sku ? parent : null,
    findById: async () => parent,
    findVariantBySku: async (sku: string) => sku === variant.sku ? variant : null,
    importCsv: async (rows: JsonObject[]) => { received = rows; return { created: 2, updated: 1, failed: 0, total: rows.length }; }
  } as unknown as ProductRepository });
  const csv = [csvHeader,
    `VL-UAT20-DEN,Áo UAT 20,250000,${CATEGORY_ID},,,,40`,
    `VL-NEW0001,Áo mới,100000,${CATEGORY_ID},hidden,Đen,S,5`].join("\n");
  const result = await service.commitCsv(adminContext, csv, {}) as JsonObject;
  assert.deepEqual(received.map((row) => [row.sku, row.operation]), [["VL-UAT20-DEN", "updated"], ["VL-NEW0001", "created"]]);
  assert.equal(received[0].variant_id, variant.variant_id, "existing SKU maps to the existing variant, not a new one");
  assert.equal(received[1].variant_id, null);
  assert.equal(result.updated, 1);
  assert.equal(result.created, 2);
});

test("3.1.10-21 a price differing from the Active product is skipped with a warning and the stored 250.000đ is kept", async () => {
  const current = { product_id: PRODUCT_ID, sku: "VL-UAT21", status: "on_sale", base_price: 250000, sale_price: 250000, version: 1 };
  let received: JsonObject[] = [];
  const service = createProductService({ repository: {
    findBySku: async () => current, findVariantBySku: async () => null,
    importCsv: async (rows: JsonObject[]) => { received = rows; return { created: 0, updated: 1, failed: 0, total: 1 }; }
  } as unknown as ProductRepository });
  const csv = `sku,name,base_price,category_id\nVL-UAT21,Áo UAT 21,199000,${CATEGORY_ID}`;
  const preview = await service.parseCsv(adminContext, csv) as { errors: JsonObject[]; warnings: JsonObject[] };
  assert.equal(preview.errors.length, 0);
  assert.equal(preview.warnings[0].field, "base_price");
  assert.match(String(preview.warnings[0].message), /199\.000đ.*250\.000đ/);
  const result = await service.commitCsv(adminContext, csv, {}) as JsonObject;
  assert.equal(received[0].base_price, 250000);
  assert.equal((result.warnings as JsonObject[])[0].csv_value, 199000);
});

// ---------------------------------------------------------------- 3.1.10-31 low stock

function stockRepository(stock: number, threshold: number, extra: Record<string, unknown> = {}): ProductRepository {
  return {
    findById: async () => ({ product_id: PRODUCT_ID, sku: "VL-UAT31", name: "Áo UAT 31", status: "on_sale", version: 1, is_combo: false }),
    listVariants: async () => ({ rows: [{ variant_id: BLACK_ID, color: "Đen", size: "M", stock_quantity: stock, low_stock_threshold: threshold, version: 4 }] }),
    updateStock: async () => ({ variant_id: BLACK_ID, stock_quantity: stock }),
    changeStatus: async () => assert.fail("a low but positive stock must not change visibility"),
    ...extra
  } as unknown as ProductRepository;
}

test("3.1.10-31 stock can be reduced below the threshold and the on-screen alert is returned with the queued email", async () => {
  await withSupabase((request) => {
    if (request.path.endsWith("/users")) return { body: [{ user_id: "u1", email: "admin@velura.vn" }, { user_id: "u2", email: "ops@velura.vn" }] };
    return { body: {} };
  }, async (requests) => {
    const service = createProductService({ repository: stockRepository(3, 5) });
    const result = await service.updateStock(adminContext, PRODUCT_ID, {
      variantId: BLACK_ID, delta: -47, reason: "Kiểm kê giảm tồn xuống dưới ngưỡng", expectedVersion: 3
    }, {}) as JsonObject & { lowStockAlert: LowStockAlert | null };
    assert.equal(result.lowStockAlert?.stock, 3);
    assert.equal(result.lowStockAlert?.threshold, 5);
    assert.equal(result.lowStockAlert?.emailQueued, true);
    assert.match(String(result.lowStockAlert?.message), /Cảnh báo tồn kho thấp.*còn 3, ngưỡng tối thiểu 5/);
    assert.equal(requests.filter((request) => request.path.endsWith("/email_outbox")).length, 2);
  });
});

test("3.1.10-31 a failed alert email is recorded in the retry table and never hides the on-screen alert", async () => {
  await withSupabase((request) => {
    if (request.path.endsWith("/users")) return { body: [{ user_id: "u1", email: "admin@velura.vn" }] };
    if (request.path.endsWith("/email_outbox")) return { status: 503, body: { message: "outbox unavailable" } };
    return { body: request.method === "GET" ? [] : {} };
  }, async (requests) => {
    const service = createProductService({ repository: stockRepository(2, 5, {
      recordLowStockAlertFailure: createProductRepository().recordLowStockAlertFailure
    }) });
    const result = await service.updateStock(adminContext, PRODUCT_ID, {
      variantId: BLACK_ID, delta: -48, reason: "Kiểm kê giảm tồn xuống dưới ngưỡng", expectedVersion: 3
    }, {}) as JsonObject & { lowStockAlert: LowStockAlert | null };
    assert.equal(result.lowStockAlert?.emailQueued, false);
    assert.equal(result.lowStockAlert?.retryRecorded, true);
    assert.match(String(result.lowStockAlert?.message), /Email cảnh báo chưa gửi được và đã lưu để thử lại/);
    const retry = requests.find((request) => request.method === "POST" && request.path.endsWith("/low_stock_alert_retry"));
    assert.equal(retry?.body?.variant_id, BLACK_ID);
    assert.equal(retry?.body?.stock_quantity, 2);
    assert.match(String(retry?.body?.last_error), /outbox unavailable|status:503/);
  });
});

test("3.1.10-31 stock above the threshold returns no alert, and a too-short reason is a Vietnamese 422", async () => {
  const service = createProductService({ repository: stockRepository(20, 5) });
  const result = await service.updateStock(adminContext, PRODUCT_ID, {
    variantId: BLACK_ID, delta: -30, reason: "Xuất kho bán sỉ cho đại lý", expectedVersion: 3
  }, {}) as JsonObject;
  assert.equal(result.lowStockAlert, null);
  await assert.rejects(
    () => service.updateStock(adminContext, PRODUCT_ID, { variantId: BLACK_ID, delta: -1, reason: "ngắn", expectedVersion: 3 }, {}),
    (error: unknown) => error instanceof HttpError && (error.details as Record<string, string[]>).reason[0] === "Lý do điều chỉnh tồn kho tối thiểu 10 ký tự"
  );
});

test("3.1.10-31 low-stock list names the products and the catalog low-stock filter narrows to them", async () => {
  const listed: JsonObject[] = [];
  const repository = {
    lowStockCount: async () => [
      { variant_id: BLACK_ID, product_id: PRODUCT_ID, color: "Đen", size: "M", stock_quantity: 0, low_stock_threshold: 5 },
      { variant_id: WHITE_ID, product_id: PRODUCT_ID, color: "Trắng", size: "M", stock_quantity: 4, low_stock_threshold: 5 }
    ],
    findProductsByIds: async () => ({ rows: [{ product_id: PRODUCT_ID, sku: "VL-UAT31", name: "Áo UAT 31", status: "on_sale" }] }),
    list: async (filters: JsonObject) => { listed.push(filters); return { rows: [], count: 0 }; }
  } as unknown as ProductRepository;
  const service = createProductService({ repository });
  const low = await service.lowStock(viewerContext) as JsonObject[];
  assert.deepEqual(low.map((row) => [row.product_name, row.color, row.shortage, row.out_of_stock]), [["Áo UAT 31", "Đen", 5, true], ["Áo UAT 31", "Trắng", 1, false]]);
  await service.list(viewerContext, new URLSearchParams("lowStock=true"));
  assert.deepEqual(listed[0].productIds, [PRODUCT_ID]);
  const empty = createProductService({ repository: { lowStockCount: async () => [], list: async () => assert.fail("no low-stock product, no list query") } as unknown as ProductRepository });
  assert.deepEqual(await empty.list(viewerContext, new URLSearchParams("lowStock=true")), { rows: [], count: 0 });
});
