import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductService,
  validateCreateVariant,
  validateCreateProduct,
  validateUpdateProduct,
  validateStatusChange,
  validateStockUpdate
} from "../../apps/api/src/products/product-service.js";
import type { ProductRepository } from "../../apps/api/src/products/product-repository.js";

const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";

// --- validateCreateProduct ---

test("validateCreateProduct auto-builds slug and allows empty images for hidden drafts", () => {
  const result = validateCreateProduct({
    sku: "VLR-AO099",
    name: "Áo linen kem",
    categoryId: CATEGORY_ID,
    basePrice: 250000,
    status: "hidden",
    expectedVersion: 0
  });
  assert.equal(result.slug, "ao-linen-kem");
  assert.deepEqual(result.images, []);
});

test("validateCreateProduct accepts valid input", () => {
  const result = validateCreateProduct({
    sku: "VL-AO001",
    name: "Ao Thun Trang",
    slug: "ao-thun-trang",
    categoryId: CATEGORY_ID,
    basePrice: 250000,
    salePrice: 200000,
    images: ["/assets/product-primary.jpg"],
    expectedVersion: 0
  });
  assert.equal(result.sku, "VL-AO001");
  assert.equal(result.basePrice, 250000);
  assert.equal(result.salePrice, 200000);
  assert.equal(result.status, "on_sale");
});

