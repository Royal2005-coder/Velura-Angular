import test from "node:test";
import assert from "node:assert/strict";
import { aiOwner } from "../../apps/api/src/ai/ai-router.js";
import { filterCatalogProducts } from "../../apps/api/src/user/catalog-search.js";
import { rankVisualMatches } from "../../apps/api/src/visual-search/visual-search-service.js";
import type { VisualCandidate } from "../../apps/api/src/visual-search/visual-search-types.js";
import { extractQueryAttributes } from "../../apps/api/src/ai-search/ai-search-text.js";
import type { HttpRequest, AuthContext } from "../../apps/api/src/types.js";

test("aiOwner: accepts guest session without authorization and rejects invalid authorization", () => {
  const guestReq: HttpRequest = {
    method: "POST",
    url: "/api/user/ai-search/text",
    headers: {
      "x-guest-session-id": "gs_12345678-1234-4123-8123-123456789abc"
    }
  };
  const context: AuthContext = { authUser: null };
  const owner = aiOwner(guestReq, context);
  assert.equal(owner, "guest:gs_12345678-1234-4123-8123-123456789abc");

  const invalidAuthReq: HttpRequest = {
    method: "POST",
    url: "/api/user/ai-search/text",
    headers: {
      authorization: "Bearer expired.invalid.token",
      "x-guest-session-id": "gs_12345678-1234-4123-8123-123456789abc"
    }
  };
  assert.throws(() => aiOwner(invalidAuthReq, context), { code: "AUTH_REQUIRED" });
});
test("SHOP-01: Searching 'Váy' does not match shoes/accessories cross-referencing váy in description", () => {
  const products = [
    {
      product_id: "dress-01",
      name: "Đầm Dạ Hội Ren Cao Cấp",
      category_name: "Đầm & Váy",
      category_slug: "dam-vay",
      description: "Thiết kế đầm dạ hội sang trọng cho các buổi tiệc tối."
    },
    {
      product_id: "dress-02",
      name: "Váy Xòe Vintage Nữ Tính",
      category_name: "Đầm & Váy",
      category_slug: "dam-vay",
      description: "Chất liệu lụa mềm mại, tôn dáng hoàn hảo."
    },
    {
      product_id: "shoe-01",
      name: "Giày Cao Gót Da Bóng",
      category_name: "Giày dép",
      category_slug: "giay-dep",
      description: "Giày cao gót 7cm, phù hợp phối cùng váy đầm dạ tiệc thanh lịch."
    },
    {
      product_id: "bag-01",
      name: "Túi Xách Mini Cầm Tay",
      category_name: "Phụ kiện",
      category_slug: "phu-kien",
      description: "Túi xách nhỏ xinh, thích hợp mang cùng váy dạo phố."
    }
  ];

  const filtered = filterCatalogProducts(products, { query: "Váy", category: "", material: "" });
  const ids = filtered.map(p => p.product_id);

  assert.ok(ids.includes("dress-01"), "Should include dress-01 (category Đầm & Váy)");
  assert.ok(ids.includes("dress-02"), "Should include dress-02 (name Váy Xòe)");
  assert.ok(!ids.includes("shoe-01"), "Should NOT include shoe-01 matching only in description");
  assert.ok(!ids.includes("bag-01"), "Should NOT include bag-01 matching only in description");
});

