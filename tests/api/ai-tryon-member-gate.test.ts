import test from "node:test";
import assert from "node:assert/strict";
import { requiresMember, requireAiMember, handleAiRoute } from "../../apps/api/src/ai/ai-router.js";
import { ShopAiCatalog } from "../../apps/api/src/ai/ai-catalog.js";
import { HttpError } from "../../apps/api/src/http.js";
import type { AuthContext, HttpRequest, HttpResponse } from "../../apps/api/src/types.js";

const VALID_MEMBER_CONTEXT: AuthContext = {
  authUser: { id: "member-user-123" },
  profile: {
    user_id: "member-user-123",
    role: "member",
    is_active: true,
  },
  roleCode: "member",
  roleName: "Member",
  isAdmin: false,
  allowedPages: ["home", "products"],
  allowedModules: ["catalog"],
  accessToken: "member-token",
};

const GUEST_CONTEXT: AuthContext = {
  authUser: null,
  profile: null,
  roleCode: "guest",
  roleName: "Guest",
  isAdmin: false,
  allowedPages: ["home", "products"],
  allowedModules: ["catalog"],
  accessToken: "",
};

test("virtual try-on and personal-photo checks require a member; visual search and enhancement do not", () => {
  assert.equal(requiresMember({ task: "virtual_try_on" }), true);
  assert.equal(requiresMember({ task: "image_quality", person_check: true }), true);
  assert.equal(requiresMember({ task: "image_quality" }), false);
  assert.equal(requiresMember({ task: "image_embedding" }), false);
  assert.equal(requiresMember({ task: "product_image_enhance" }), false);
});

test("requireAiMember accepts verified active member and rejects guest, foreign role, inactive, and mismatched identity", () => {
  assert.doesNotThrow(() => requireAiMember(VALID_MEMBER_CONTEXT));

  assert.throws(
    () => requireAiMember(GUEST_CONTEXT),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );

  assert.throws(
    () =>
      requireAiMember({
        ...VALID_MEMBER_CONTEXT,
        profile: { ...VALID_MEMBER_CONTEXT.profile!, is_active: false },
      }),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );

  assert.throws(
    () =>
      requireAiMember({
        ...VALID_MEMBER_CONTEXT,
        authUser: { id: "foreign-user-id" },
      }),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );

  assert.throws(
    () =>
      requireAiMember({
        ...VALID_MEMBER_CONTEXT,
        isAdmin: true,
        roleCode: "super_admin",
      }),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );

  assert.throws(
    () =>
      requireAiMember({
        ...VALID_MEMBER_CONTEXT,
        profile: { ...VALID_MEMBER_CONTEXT.profile!, role: "admin" },
      }),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );
});

test("ShopAiCatalog rejects accessories, shoes, combo, and unmapped variants even if registry says upper_body", async () => {
  const productId = "11111111-1111-4111-8111-111111111111";
  const variantA = "22222222-2222-4222-8222-222222222222";
  const variantB = "33333333-3333-4333-8333-333333333333";

  process.env.AI_CATALOG_IMAGE_HOSTS = "images.shop.test";
  process.env.AI_VTO_PRODUCTS = JSON.stringify({
    [productId]: {
      verified: true,
      photo_type: "flat-lay",
      category: "upper_body",
      variant_images: {
        [variantA]: "https://images.shop.test/garment-a.png",
      },
    },
  });

  const accessoryCatalog = new ShopAiCatalog({
    async product() {
      return { status: "on_sale", category: { slug: "phu-kien" } };
    },
    async variant(_pid, vid) {
      return { variant_id: vid, product_id: productId, stock_quantity: 10 };
    },
    async fetchImage() {
      throw new Error("Must not download");
    },
  });
  const accSupport = await accessoryCatalog.support(productId, variantA);
  assert.equal(accSupport.product_supported, false);
  assert.equal(accSupport.variant_supported, false);

  const comboCatalog = new ShopAiCatalog({
    async product() {
      return { status: "on_sale", is_combo: true, category: { slug: "ao" } };
    },
    async variant(_pid, vid) {
      return { variant_id: vid, product_id: productId };
    },
    async fetchImage() {
      throw new Error("Must not download");
    },
  });
  const comboSupport = await comboCatalog.support(productId, variantA);
  assert.equal(comboSupport.product_supported, false);
  assert.equal(comboSupport.variant_supported, false);

  const clothingCatalog = new ShopAiCatalog({
    async product() {
      return { status: "on_sale", is_combo: false, category: { slug: "ao" } };
    },
    async variant(_pid, vid) {
      if (vid === variantA) return { variant_id: vid, product_id: productId, stock_quantity: 0 };
      if (vid === variantB) return { variant_id: vid, product_id: "other-product-id" };
      return null;
    },
    async fetchImage() {
      throw new Error("Must not download");
    },
  });

  const mappedSupport = await clothingCatalog.support(productId, variantA);
  assert.equal(mappedSupport.product_supported, true);
  assert.equal(mappedSupport.variant_supported, true);
  assert.equal(mappedSupport.garment_category, "upper_body");

  const unmappedSupport = await clothingCatalog.support(productId, "44444444-4444-4444-8444-444444444444");
  assert.equal(unmappedSupport.product_supported, true);
  assert.equal(unmappedSupport.variant_supported, false);

  const foreignSupport = await clothingCatalog.support(productId, variantB);
  assert.equal(foreignSupport.product_supported, true);
  assert.equal(foreignSupport.variant_supported, false);
});

test("handleAiRoute rejects guest uploads and try-on jobs before processing or image reads", async () => {
  const mockReq: HttpRequest = {
    method: "POST",
    url: "/api/user/ai/uploads",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      "x-guest-session-id": "gs_11111111-1111-4111-8111-111111111111",
    },
  };
  const mockRes: HttpResponse = {
    writeHead: () => mockRes,
    setHeader: () => mockRes,
    end: () => mockRes,
  };

  await assert.rejects(
    () =>
      handleAiRoute(
        mockReq,
        mockRes,
        ["api", "user", "ai", "uploads"],
        {},
        GUEST_CONTEXT,
      ),
    (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "MEMBER_REQUIRED",
  );
});