test("validateCreateProduct rejects invalid SKU", () => {
  try {
    validateCreateProduct({ sku: "bad", name: "Test", categoryId: CATEGORY_ID, basePrice: 100, expectedVersion: 0 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.equal(error.code, "VALIDATION_ERROR");
  }
});

test("validateCreateProduct rejects missing name", () => {
  try {
    validateCreateProduct({ sku: "VL-AO001", name: "", categoryId: CATEGORY_ID, basePrice: 100, expectedVersion: 0 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.name, "Should have name error");
  }
});

test("validateCreateProduct rejects missing categoryId", () => {
  try {
    validateCreateProduct({ sku: "VL-AO001", name: "Test Product", slug: "test-product", basePrice: 100, expectedVersion: 0 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.categoryId, "Should have categoryId error");
  }
});

test("validateCreateProduct rejects negative basePrice", () => {
  try {
    validateCreateProduct({ sku: "VL-AO001", name: "Test", slug: "test", categoryId: CATEGORY_ID, basePrice: -100, expectedVersion: 0 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.basePrice, "Should have basePrice error");
  }
});

// --- validateUpdateProduct ---

test("validateUpdateProduct accepts partial updates", () => {
  const result = validateUpdateProduct({ name: "New Name", expectedVersion: 5 });
  assert.equal(result.name, "New Name");
  assert.equal(result.description, undefined);
});

test("validateUpdateProduct rejects short name", () => {
  try {
    validateUpdateProduct({ name: "X", expectedVersion: 1 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.name, "Should have name error");
  }
});

// --- validateStatusChange ---

test("validateStatusChange accepts valid status", () => {
  const result = validateStatusChange({ status: "hidden", reason: "Tam an de cap nhat noi dung san pham", expectedVersion: 3 });
  assert.equal(result.status, "hidden");
});

test("validateStatusChange rejects invalid status", () => {
  try {
    validateStatusChange({ status: "invalid_status", expectedVersion: 1 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.status, "Should have status error");
  }
});

// --- validateStockUpdate ---

test("validateStockUpdate accepts valid delta", () => {
  const result = validateStockUpdate({ delta: -5, reason: "Xuat kho cho don hang da xac nhan", expectedVersion: 2 });
  assert.equal(result.delta, -5);
});

test("validateStockUpdate rejects non-numeric delta", () => {
  try {
    validateStockUpdate({ delta: "abc", expectedVersion: 1 });
    assert.fail("Expected validation error");
  } catch (error) {
    assert.equal(error.status, 422);
    assert.ok(error.details.delta, "Should have delta error");
  }
});

test("product mutation validation rejects unsafe image URLs and status bypass", () => {
  assert.throws(
    () => validateCreateProduct({ sku: "VL-AO001", name: "Test", slug: "test", categoryId: CATEGORY_ID, basePrice: 100, images: ["javascript:alert(1)"], expectedVersion: 0 }),
    (error) => error.status === 422 && error.details.images.length === 1
  );
  assert.throws(
    () => validateUpdateProduct({ status: "hidden", expectedVersion: 1 }),
    (error) => error.status === 422 && error.details.status.length === 1
  );
  assert.throws(
    () => validateUpdateProduct({ salePrice: 120000, expectedVersion: 1 }),
    (error) => error.status === 422 && error.details.price.length === 1
  );
});

test("validateCreateVariant accepts stock metadata and rejects invalid stock", () => {
  const result = validateCreateVariant({ color: "Den", colorHex: "#000000", size: "m", stockQuantity: 12, lowStockThreshold: 3 });
  assert.equal(result.size, "M");
  assert.equal(result.stockQuantity, 12);
  assert.throws(
    () => validateCreateVariant({ color: "Den", size: "M", stockQuantity: -1 }),
    (error) => error.status === 422 && error.details.stockQuantity.length === 1
  );
});

test("stock delta must be a non-zero integer with a reason", () => {
  assert.throws(
    () => validateStockUpdate({ delta: 0, reason: "Dieu chinh ton kho hop le", expectedVersion: 1 }),
    (error) => error.status === 422 && error.details.delta.length === 1
  );
  assert.throws(
    () => validateStockUpdate({ delta: 1.5, reason: "Dieu chinh ton kho hop le", expectedVersion: 1 }),
    (error) => error.status === 422 && error.details.delta.length === 1
  );
});

test("changeStatus allows discontinued to transition back to on_sale", async () => {
  let mutatedWith: { status?: string } | null = null;
  const service = createProductService({ repository: {
    findById: async () => ({ product_id: PRODUCT_ID, status: "discontinued", images: ["/assets/product-primary.jpg"], version: 2 }),
    changeStatus: async (_id, input) => {
      if (input && typeof input === "object" && "status" in input) {
        mutatedWith = { status: String(input.status) };
      }
      return { product_id: PRODUCT_ID, status: "on_sale" };
    }
  } });
  const result = await service.changeStatus(superAdminContext(), PRODUCT_ID, {
    status: "on_sale", reason: "Mo ban lai san pham sau khi kiem tra", expectedVersion: 2
  }, { ipAddress: "127.0.0.1" });
  const status = result && typeof result === "object" && "status" in result ? result.status : null;
  assert.equal(mutatedWith?.status, "on_sale");
  assert.equal(status, "on_sale");
});

test("changeStatus rejects unchanged status or invalid transition", async () => {
  const service = createProductService({ repository: {
    findById: async () => ({ product_id: PRODUCT_ID, status: "on_sale", version: 1 }),
    changeStatus: async () => {}
  } });
  await assert.rejects(
    () => service.changeStatus(superAdminContext(), PRODUCT_ID, {
      status: "on_sale", reason: "Khong thay doi trang thai", expectedVersion: 1
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.details.status.length === 1
  );
});

test("product list validates category and price filters", async () => {
  const service = createProductService({ repository: { list: async () => ({ rows: [] }) } });
  await assert.rejects(
    () => service.list(superAdminContext(), new URLSearchParams("categoryId=bad")),
    (error) => error.status === 422 && error.details.categoryId.length === 1
  );
  await assert.rejects(
    () => service.list(superAdminContext(), new URLSearchParams("minPrice=200&maxPrice=100")),
    (error) => error.status === 422 && error.details.price.length === 1
  );
});

test("CSV preview returns every applicable per-row error without throwing", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null
  } });
  const result = await service.parseCsv(superAdminContext(), [
    "sku,name,base_price,category_id,status",
    `VL-AO001,Ao linen,100000,${CATEGORY_ID},hidden`,
    "badsku,Ten loi,not-a-price,not-a-uuid,hidden"
  ].join("\n"));
  assert.equal(result.validRows, 1);
  assert.equal(result.totalRows, 2);
  assert.deepEqual(result.errors.map((error) => [error.row, error.field]), [[3, "sku"], [3, "base_price"], [3, "category_id"]]);
});

test("CSV commit refuses to write when preview still has row errors", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null,
    importCsv: async () => assert.fail("should not import")
  } });
  await assert.rejects(
    () => service.commitCsv(superAdminContext(), [
      "sku,name,base_price,category_id,status", `badsku,Ten loi,100000,${CATEGORY_ID},hidden`
    ].join("\n"), { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.code === "CSV_VALIDATION_FAILED"
  );
});

test("CSV preview parses BOM and quoted commas", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null
  } });
  const result = await service.parseCsv(superAdminContext(), [
    "\uFEFFsku,name,base_price,category_id,status", `VL-AO001,"Ao, linen",100000,${CATEGORY_ID},hidden`
  ].join("\n"));
  assert.equal(result.rows[0].name, "Ao, linen");
  assert.equal(result.rows[0].category_id, CATEGORY_ID);
});

