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

const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "40000000-0000-4000-8000-000000000001";

// --- validateCreateProduct ---

test("validateCreateProduct accepts valid input", () => {
  const result = validateCreateProduct({
    sku: "VL-AO001",
    name: "Ao Thun Trang",
    slug: "ao-thun-trang",
    categoryId: CATEGORY_ID,
    basePrice: 250000,
    salePrice: 200000,
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

test("changeStatus validates the transition before mutation", async () => {
  let mutated = false;
  const service = createProductService({ repository: {
    findById: async () => ({ product_id: PRODUCT_ID, status: "discontinued" }),
    changeStatus: async () => { mutated = true; }
  } });
  await assert.rejects(
    () => service.changeStatus(superAdminContext(), PRODUCT_ID, {
      status: "on_sale", reason: "Mo ban lai san pham sau khi kiem tra", expectedVersion: 2
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.details.status.length === 1
  );
  assert.equal(mutated, false);
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

test("CSV preview parses quoted commas", async () => {
  const service = createProductService({ repository: {} });
  const result = await service.parseCsv(superAdminContext(), [
    "sku,name,base_price,category_id",
    `VL-AO001,\"Ao, linen\",100000,${CATEGORY_ID}`
  ].join("\n"));
  assert.equal(result.rows[0].name, "Ao, linen");
  assert.equal(result.rows[0].category_id, CATEGORY_ID);
});

test("CSV commit creates production products through the repository with create version zero", async () => {
  const received = [];
  const service = createProductService({
    repository: {
      createProduct: async (payload) => {
        received.push(payload);
        return { product_id: PRODUCT_ID, sku: payload.sku };
      }
    }
  });
  const result = await service.commitCsv(superAdminContext(), [
    "sku,name,base_price,category_id,status",
    `VL-AO002,Ao lua trang,150000,${CATEGORY_ID},on_sale`
  ].join("\n"), { ipAddress: "127.0.0.1" });
  assert.equal(result.created, 1);
  assert.equal(received[0].expectedVersion, 0);
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
    expectedVersion: 0
  }, { ipAddress: "127.0.0.1" });
  assert.equal(result.product_id, PRODUCT_ID);
  assert.equal(received[0].sku, "VL-AO001");
  assert.equal(received[1], "valid-token");
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
