import test from "node:test";
import assert from "node:assert/strict";
import { createAuditLogService, parseAuditLogFilters } from "../../apps/api/src/audit-logs/audit-log-service.js";
import { SEARCH_SCAN_LIMIT } from "../../apps/api/src/search-text.js";

test("parseAuditLogFilters maps admin scope onto the canonical module list", () => {
  const filters = parseAuditLogFilters(new URLSearchParams("scope=admin&limit=10&offset=20"));
  assert.equal(filters.module, undefined);
  assert.deepEqual(filters.modules, [
    "accounts",
    "products",
    "orders",
    "pricing",
    "promotions",
    "vouchers",
    "returns",
    "reviews",
    "support",
    "content",
    "members"
  ]);
  assert.equal(filters.limit, 10);
  assert.equal(filters.offset, 20);
});

test("parseAuditLogFilters maps system scope onto system and auth modules", () => {
  const filters = parseAuditLogFilters(new URLSearchParams("scope=system"));
  assert.equal(filters.module, undefined);
  assert.deepEqual(filters.modules, ["system", "auth"]);
});

test("parseAuditLogFilters maps ai scope onto the ai module", () => {
  const filters = parseAuditLogFilters(new URLSearchParams("scope=ai"));
  assert.equal(filters.module, "ai");
  assert.equal(filters.modules, undefined);
});

test("parseAuditLogFilters prefers an explicit module over scope", () => {
  const filters = parseAuditLogFilters(new URLSearchParams("module=orders&scope=admin&q=lock"));
  assert.equal(filters.module, "orders");
  assert.equal(filters.modules, undefined);
  assert.equal(filters.q, "lock");
});

test("parseAuditLogFilters rejects an invalid module or scope", () => {
  assert.throws(
    () => parseAuditLogFilters(new URLSearchParams("module=Orders!")),
    (error: { status?: number }) => error.status === 422
  );
  assert.throws(
    () => parseAuditLogFilters(new URLSearchParams("scope=finance")),
    (error: { status?: number }) => error.status === 422
  );
});

test("audit log service denies a non-admin before repository access", async () => {
  let called = false;
  const service = createAuditLogService({
    repository: {
      list: async () => {
        called = true;
        return { rows: [], count: 0 };
      }
    }
  });
  await assert.rejects(
    () =>
      service.list(
        { authUser: { id: "u1" }, profile: { is_active: true }, isAdmin: false, accessToken: "t" },
        new URLSearchParams()
      ),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  assert.equal(called, false);
});

test("audit log service denies an active admin whose role cannot read audit logs", async () => {
  let called = false;
  const service = createAuditLogService({
    repository: {
      list: async () => {
        called = true;
        return { rows: [], count: 0 };
      }
    }
  });
  await assert.rejects(
    () =>
      service.list(
        { authUser: { id: "u2" }, profile: { is_active: true }, isAdmin: true, roleCode: "admin_viewer", accessToken: "t" },
        new URLSearchParams()
      ),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  assert.equal(called, false);
});

test("a specialist role cannot read the accounts audit module (TC_ACC_02/16)", async () => {
  let called = false;
  const service = createAuditLogService({
    repository: {
      list: async () => {
        called = true;
        return { rows: [], count: 0 };
      }
    }
  });
  const context = {
    authUser: { id: "u3" },
    profile: { is_active: true },
    isAdmin: true,
    roleCode: "admin_operator_sanpham",
    allowedModules: ["products", "categories", "inventory", "audit_logs"],
    capabilities: { audit_logs: ["read" as const] },
    accessToken: "t"
  };
  await assert.rejects(
    () => service.list(context, new URLSearchParams("module=accounts")),
    (error: { status?: number }) => error.status === 403
  );
  assert.equal(called, false);
});

test("an unscoped audit list is narrowed to the role's own modules", async () => {
  let received: { modules?: string[]; q?: string; limit?: number } = {};
  const service = createAuditLogService({
    repository: {
      list: async (filters) => {
        received = { modules: filters.modules, q: filters.q, limit: filters.limit };
        return { rows: [], count: 0 };
      }
    }
  });
  const context = {
    authUser: { id: "u4" },
    profile: { is_active: true },
    isAdmin: true,
    roleCode: "admin_operator_sanpham",
    allowedModules: ["products", "categories", "inventory", "audit_logs"],
    capabilities: { audit_logs: ["read" as const] },
    accessToken: "t"
  };

  await service.list(context, new URLSearchParams("scope=admin"));
  assert.deepEqual(received.modules, ["products"]);

  await service.list(context, new URLSearchParams("q=lock"));
  assert.equal(received.q, undefined, "the query is folded in memory, never sent as ilike");
  assert.equal(received.limit, SEARCH_SCAN_LIMIT);
});

test("parseAuditLogFilters validates the time range and keeps the actor filter", () => {
  const filters = parseAuditLogFilters(new URLSearchParams("from=2026-11-01&to=2026-11-30&actor=uat.sanpham"));
  assert.equal(filters.from, new Date("2026-11-01").toISOString());
  assert.equal(filters.to, new Date("2026-11-30").toISOString());
  assert.equal(filters.actor, "uat.sanpham");
  assert.throws(
    () => parseAuditLogFilters(new URLSearchParams("from=not-a-date")),
    (error: { status?: number }) => error.status === 422
  );
});