test("CSV commit passes new hidden product and explicit initial variant to the atomic repository import", async () => {
  let received;
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null,
    importCsv: async (rows) => { received = rows; return { created: 1, updated: 0, failed: 0, total: 1 }; }
  } });
  const result = await service.commitCsv(superAdminContext(), [
    "sku,name,base_price,category_id,status,color,size,stock_quantity",
    `VL-AO002,Ao lua trang,150000,${CATEGORY_ID},hidden,Đen,S,50`
  ].join("\n"), { ipAddress: "127.0.0.1" });
  assert.equal(result.created, 1);
  assert.equal(received[0].product_id, null);
  assert.equal(received[0].color, "Đen");
  assert.equal(received[0].size, "S");
  assert.equal(received[0].stock_quantity, 50);
});

test("CSV duplicate normalized SKU blocks both rows and commit even when the first row has other errors", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null,
    importCsv: async () => assert.fail("duplicate file must not write")
  } });
  const csv = ["sku,name,base_price,category_id,status",
    `VL-AO002,,150000,${CATEGORY_ID},hidden`, ` vl-ao002 ,Ao lua,150000,${CATEGORY_ID},hidden`].join("\n");
  const result = await service.parseCsv(superAdminContext(), csv);
  assert.deepEqual(result.errors.filter((error) => error.field === "sku").map((error) => error.row), [2, 3]);
  assert.ok(result.errors.some((error) => error.row === 2 && error.field === "name"));
  assert.equal(result.validRows, 0);
  await assert.rejects(() => service.commitCsv(superAdminContext(), csv, {}), (error) => error.code === "CSV_VALIDATION_FAILED");
});

test("CSV rejects repeated headers and malformed row widths before any write", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => null, findVariantBySku: async () => null,
    importCsv: async () => assert.fail("invalid CSV must not write")
  } });
  for (const csv of [
    `sku,name,base_price,category_id,status,SKU\nVL-AO002,Ao lua,150000,${CATEGORY_ID},hidden,VL-AO002`,
    `sku,name,base_price,category_id,status\nVL-AO002,Ao lua,150000,${CATEGORY_ID},hidden,extra`
  ]) {
    const preview = await service.parseCsv(superAdminContext(), csv);
    assert.ok(preview.errors.length);
    await assert.rejects(() => service.commitCsv(superAdminContext(), csv, {}), (error) => error.code === "CSV_VALIDATION_FAILED");
  }
});

test("CSV never overwrites an existing price: preview warns, skips the price and commit sends the stored price (AD_PRODUCT_16)", async () => {
  const current = { product_id: PRODUCT_ID, sku: "VL-AO002", status: "on_sale", base_price: 250000, sale_price: 250000, version: 1 };
  let received;
  const service = createProductService({ repository: {
    findBySku: async () => current, findVariantBySku: async () => null,
    importCsv: async (rows) => { received = rows; return { created: 0, updated: 1, failed: 0, total: rows.length }; }
  } });
  for (const status of ["hidden", "on_sale", ""]) {
    const csv = `sku,name,base_price,sale_price,category_id,status\nVL-AO002,Ao lua,100000,100000,${CATEGORY_ID},${status}`;
    const preview = await service.parseCsv(superAdminContext(), csv);
    assert.deepEqual(preview.errors, [], "a differing price is a warning, not a blocking error");
    assert.deepEqual(preview.warnings.map((warning) => warning.field), ["base_price", "sale_price"]);
    assert.match(preview.warnings[0].message, /giữ nguyên 250\.000đ/);
    assert.equal(preview.validRows, 1);
    assert.equal(preview.rows[0].base_price, 250000, "row carries the stored price, never the CSV price");
    assert.equal(preview.rows[0].sale_price, 250000);
    assert.deepEqual(preview.rows[0].skipped_prices, ["base_price", "sale_price"]);
    const result = await service.commitCsv(superAdminContext(), csv, {});
    assert.equal(received[0].base_price, 250000);
    assert.equal(received[0].sale_price, 250000);
    assert.equal(result.skippedPrices, 2);
    assert.equal(result.warnings.length, 2);
  }
  assert.equal(current.base_price, 250000);
});

