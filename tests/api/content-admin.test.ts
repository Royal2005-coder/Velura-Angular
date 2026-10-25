import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import { createContentAdminService, mapContentDatabaseError } from "../../apps/api/src/content/content-admin-service.js";
import { handleContentAdminRoute } from "../../apps/api/src/content/content-admin-router.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";

const ACTOR = "88888888-8888-4888-8888-888888888888";
const BLOG_ID = "99999999-9999-4999-8999-999999999999";

function context(roleCode: string): AuthContext {
  const access = accessForRole(roleCode);
  const isMember = roleCode === "member";
  return {
    authUser: { id: ACTOR },
    profile: { user_id: ACTOR, role: isMember ? "member" : "admin", admin_role: roleCode, is_active: true },
    roleCode,
    roleName: roleCode,
    isAdmin: !isMember,
    allowedPages: access.allowedPages,
    allowedModules: access.allowedModules,
    capabilities: access.capabilities,
    accessToken: "member-token",
  } as AuthContext;
}

const validDraft = {
  slug: "ao-lua-ha-noi",
  title: "Áo lụa Hà Nội: chất liệu và cách chọn size",
  categorySlug: "blog-cham-soc",
  content: "Bài viết dài đủ điều kiện biên tập của Velura, có hướng dẫn cụ thể cho khách khi chọn size.",
  excerpt: "Guide ngắn",
  status: "draft",
  readMinutes: 4,
};

/** Repository giả: ghi lại payload RPC để kiểm tra cách service gọi tầng dữ liệu. */
function repository(response: JsonObject = { blog_id: BLOG_ID, version: 2 }, error?: unknown) {
  const calls: { list: unknown[]; upsert: unknown[] } = { list: [], upsert: [] };
  const repo = {
    async listBlogs(input: unknown) {
      calls.list.push(input);
      return { rows: [], count: 0 };
    },
    async upsertBlog(input: unknown) {
      calls.upsert.push(input);
      if (error) throw error;
      return response;
    },
  };
  return { calls, repo: repo as never };
}

async function thrown(operation: () => Promise<unknown>): Promise<HttpError> {
  try {
    await operation();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("Expected the call to fail");
}

test("only super_admin may read or edit CMS content", async () => {
  const { calls, repo } = repository();
  const service = createContentAdminService({ repository: repo });
  const params = new URLSearchParams("status=draft&q=lua&limit=10&offset=0");

  for (const role of ["admin_viewer", "admin_operator_cskh_dt", "admin_operator_donhang", "admin_operator_sanpham", "admin_operator_gia_km"]) {
    const denied = await thrown(() => service.listBlogs(context(role), params));
    assert.equal(denied.code, "RBAC_DENIED", role);
    const writeDenied = await thrown(() => service.createBlog(context(role), validDraft as JsonObject, { ipAddress: "10.0.0.1" }));
    assert.equal(writeDenied.code, "RBAC_DENIED", role);
  }
  assert.deepEqual(calls.list, [], "không được chạm tầng dữ liệu khi không có quyền");

  const allowed = await service.listBlogs(context("super_admin"), params);
  assert.deepEqual(allowed, { rows: [], count: 0 });
  assert.deepEqual(calls.list[0], { status: "draft", search: "lua", limit: 10, offset: 0 });
});

test("invalid drafts are rejected in the service before any RPC runs", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["slug", { ...validDraft, slug: "Áo Lụa Hà Nội" }],
    ["title", { ...validDraft, title: "a" }],
    ["categorySlug", { ...validDraft, categorySlug: "  " }],
    ["content", { ...validDraft, content: "quá ngắn" }],
    ["status", { ...validDraft, status: "live" }],
    ["status", { ...validDraft, status: "archived" }],
  ];
  for (const [field, body] of cases) {
    const { calls, repo } = repository();
    const service = createContentAdminService({ repository: repo });
    const error = await thrown(() => service.createBlog(context("super_admin"), body as JsonObject, { ipAddress: "10.0.0.1" }));
    assert.equal(error.code, "CONTENT_VALIDATION", `${field} ${JSON.stringify(body[field])}`);
    assert.ok((error.details as Record<string, string>)[field], `lỗi phải trỏ đúng trường ${field}`);
    assert.deepEqual(calls.upsert, []);
  }
});