test("Compound search: 'váy đỏ tay dài' rejects short sleeves, pink dress, and shirts", () => {
  const products = [
    {
      product_id: "dress-red-long",
      name: "Đầm Dạ Hội Đỏ Tay Dài",
      category_name: "Đầm & Váy",
      category_slug: "dam-vay",
      description: "Đầm đỏ tay dài thanh lịch cho các buổi tiệc."
    },
    {
      product_id: "dress-pink-short",
      name: "Đầm Tweed Ngắn Tay Cổ Sơ Mi",
      category_name: "Đầm & Váy",
      category_slug: "dam-vay",
      description: "Thông số kỹ thuật: Độ dài đầm 85cm."
    },
    {
      product_id: "dress-sakura-pink",
      name: "Đầm Tay Bồng Cổ Bèo Đính Hoa Hồng Sakura",
      category_name: "Đầm & Váy",
      category_slug: "dam-vay",
      description: "Màu hồng pastel ngọt ngào. Độ dài đầm 80cm."
    },
    {
      product_id: "shirt-ivory-long",
      name: "Áo Sơ Mi Lụa Tay Dài Ivory",
      category_name: "Áo",
      category_slug: "ao",
      description: "Áo sơ mi lụa tay dài, phối cùng chân váy công sở."
    }
  ];

  const filtered = filterCatalogProducts(products, { query: "váy đỏ tay dài", category: "", material: "" });
  const ids = filtered.map(p => p.product_id);

  assert.ok(ids.includes("dress-red-long"), "Red long-sleeve dress must match");
  assert.ok(!ids.includes("dress-pink-short"), "Short sleeve dress must NOT match 'tay dài'");
  assert.ok(!ids.includes("dress-sakura-pink"), "Pink dress must NOT match 'đỏ' (do dai is not do)");
  assert.ok(!ids.includes("shirt-ivory-long"), "Shirt must NOT match 'váy' category query");
});

test("Garment Category Isolation: rankVisualMatches excludes disjoint accessories when category is dam-vay", () => {
  const candidates: VisualCandidate[] = [
    {
      product_id: "dress-01",
      similarity: 0.28,
      status: "on_sale",
      category_slug: "dam-vay",
      name: "Đầm Xòe Hoa Nhí"
    },
    {
      product_id: "shoe-01",
      similarity: 0.29,
      status: "on_sale",
      category_slug: "giay-dep",
      name: "Giày Cao Gót Nữ"
    },
    {
      product_id: "bag-01",
      similarity: 0.26,
      status: "on_sale",
      category_slug: "phu-kien",
      name: "Túi Đeo Chéo"
    }
  ];

  const matches = rankVisualMatches(candidates, null, 0.22, 0.30, { category: "dam-vay" });
  const ids = matches.map(m => m.product_id);

  assert.ok(ids.includes("dress-01"), "Dress must be included");
  assert.ok(!ids.includes("shoe-01"), "Shoe must be excluded by category isolation");
  assert.ok(!ids.includes("bag-01"), "Bag must be excluded by category isolation");
});

test("Attribute-Aware Boost: Product matching color and sleeve surfaces to the top", () => {
  const candidates: VisualCandidate[] = [
    {
      product_id: "dress-short-sleeve-black",
      similarity: 0.26,
      status: "on_sale",
      category_slug: "dam-vay",
      color_tone: "đen",
      name: "Đầm Suông Tay Ngắn"
    },
    {
      product_id: "dress-long-sleeve-red",
      similarity: 0.25,
      status: "on_sale",
      category_slug: "dam-vay",
      color_tone: "đỏ",
      name: "Đầm Xòe Tay Dài Màu Đỏ"
    }
  ];

  const matches = rankVisualMatches(candidates, null, 0.22, 0.30, {
    category: "dam-vay",
    color: "đỏ",
    sleeve: "tay dài"
  });

  assert.equal(matches[0].product_id, "dress-long-sleeve-red", "Red long-sleeve dress must rank first due to attribute boost");
  assert.equal(matches[1].product_id, "dress-short-sleeve-black", "Short-sleeve black dress ranks second");
});

test("Multimodal text modifier: sleeve phrases like 'tay dài' or 'màu đỏ tay dài' never misclassify as pants (quan)", () => {
  const sleeveOnly = extractQueryAttributes("tay dài");
  assert.equal(sleeveOnly.category, undefined, "'tay dài' must not set category to 'quan'");
  assert.equal(sleeveOnly.sleeve, "tay dài");

  const colorSleeve = extractQueryAttributes("màu đỏ tay dài");
  assert.equal(colorSleeve.category, undefined, "'màu đỏ tay dài' must not set category to 'quan'");
  assert.equal(colorSleeve.color, "đỏ");
  assert.equal(colorSleeve.sleeve, "tay dài");

  const realPants = extractQueryAttributes("quần tây đen");
  assert.equal(realPants.category, "quan");
  assert.equal(realPants.color, "đen");
});