test("CSV commit re-reads stored prices after preview and still never sends the CSV price", async () => {
  const current = { product_id: PRODUCT_ID, sku: "VL-AO002", status: "on_sale", base_price: 250000, sale_price: 250000, version: 1 };
  let received;
  const service = createProductService({ repository: {
    findBySku: async () => current, findVariantBySku: async () => null,
    importCsv: async (rows) => { received = rows; return { created: 0, updated: 1, failed: 0, total: 1 }; }
  } });
  const csv = `sku,name,base_price,category_id\nVL-AO002,Ao lua,250000,${CATEGORY_ID}`;
  assert.equal((await service.parseCsv(superAdminContext(), csv)).warnings.length, 0);
  current.base_price = 300000;
  const result = await service.commitCsv(superAdminContext(), csv, {});
  assert.equal(received[0].base_price, 300000, "stored price wins over the stale CSV value");
  assert.equal(result.warnings[0].field, "base_price");
});

test("CSV distinguishes existing and new variant identity without deleting or resetting omitted stock or sale price", async () => {
  const parent = { product_id: PRODUCT_ID, sku: "VL-AO002", base_price: 250000, sale_price: 200000, version: 3 };
  const variant = { variant_id: "50000000-0000-4000-8000-000000000001", product_id: PRODUCT_ID, sku: "VL-AO002-BL-S", stock_quantity: 12, reserved_quantity: 4, version: 2 };
  let received;
  const service = createProductService({ repository: {
    findBySku: async (sku) => sku === parent.sku ? parent : null,
    findById: async () => parent,
    findVariantBySku: async (sku) => sku === variant.sku ? variant : null,
    importCsv: async (rows) => { received = rows; return { created: 1, updated: 1, failed: 0, total: rows.length }; }
  } });
  const csv = ["sku,product_sku,name,base_price,category_id,color,size,stock_quantity",
    `VL-AO002-BL-S,,Ao lua,250000,${CATEGORY_ID},,,`,
    `VL-AO002-BL-M,VL-AO002,Ao lua,250000,${CATEGORY_ID},Đen,M,8`].join("\n");
  const result = await service.commitCsv(superAdminContext(), csv, {});
  assert.equal(result.updated, 1);
  assert.equal(result.created, 1);
  assert.equal(received[0].variant_id, variant.variant_id);
  assert.equal(received[0].stock_quantity, null);
  assert.equal(received[0].sale_price, null);
  assert.equal(received[0].status, null);
  assert.equal(received[1].variant_id, null);
  assert.equal(received[1].product_id, PRODUCT_ID);
  const badStock = `sku,name,base_price,category_id,stock_quantity\nVL-AO002-BL-S,Ao lua,250000,${CATEGORY_ID},3`;
  assert.equal((await service.parseCsv(superAdminContext(), badStock)).errors[0].field, "stock_quantity");
});

test("initial product variants retain their explicit normalized SKU", () => {
  const input = validateCreateProduct({
    sku: "VL-AO002", name: "Ao lua", categoryId: CATEGORY_ID, basePrice: 250000, status: "hidden", expectedVersion: 0,
    variants: [{ sku: " vl-ao002-bl-s ", color: "Đen", size: "S", stockQuantity: 8 }]
  });
  assert.equal(input.variants[0].sku, "VL-AO002-BL-S");
});

test("CSV preview rejects SKU ambiguity between a product and a different parent's variant", async () => {
  const service = createProductService({ repository: {
    findBySku: async () => ({ product_id: PRODUCT_ID, sku: "VL-AO002" }),
    findById: async () => ({ product_id: "30000000-0000-4000-8000-000000000002", sku: "VL-AO003", base_price: 250000, sale_price: 250000 }),
    findVariantBySku: async () => ({ variant_id: "50000000-0000-4000-8000-000000000001", product_id: "30000000-0000-4000-8000-000000000002" })
  } });
  const result = await service.parseCsv(superAdminContext(), `sku,name,base_price,category_id\nVL-AO002,Ao lua,250000,${CATEGORY_ID}`);
  assert.equal(result.validRows, 0);
  assert.equal(result.errors[0].field, "sku");
});