test("an edit must carry the version the operator loaded", async () => {
  const { calls, repo } = repository();
  const service = createContentAdminService({ repository: repo });
  const missing = await thrown(() =>
    service.updateBlog(context("super_admin"), BLOG_ID, { ...validDraft } as JsonObject, { ipAddress: "10.0.0.1" }),
  );
  assert.equal(missing.code, "CONTENT_VALIDATION");

  const badId = await thrown(() =>
    service.updateBlog(context("super_admin"), "not-a-uuid", { ...validDraft, expectedVersion: 3 } as JsonObject, { ipAddress: "10.0.0.1" }),
  );
  assert.equal(badId.status, 422);

  await service.updateBlog(context("super_admin"), BLOG_ID, { ...validDraft, expectedVersion: 3 } as JsonObject, { ipAddress: "10.0.0.1" });
  assert.equal((calls.upsert[0] as Record<string, unknown>).blogId, BLOG_ID);
  assert.equal((calls.upsert[0] as Record<string, unknown>).expectedVersion, 3);
});

test("a slug collision surfaces as a stable 409 with an actionable message", async () => {
  const taken = new HttpError(400, "SUPABASE_ERROR", "BLOG_SLUG_TAKEN [status:400]", { message: "BLOG_SLUG_TAKEN" });
  const { repo } = repository({}, taken);
  const service = createContentAdminService({ repository: repo });
  const error = await thrown(() => service.createBlog(context("super_admin"), validDraft as JsonObject, { ipAddress: "10.0.0.1" }));
  assert.equal(error.status, 409);
  assert.equal(error.code, "BLOG_SLUG_TAKEN");
  assert.match(error.message, /slug/i);
});

test("unknown database errors keep their shape instead of being renamed", () => {
  const other = new HttpError(400, "SUPABASE_ERROR", "boom [status:400]", { message: "SOMETHING_NEW" });
  assert.equal(mapContentDatabaseError(other), other);
  assert.equal(mapContentDatabaseError("plain"), "plain");
});

test("router claims only /api/v1/admin/content/blogs and maps verbs to services", async () => {
  const seen: string[] = [];
  const service = {
    async listBlogs() {
      seen.push("list");
      return { rows: [], count: 0 };
    },
    async createBlog() {
      seen.push("create");
      return { blog_id: BLOG_ID };
    },
    async updateBlog(_context: AuthContext | undefined, id: string) {
      seen.push(`update:${id}`);
      return { blog_id: id };
    },
  } as never;

  async function call(method: string, parts: string[], body?: unknown) {
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end() {},
      setHeader() {},
    };
    const req = {
      method,
      headers: { "x-forwarded-for": "10.0.0.9" },
      socket: {},
      body: body ?? {},
    };
    const handled = await handleContentAdminRoute({
      req: req as never,
      res: res as never,
      url: new URL("http://localhost/api/v1/admin/content/blogs"),
      parts,
      headers: {},
      context: context("super_admin"),
      service,
    });
    return { handled, status };
  }

  assert.equal((await call("GET", ["api", "v1", "admin", "products"])).handled, false);
  assert.equal((await call("GET", ["api", "v1", "admin", "content", "policies"])).handled, false);
  assert.equal((await call("GET", ["api", "v1", "admin", "content", "blogs"])).handled, true);
  assert.equal((await call("POST", ["api", "v1", "admin", "content", "blogs"], validDraft)).handled, true);
  assert.equal((await call("PATCH", ["api", "v1", "admin", "content", "blogs", BLOG_ID], validDraft)).handled, true);
  assert.equal((await call("DELETE", ["api", "v1", "admin", "content", "blogs", BLOG_ID])).handled, false, "không có xoá vật lý");
  assert.deepEqual(seen, ["list", "create", `update:${BLOG_ID}`]);
});
