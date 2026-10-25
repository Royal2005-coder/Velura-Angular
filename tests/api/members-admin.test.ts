import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import {
  MEMBER_LOCK_REASON_MIN,
  MEMBER_SORTS,
  MEMBER_WALLET_FILTERS,
  createMemberService,
  mapMemberDatabaseError,
} from "../../apps/api/src/members/member-service.js";
import { handleMemberRoute } from "../../apps/api/src/members/member-router.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";

const ACTOR = "88888888-8888-4888-8888-888888888888";
const MEMBER_ID = "77777777-7777-4777-8777-777777777777";

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

/** Repository giả: ghi lại payload RPC để kiểm tra service gọi đúng hợp đồng 079. */
function repository(response: JsonObject = { rows: [], count: 0 }, error?: unknown) {
  const calls: { overview: number; list: unknown[]; detail: unknown[]; lock: unknown[] } = {
    overview: 0,
    list: [],
    detail: [],
    lock: [],
  };
  const repo = {
    async overview() {
      calls.overview += 1;
      return { members: 129 };
    },
    async list(input: unknown) {
      calls.list.push(input);
      return response;
    },
    async detail(userId: string) {
      calls.detail.push(userId);
      return { user: { user_id: userId } };
    },
    async setAccrualLock(input: unknown) {
      calls.lock.push(input);
      if (error) throw error;
      return { user_id: MEMBER_ID, accrual_locked: false, changed: true };
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

test("only super_admin may read the roster or toggle accrual", async () => {
  const { calls, repo } = repository();
  const service = createMemberService({ repository: repo });

  await service.listMembers(context("super_admin"), new URLSearchParams(""));
  await service.overview(context("super_admin"));
  await service.memberDetail(context("super_admin"), MEMBER_ID);
  assert.equal(calls.list.length, 1);
  assert.equal(calls.detail.length, 1);

  const lockBody = { locked: true, reason: "Xác minh với khách qua hotline 25/10" } as JsonObject;
  const denied = await thrown(() => service.setAccrualLock(context("admin_operator_cskh_dt"), MEMBER_ID, lockBody, { ipAddress: "10.0.0.1" }));
  assert.equal(denied.code, "RBAC_DENIED");
  assert.deepEqual(calls.lock, [], "không được chạm tầng dữ liệu khi không có quyền ghi");

  // Ví điểm là dữ liệu tiền: chỉ super_admin, không mở rộng theo role CSKH/đơn hàng.
  for (const role of ["admin_viewer", "admin_operator_sanpham", "admin_operator_donhang", "admin_operator_gia_km", "admin_operator_cskh_dt", "admin_operator_danhgia_review"]) {
    const readDenied = await thrown(() => service.listMembers(context(role), new URLSearchParams("")));
    assert.equal(readDenied.code, "RBAC_DENIED", role);
  }
  const memberDenied = await thrown(() => service.listMembers(context("member"), new URLSearchParams("")));
  assert.equal(memberDenied.code, "ADMIN_REQUIRED", "thành viên không phải admin");
});

test("list filters are validated against the same vocabulary the RPC accepts", async () => {
  const { calls, repo } = repository({ rows: [{ user_id: MEMBER_ID }], count: 1 });
  const service = createMemberService({ repository: repo });

  const listed = await service.listMembers(
    context("super_admin"),
    new URLSearchParams("wallet=has&q=0900&sort=name&limit=25&offset=50"),
  );
  assert.equal(listed.count, 1);
  assert.deepEqual(calls.list[0], { q: "0900", wallet: "has", sort: "name", limit: 25, offset: 50 });

  const badFilter = await thrown(() => service.listMembers(context("super_admin"), new URLSearchParams("wallet=everything")));
  assert.equal(badFilter.status, 422);
  assert.equal(badFilter.code, "MEMBER_FILTER_INVALID");

  const badSort = await thrown(() => service.listMembers(context("super_admin"), new URLSearchParams("sort=random")));
  assert.equal(badSort.code, "MEMBER_SORT_INVALID");
  assert.equal(calls.list.length, 1, "bộ lọc sai không được gọi RPC");
});

test("an invalid member id never reaches the database", async () => {
  const { calls, repo } = repository();
  const service = createMemberService({ repository: repo });

  const error = await thrown(() => service.memberDetail(context("super_admin"), "not-a-uuid"));
  assert.equal(error.status, 422);
  const lock = await thrown(() =>
    service.setAccrualLock(context("super_admin"), "not-a-uuid", { locked: true, reason: "Xác minh với khách" } as JsonObject, {
      ipAddress: "10.0.0.1",
    }),
  );
  assert.equal(lock.status, 422);
  assert.deepEqual(calls.detail, []);
  assert.deepEqual(calls.lock, []);
});

test("locking accrual requires the state and an auditable reason", async () => {
  const { calls, repo } = repository();
  const service = createMemberService({ repository: repo });

  const missingState = await thrown(() =>
    service.setAccrualLock(context("super_admin"), MEMBER_ID, { reason: "Xác minh với khách qua hotline" } as JsonObject, {
      ipAddress: "10.0.0.1",
    }),
  );
  assert.equal(missingState.status, 422);

  const shortReason = await thrown(() =>
    service.setAccrualLock(context("super_admin"), MEMBER_ID, { locked: true, reason: "ngắn" } as JsonObject, {
      ipAddress: "10.0.0.1",
    }),
  );
  assert.equal(shortReason.code, "VALIDATION_ERROR");
  assert.ok((shortReason.details as Record<string, string[]>).reason);
  assert.deepEqual(calls.lock, []);

  await service.setAccrualLock(
    context("super_admin"),
    MEMBER_ID,
    { locked: true, reason: "  Xác minh với khách qua hotline 25/10  " } as JsonObject,
    { ipAddress: "203.0.113.9" },
  );
  assert.deepEqual(calls.lock[0], {
    userId: MEMBER_ID,
    locked: true,
    reason: "Xác minh với khách qua hotline 25/10",
    ipAddress: "203.0.113.9",
  });
});

test("database refusals become stable, actionable HTTP errors", async () => {
  const notFound = new HttpError(400, "SUPABASE_ERROR", "MEMBER_NOT_FOUND [status:400]", { message: "MEMBER_NOT_FOUND" });
  const { repo } = repository({}, notFound);
  const service = createMemberService({ repository: repo });
  const error = await thrown(() =>
    service.setAccrualLock(context("super_admin"), MEMBER_ID, { locked: true, reason: "Xác minh với khách" } as JsonObject, {
      ipAddress: "10.0.0.1",
    }),
  );
  assert.equal(error.status, 404);
  assert.equal(error.code, "MEMBER_NOT_FOUND");
  assert.match(error.message, /không tìm thấy/i);

  const reason = new HttpError(400, "SUPABASE_ERROR", "MEMBER_LOCK_REASON_REQUIRED [status:400]", {
    message: "MEMBER_LOCK_REASON_REQUIRED",
  });
  assert.equal(mapMemberDatabaseError(reason).status, 422);

  const other = new HttpError(400, "SUPABASE_ERROR", "boom [status:400]", { message: "SOMETHING_NEW" });
  assert.equal(mapMemberDatabaseError(other), other);
  assert.equal(mapMemberDatabaseError("plain"), "plain");
});

test("router claims only /api/v1/admin/members and maps verbs to services", async () => {
  const seen: string[] = [];
  const service = {
    async overview() {
      seen.push("overview");
      return { members: 129 };
    },
    async listMembers() {
      seen.push("list");
      return { rows: [], count: 0 };
    },
    async memberDetail(_context: AuthContext | undefined, id: string) {
      seen.push(`detail:${id}`);
      return { user: { user_id: id } };
    },
    async setAccrualLock(_context: AuthContext | undefined, id: string, body: JsonObject) {
      seen.push(`lock:${id}:${String(body.locked)}`);
      return { user_id: id, changed: true };
    },
  } as never;

  async function call(method: string, parts: string[], body?: unknown) {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end() {},
      setHeader() {},
    };
    const req = { method, headers: { "x-forwarded-for": "10.0.0.9" }, socket: {}, body: body ?? {} };
    const handled = await handleMemberRoute({
      req: req as never,
      res: res as never,
      url: new URL("http://localhost/api/v1/admin/members"),
      parts,
      headers: {},
      context: context("super_admin"),
      service,
    });
    return { handled, status };
  }

  assert.equal((await call("GET", ["api", "v1", "admin", "orders"])).handled, false);
  assert.equal((await call("GET", ["api", "v1", "admin", "members", "overview", "extra"])).handled, false);
  assert.equal((await call("DELETE", ["api", "v1", "admin", "members", MEMBER_ID])).handled, false);
  assert.equal((await call("GET", ["api", "v1", "admin", "members"])).handled, true);
  assert.equal((await call("GET", ["api", "v1", "admin", "members", "overview"])).handled, true);
  assert.equal((await call("GET", ["api", "v1", "admin", "members", MEMBER_ID])).handled, true);
  assert.equal((await call("POST", ["api", "v1", "admin", "members", MEMBER_ID, "accrual-lock"], { locked: true })).handled, true);
  assert.deepEqual(seen, ["list", "overview", `detail:${MEMBER_ID}`, `lock:${MEMBER_ID}:true`]);
});

test("migration 079 and the TypeScript service speak the same contract", async () => {
  const sql = await readFile(new URL("../../database/migrations/079_members_loyalty_baseline.sql", import.meta.url), "utf8");
  for (const fn of ["admin_member_overview", "admin_list_members", "admin_member_detail", "admin_set_member_accrual_lock"]) {
    assert.ok(sql.includes(`function public.${fn}(`), `079 thiếu ${fn}`);
  }
  for (const filter of MEMBER_WALLET_FILTERS) {
    assert.ok(sql.includes(`'${filter}'`), `079 thiếu bộ lọc ${filter}`);
  }
  for (const sort of MEMBER_SORTS) {
    assert.ok(sql.includes(`'${sort}'`), `079 thiếu cách sắp xếp ${sort}`);
  }
  assert.ok(sql.includes(`length(btrim(coalesce(p_reason, ''))) < ${MEMBER_LOCK_REASON_MIN}`), "ngưỡng lý do phải khớp");
  assert.ok(sql.includes("velura_append_module_audit(\n    'members'"), "audit phải ghi module members");
  assert.ok(sql.includes("grant execute on function public.admin_list_members(text, text, text, integer, integer) to authenticated"));

  const repoSource = await readFile(new URL("../../apps/api/src/members/member-repository.ts", import.meta.url), "utf8");
  for (const param of ["p_q", "p_wallet", "p_sort", "p_limit", "p_offset", "p_user_id", "p_locked", "p_reason", "p_ip_address"]) {
    assert.ok(repoSource.includes(`${param}:`), `repository thiếu tham số ${param}`);
  }
});