// --- Service RBAC ---

test("product service denies non-product admin roles for mutations", async () => {
  let called = false;
  const service = createProductService({ repository: { createProduct: async () => { called = true; } } });
  try {
    await service.create(donHangContext(), { sku: "VL-AO001", name: "Test", categoryId: CATEGORY_ID, basePrice: 100, expectedVersion: 0 }, { ipAddress: "127.0.0.1" });
    assert.fail("Expected RBAC error");
  } catch (error) {
    assert.equal(error.status, 403);
    assert.equal(error.code, "RBAC_DENIED");
  }
  assert.equal(called, false);
});

test("product service allows super_admin to create products", async () => {
  let received;
  const service = createProductService({
    repository: {
      createProduct: async (...args) => { received = args; return { product_id: PRODUCT_ID, sku: "VL-AO001" }; }
    }
  });
  const result = await service.create(superAdminContext(), {
    sku: "VL-AO001",
    name: "Ao Thun Trang",
    slug: "ao-thun-trang",
    categoryId: CATEGORY_ID,
    basePrice: 250000,
    salePrice: 200000,
    images: ["/assets/product-primary.jpg"],
    expectedVersion: 0
  }, { ipAddress: "127.0.0.1" });
  assert.equal(result.product_id, PRODUCT_ID);
  assert.equal(received[0].sku, "VL-AO001");
  assert.equal(received[1], "valid-token");
});

test("product create sends its default variant atomically with the caller token", async () => {
  let variantArgs;
  const service = createProductService({
    repository: {
      createProduct: async (...args) => {
        variantArgs = args;
        return { product_id: PRODUCT_ID, sku: "VL-AO001", status: "on_sale", version: 1 };
      },
      findById: async () => ({ product_id: PRODUCT_ID, status: "on_sale", version: 1 }),
      listVariants: async () => [{ stock_quantity: 4 }],
      changeStatus: async () => {
        throw new Error("should not change status when stock is already on_sale");
      }
    }
  });
  await service.create(sanPhamContext(), {
    sku: "VL-AO001",
    name: "Ao Thun",
    categoryId: CATEGORY_ID,
    basePrice: 100000,
    images: ["/assets/product-primary.jpg"],
    initialStock: 4,
    expectedVersion: 0
  }, { ipAddress: "127.0.0.1" });
  assert.equal(variantArgs[1], "sanpham-token");
  assert.equal(variantArgs[0].variants[0].stockQuantity, 4);
});

test("product create sends all SKU matrix variants in its atomic creation request", async () => {
  const createdVariants: Array<Record<string, unknown>> = [];
  const service = createProductService({
    repository: {
      createProduct: async (input) => {
        createdVariants.push(...input.variants as Array<Record<string, unknown>>);
        return { product_id: PRODUCT_ID };
      },
      findById: async () => ({ product_id: PRODUCT_ID, status: "on_sale", version: 1 }),
      listVariants: async () => createdVariants,
      changeStatus: async () => {}
    } as unknown as ProductRepository
  });
  await service.create(sanPhamContext(), {
    sku: "VLR-DAM01",
    name: "Đầm Dạ Hội Lụa Hoàng Gia Velura",
    categoryId: CATEGORY_ID,
    basePrice: 1200000,
    images: ["/assets/product-primary.jpg"],
    material: "Lụa Tơ Tằm",
    variants: [
      { color: "Đen", size: "S", stockQuantity: 10, lowStockThreshold: 5 },
      { color: "Đen", size: "M", stockQuantity: 10, lowStockThreshold: 5 },
      { color: "Đen", size: "L", stockQuantity: 10, lowStockThreshold: 5 },
      { color: "Đỏ Ruby", size: "S", stockQuantity: 0, lowStockThreshold: 5 },
      { color: "Đỏ Ruby", size: "M", stockQuantity: 15, lowStockThreshold: 5 },
      { color: "Đỏ Ruby", size: "L", stockQuantity: 10, lowStockThreshold: 5 }
    ],
    expectedVersion: 0
  }, { ipAddress: "127.0.0.1" });

  assert.equal(createdVariants.length, 6);
  assert.equal(createdVariants[3].color, "Đỏ Ruby");
  assert.equal(createdVariants[3].size, "S");
  assert.equal(createdVariants[3].stockQuantity, 0);
  assert.equal(createdVariants[4].color, "Đỏ Ruby");
  assert.equal(createdVariants[4].size, "M");
  assert.equal(createdVariants[4].stockQuantity, 15);
});

