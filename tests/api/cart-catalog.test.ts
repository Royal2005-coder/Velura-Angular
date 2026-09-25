import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCartLines,
  buildCategoryTree,
  parseCartItems,
  type CatalogEntry
} from "../../apps/api/src/user/cart-catalog.js";

const categories = [
  { category_id: "ao", name: "Áo", parent_id: null },
  { category_id: "ao-somi", name: "Áo sơ mi", parent_id: "ao" },
  { category_id: "ao-somi-lua", name: "Sơ mi lụa", parent_id: "ao-somi" },
  { category_id: "quan", name: "Quần", parent_id: null }
];

test("đường danh mục đi từ danh mục của sản phẩm lên tới gốc", () => {
  const tree = buildCategoryTree(categories);
  assert.deepEqual(tree.pathById.get("ao-somi-lua"), ["ao-somi-lua", "ao-somi", "ao"]);
  assert.deepEqual(tree.pathById.get("quan"), ["quan"]);
  assert.equal(tree.nameById["ao-somi"], "Áo sơ mi");
});

test("dữ liệu danh mục trỏ vòng không làm treo yêu cầu", () => {
  const tree = buildCategoryTree([
    { category_id: "a", name: "A", parent_id: "b" },
    { category_id: "b", name: "B", parent_id: "a" }
  ]);
  assert.deepEqual(tree.pathById.get("a"), ["a", "b"]);
  assert.deepEqual(tree.pathById.get("b"), ["b", "a"]);
});

test("dòng hàng tính theo giá catalog và mang đường danh mục của sản phẩm", () => {
  const tree = buildCategoryTree(categories);
  const catalog = new Map<string, CatalogEntry>([
    ["v-somi", { variantId: "v-somi", unitPrice: 150000, productName: "Sơ mi", categoryId: "ao-somi-lua" }],
    ["v-quan", { variantId: "v-quan", unitPrice: 500000, productName: "Quần", categoryId: "quan" }]
  ]);
  const { lines, orderValue } = buildCartLines(
    [{ variantId: "v-somi", quantity: 2 }, { variantId: "v-quan", quantity: 1 }, { variantId: "v-lạ", quantity: 1 }],
    catalog,
    tree
  );
  assert.equal(orderValue, 800000, "biến thể không có trong catalog bị bỏ qua");
  assert.deepEqual(lines[0], { categoryPath: ["ao-somi-lua", "ao-somi", "ao"], lineTotal: 300000 });
});

test("dòng hàng nhận cả dạng mảng lẫn dạng chuỗi gọn trên query string", () => {
  assert.deepEqual(
    parseCartItems([{ variant_id: "v1", quantity: 2 }, { variant_id: "", quantity: 1 }, { variant_id: "v2", quantity: 0 }]),
    [{ variantId: "v1", quantity: 2 }]
  );
  assert.deepEqual(parseCartItems("v1:2,v2:1,:3"), [
    { variantId: "v1", quantity: 2 },
    { variantId: "v2", quantity: 1 }
  ]);
  assert.deepEqual(parseCartItems(null), []);
});
