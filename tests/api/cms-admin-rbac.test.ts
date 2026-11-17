import assert from "node:assert/strict";
import test from "node:test";
import { handleBannerRoute } from "../../apps/api/src/banners/banner-router.js";
import { handleCollectionRoute } from "../../apps/api/src/collections/collection-router.js";
import { handleAdminMediaUpload } from "../../apps/api/src/content/media-upload.js";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import type { AuthContext } from "../../apps/api/src/types.js";

const ACTOR = "88888888-8888-4888-8888-888888888888";

function context(roleCode: string): AuthContext {
  const access = accessForRole(roleCode);
  return {
    authUser: { id: ACTOR },
    profile: { user_id: ACTOR, role: "admin", admin_role: roleCode, is_active: true },
    roleCode,
    roleName: roleCode,
    isAdmin: true,
    allowedPages: access.allowedPages,
    allowedModules: access.allowedModules,
    capabilities: access.capabilities,
    accessToken: "token",
  } as AuthContext;
}

const DENIED_ROLES = ["admin_viewer", "admin_operator_sanpham", "admin_operator_donhang", "admin_operator_gia_km"];

/** Dịch vụ giả: mọi lệnh gọi thành công và ghi lại tên thao tác. */
function fakeServices(seen: string[]) {
  const row = { collection_id: "c-1", banner_id: "b-1" };
  const collection = {
    async listPublicCollections() { seen.push("public"); return []; },
    async listAdminCollections() { seen.push("list"); return []; },
    async getCollection() { seen.push("get"); return row; },
    async createCollection() { seen.push("create"); return row; },
    async updateCollection() { seen.push("update"); return row; },
    async deleteCollection() { seen.push("delete"); return { success: true }; },
  };
  const banner = {
    async listPublicBanners() { seen.push("public"); return []; },
    async listAdminBanners() { seen.push("list"); return []; },
    async getBanner() { seen.push("get"); return row; },
    async createBanner() { seen.push("create"); return row; },
    async updateBanner() { seen.push("update"); return row; },
    async deleteBanner() { seen.push("delete"); return { success: true }; },
  };
  return { collection: collection as never, banner: banner as never };
}

function fakeReqRes(method: string, body: unknown = {}) {
  const out = { status: 0 };
  const res = {
    writeHead(code: number) { out.status = code; },
    end() {},
    setHeader() {},
  };
  const req = { method, headers: { "x-forwarded-for": "10.0.0.9" }, socket: {}, body };
  return { req: req as never, res: res as never, out };
}

type Kind = "collections" | "banners";

async function callAdmin(kind: Kind, role: string, method: string, id?: string) {
  const seen: string[] = [];
  const { collection, banner } = fakeServices(seen);
  const { req, res, out } = fakeReqRes(method, kind === "collections" ? { name: "N", code: "c", story_desc: "d" } : { title: "T" });
  const parts = ["api", "v1", "admin", kind, ...(id ? [id] : [])];
  const url = new URL(`http://localhost/${parts.join("/")}`);
  const args = { req, res, url, parts, context: context(role), headers: {} };
  const handled =
    kind === "collections"
      ? await handleCollectionRoute({ ...args, service: collection })
      : await handleBannerRoute({ ...args, service: banner });
  return { handled, seen, status: out.status };
}

function isRbacDenied(err: unknown): boolean {
  return err instanceof HttpError && err.status === 403 && err.code === "RBAC_DENIED";
}

for (const kind of ["collections", "banners"] as const) {
  test(`${kind}: roles without the content module get 403 RBAC_DENIED on every admin verb`, async () => {
    for (const role of DENIED_ROLES) {
      for (const [method, id] of [["GET", undefined], ["GET", "x-1"], ["POST", undefined], ["PUT", "x-1"], ["PATCH", "x-1"], ["DELETE", "x-1"]] as const) {
        await assert.rejects(callAdmin(kind, role, method, id), isRbacDenied, `${role} ${method}`);
      }
    }
  });

  test(`${kind}: super_admin can read, create, update and delete`, async () => {
    const list = await callAdmin(kind, "super_admin", "GET");
    assert.deepEqual([list.handled, list.status, list.seen], [true, 200, ["list"]]);
    const get = await callAdmin(kind, "super_admin", "GET", "x-1");
    assert.deepEqual([get.handled, get.status, get.seen], [true, 200, ["get"]]);
    const create = await callAdmin(kind, "super_admin", "POST");
    assert.deepEqual([create.handled, create.status, create.seen], [true, 201, ["create"]]);
    const update = await callAdmin(kind, "super_admin", "PUT", "x-1");
    assert.deepEqual([update.handled, update.status, update.seen], [true, 200, ["update"]]);
    const del = await callAdmin(kind, "super_admin", "DELETE", "x-1");
    assert.deepEqual([del.handled, del.status, del.seen], [true, 200, ["delete"]]);
  });

  test(`${kind}: public GET stays open to guests`, async () => {
    const seen: string[] = [];
    const { collection, banner } = fakeServices(seen);
    const { req, res, out } = fakeReqRes("GET");
    const parts = ["api", "v1", kind];
    const args = { req, res, url: new URL(`http://localhost/${parts.join("/")}`), parts, context: context("guest"), headers: {} };
    const handled =
      kind === "collections"
        ? await handleCollectionRoute({ ...args, service: collection })
        : await handleBannerRoute({ ...args, service: banner });
    assert.deepEqual([handled, out.status, seen], [true, 200, ["public"]]);
  });
}

test("a guest cannot reach admin collection or banner routes directly", async () => {
  await assert.rejects(callAdmin("collections", "guest", "POST"), (err: unknown) => err instanceof HttpError && err.status === 403);
  await assert.rejects(callAdmin("banners", "guest", "DELETE", "x-1"), (err: unknown) => err instanceof HttpError && err.status === 403);
});

async function callUpload(role: string, query: string, method = "POST") {
  const { req, res } = fakeReqRes(method);
  const parts = ["api", "v1", "admin", "content", "upload-media"];
  return handleAdminMediaUpload({
    req,
    res,
    url: new URL(`http://localhost/${parts.join("/")}${query}`),
    parts,
    context: context(role),
    headers: {},
  });
}

test("upload-media: viewer and operators get 403 RBAC_DENIED before any body is read", async () => {
  for (const role of DENIED_ROLES) {
    await assert.rejects(callUpload(role, "?category=banner"), isRbacDenied, role);
  }
});

test("upload-media: super_admin passes RBAC (method and category checks run next)", async () => {
  await assert.rejects(
    callUpload("super_admin", "?category=banner", "GET"),
    (err: unknown) => err instanceof HttpError && err.status === 405,
  );
  await assert.rejects(
    callUpload("super_admin", "?category=collection"),
    (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === "INVALID_UPLOAD_CATEGORY",
  );
});

test("upload-media: non-upload paths are not handled", async () => {
  const { req, res } = fakeReqRes("POST");
  const parts = ["api", "v1", "admin", "products"];
  const handled = await handleAdminMediaUpload({ req, res, url: new URL("http://localhost/api/v1/admin/products"), parts, context: context("admin_viewer"), headers: {} });
  assert.equal(handled, false);
});