test("product service allows product operator to create products", async () => {
  let called = false;
  const service = createProductService({
    repository: { createProduct: async () => { called = true; return { product_id: PRODUCT_ID }; } }
  });
  await service.create(sanPhamContext(), {
    sku: "VL-AO001",
    name: "Ao Thun",
    slug: "ao-thun",
    categoryId: CATEGORY_ID,
    basePrice: 100000,
    images: ["/assets/product-primary.jpg"],
    expectedVersion: 0
  }, { ipAddress: "127.0.0.1" });
  assert.equal(called, true);
});

test("product service allows viewer to list products", async () => {
  let called = false;
  const service = createProductService({ repository: { list: async () => { called = true; return { rows: [], count: 0 }; } } });
  await service.list(viewerContext(), new URLSearchParams());
  assert.equal(called, true);
});

test("product service denies viewer from creating products", async () => {
  const service = createProductService({ repository: { createProduct: async () => ({}) } });
  try {
    await service.create(viewerContext(), { sku: "VL-AO001", name: "Test", categoryId: CATEGORY_ID, basePrice: 100, expectedVersion: 0 }, { ipAddress: "127.0.0.1" });
    assert.fail("Expected RBAC error");
  } catch (error) {
    assert.equal(error.status, 403);
  }
});

test("product service denies unauthenticated access", async () => {
  const service = createProductService({ repository: { list: async () => ({}) } });
  try {
    await service.list(null, new URLSearchParams());
    assert.fail("Expected auth error");
  } catch (error) {
    assert.equal(error.status, 401);
  }
});

test("combo items service operations work with correct RBAC", async () => {
  let actions = [];
  const COMBO_ITEM_ID = "20000000-0000-4000-8000-000000000001";
  const repo = {
    getComboItems: async (productId, token) => { actions.push({ type: "get", productId, token }); return []; },
    addComboItem: async (productId, compId, varId, qty, token) => { actions.push({ type: "add", productId, compId, varId, qty, token }); return { combo_item_id: COMBO_ITEM_ID }; },
    updateComboItem: async (productId, itemId, qty, token) => { actions.push({ type: "update", productId, itemId, qty, token }); return { combo_item_id: itemId }; },
    removeComboItem: async (productId, itemId, token) => { actions.push({ type: "remove", productId, itemId, token }); return { success: true }; }
  };
  const service = createProductService({ repository: repo });

  // 1. Get
  await service.getComboItems(sanPhamContext(), PRODUCT_ID);
  assert.equal(actions[0].type, "get");
  assert.equal(actions[0].productId, PRODUCT_ID);

  // 2. Add
  await service.addComboItem(sanPhamContext(), PRODUCT_ID, { componentProductId: "comp-1", componentVariantId: "var-1", quantity: 3 });
  assert.equal(actions[1].type, "add");
  assert.equal(actions[1].productId, PRODUCT_ID);
  assert.equal(actions[1].compId, "comp-1");
  assert.equal(actions[1].qty, 3);

  // 3. Update
  await service.updateComboItem(sanPhamContext(), PRODUCT_ID, COMBO_ITEM_ID, { quantity: 4 });
  assert.equal(actions[2].type, "update");
  assert.equal(actions[2].productId, PRODUCT_ID);
  assert.equal(actions[2].itemId, COMBO_ITEM_ID);
  assert.equal(actions[2].qty, 4);

  // 4. Remove
  await service.removeComboItem(sanPhamContext(), PRODUCT_ID, COMBO_ITEM_ID);
  assert.equal(actions[3].type, "remove");
  assert.equal(actions[3].productId, PRODUCT_ID);
  assert.equal(actions[3].itemId, COMBO_ITEM_ID);

  // Validate validation errors
  await assert.rejects(
    () => service.addComboItem(sanPhamContext(), PRODUCT_ID, { componentProductId: "", quantity: 3 }),
    (error) => error.status === 422
  );
  await assert.rejects(
    () => service.addComboItem(sanPhamContext(), PRODUCT_ID, { componentProductId: "comp-1", quantity: -1 }),
    (error) => error.status === 422
  );
  await assert.rejects(
    () => service.updateComboItem(sanPhamContext(), PRODUCT_ID, COMBO_ITEM_ID, { quantity: 0 }),
    (error) => error.status === 422
  );

  // Validate RBAC denials for mutations
  await assert.rejects(
    () => service.addComboItem(viewerContext(), PRODUCT_ID, { componentProductId: "comp-1", quantity: 3 }),
    (error) => error.status === 403
  );
});

