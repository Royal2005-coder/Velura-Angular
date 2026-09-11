import test from "node:test";
import assert from "node:assert/strict";
import { createAuditLogService, parseAuditLogFilters } from "../../apps/api/src/audit-logs/audit-log-service.js";

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
    "support"
  ]);
  assert.equal(filters.limit, 10);
  assert.equal(filters.offset, 20);
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

test("audit log service denies a non-admin before repository access", () => {
  let called = false;
  const service = createAuditLogService({
    repository: {
      list: async () => {
        called = true;
        return { rows: [], count: 0 };
      }
    }
  });
  assert.throws(
    () =>
      service.list(
        { authUser: { id: "u1" }, profile: { is_active: true }, isAdmin: false, accessToken: "t" },
        new URLSearchParams()
      ),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  assert.equal(called, false);
});