test("listAuditLogs maps legacy date/q/action onto server-side filters and enriches the returned page", async () => {
  let capturedFilters: Record<string, unknown> | null = null;
  const service = createProductService({
    repository: {
      listAuditLogs: async (filters: Record<string, unknown>) => {
        capturedFilters = filters;
        return { rows: [{
          audit_id: "log-1", action: "update", action_type: "UPDATE_STOCK", timestamp: "2026-10-18T08:30:00.000Z", target_id: PRODUCT_ID,
          actor_name: "Khải", actor_email: "khai@velura.vn", actor_role: "admin_operator_sanpham",
          product_sku: "VL-AO001", product_name: "UAT-Khai Áo Thun Premium",
          old_value: { stock_quantity: 50 }, new_value: { stock_quantity: 3, reason: "Kiểm kê định kỳ cuối tháng" }
        }], count: 1 };
      }
    } as unknown as ProductRepository
  });
  const result = await service.listAuditLogs(viewerContext(), new URLSearchParams({
    q: "UAT-Khai", date: "2026-10-18", action: "update_stock"
  })) as { rows: Array<Record<string, unknown>>; count: number };
  assert.equal(capturedFilters?.product, "UAT-Khai");
  assert.equal(capturedFilters?.actionType, "UPDATE_STOCK");
  assert.equal(capturedFilters?.fromDate, "2026-10-18T00:00:00+07:00");
  assert.equal(capturedFilters?.toDate, "2026-10-18T23:59:59.999+07:00");
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].action_label, "Điều chỉnh tồn kho");
  assert.equal(result.rows[0].actor_label, "Khải (khai@velura.vn)");
  assert.equal(result.rows[0].reason, "Kiểm kê định kỳ cuối tháng");
  assert.equal(result.rows[0].change_summary, "Tồn 50 → 3");
});

test("explicit image colors validate against creation variants without filename inference", () => {
  const result = validateCreateProduct({
    sku: "VL-IMG01", name: "Color garment", categoryId: CATEGORY_ID, basePrice: 100,
    images: ["/assets/red-name.jpg", "/assets/common.jpg"],
    imageColors: { "/assets/red-name.jpg": "Đen" },
    variants: [{ color: "Đen", size: "M", stockQuantity: 1 }], expectedVersion: 0
  });
  assert.deepEqual(result.imageColors, { "/assets/red-name.jpg": "Đen" });
  assert.deepEqual(result.images, ["/assets/red-name.jpg", "/assets/common.jpg"]);
  assert.equal(result.variants[0].color, "Đen");
});

test("create rejects orphan image links, unknown or empty colors and malformed maps", () => {
  const body = {
    sku: "VL-IMG01", name: "Color garment", categoryId: CATEGORY_ID, basePrice: 100,
    images: ["/assets/one.jpg"], variants: [{ color: "Đen", size: "M", stockQuantity: 0 }], expectedVersion: 0
  };
  for (const imageColors of [
    { "/assets/missing.jpg": "Đen" }, { "/assets/one.jpg": "Trắng" },
    { "/assets/one.jpg": "" }, { "/assets/one.jpg": " đen " }, [], null
  ]) {
    assert.throws(() => validateCreateProduct({ ...body, imageColors }),
      (error) => error.status === 422 && Boolean(error.details.imageColors));
  }
});

test("server image validation enforces twenty unique URLs and on-sale primary", () => {
  const body = { sku: "VL-IMG01", name: "Color garment", categoryId: CATEGORY_ID, basePrice: 100, expectedVersion: 0 };
  const images = Array.from({ length: 20 }, (_, index) => `/assets/image-${index}.jpg`);
  assert.equal(validateCreateProduct({ ...body, images }).images.length, 20);
  assert.throws(() => validateCreateProduct(body), (error) => error.status === 422 && Boolean(error.details.images));
  for (const invalid of [[...images, "/assets/extra.jpg"], [images[0], images[0]]]) {
    assert.throws(() => validateCreateProduct({ ...body, images: invalid }),
      (error) => error.status === 422 && Boolean(error.details.images));
    assert.throws(() => validateUpdateProduct({ images: invalid, expectedVersion: 1 }),
      (error) => error.status === 422 && Boolean(error.details.images));
  }
});

test("image removal prunes associations, reordering preserves them, metadata patches leave them untouched", async () => {
  const current = {
    product_id: PRODUCT_ID, status: "on_sale", version: 1,
    images: ["/assets/one.jpg", "/assets/two.jpg"],
    image_colors: { "/assets/one.jpg": "Đen", "/assets/two.jpg": "Trắng" }
  };
  const calls: Array<Record<string, unknown>> = [];
  const service = createProductService({ repository: {
    findById: async () => current,
    listVariants: async () => ({ rows: [{ color: "Đen" }, { color: "Trắng" }] }),
    updateProduct: async (_id, input) => { calls.push(input); return { ...current, image_colors: input.imageColors ?? current.image_colors }; }
  } as unknown as ProductRepository });
  await service.update(superAdminContext(), PRODUCT_ID, { images: ["/assets/two.jpg"], expectedVersion: 1 }, {});
  assert.deepEqual(calls[0].imageColors, { "/assets/two.jpg": "Trắng" });
  await service.update(superAdminContext(), PRODUCT_ID, { images: ["/assets/two.jpg", "/assets/one.jpg"], expectedVersion: 1 }, {});
  assert.deepEqual(calls[1].imageColors, current.image_colors);
  await service.update(superAdminContext(), PRODUCT_ID, { name: "Metadata only", expectedVersion: 1 }, {});
  assert.equal(calls[2].imageColors, undefined);
  const updated = await service.update(superAdminContext(), PRODUCT_ID, { imageColors: {}, expectedVersion: 1 }, {});
  assert.deepEqual((updated as Record<string, unknown>).image_colors, {});
  for (const imageColors of [{ "/assets/gone.jpg": "Đen" }, { "/assets/one.jpg": "Not a variant" }]) {
    await assert.rejects(() => service.update(superAdminContext(), PRODUCT_ID, { imageColors, expectedVersion: 1 }, {}),
      (error) => error.status === 422 && Boolean(error.details.imageColors));
  }
  await assert.rejects(() => service.update(superAdminContext(), PRODUCT_ID, { images: [], expectedVersion: 1 }, {}),
    (error) => error.status === 422 && Boolean(error.details.images));
});

test("hidden drafts may remove all images but cannot publish without a primary", async () => {
  const service = createProductService({ repository: {
    findById: async () => ({ product_id: PRODUCT_ID, status: "hidden", images: [], image_colors: {}, version: 1 }),
    listVariants: async () => ({ rows: [] }),
    updateProduct: async (_id, input) => input
  } as unknown as ProductRepository });
  await service.update(superAdminContext(), PRODUCT_ID, { images: [], expectedVersion: 1 }, {});
  await assert.rejects(() => service.changeStatus(superAdminContext(), PRODUCT_ID,
    { status: "on_sale", reason: "Publish after product review", expectedVersion: 1 }, {}),
    (error) => error.status === 422 && Boolean(error.details.images));
});

// --- Helpers ---

function superAdminContext() {
  return {
    authUser: { id: "auth-1" },
    profile: { user_id: "actor-1", is_active: true },
    isAdmin: true,
    roleCode: "super_admin",
    accessToken: "valid-token"
  };
}

function sanPhamContext() {
  return {
    authUser: { id: "auth-3" },
    profile: { user_id: "actor-3", is_active: true },
    isAdmin: true,
    roleCode: "admin_operator_sanpham",
    accessToken: "sanpham-token"
  };
}

function donHangContext() {
  return {
    authUser: { id: "auth-4" },
    profile: { user_id: "actor-4", is_active: true },
    isAdmin: true,
    roleCode: "admin_operator_donhang",
    accessToken: "donhang-token"
  };
}

function viewerContext() {
  return {
    authUser: { id: "auth-5" },
    profile: { user_id: "actor-5", is_active: true },
    isAdmin: true,
    roleCode: "admin_viewer",
    accessToken: "viewer-token"
  };
}
