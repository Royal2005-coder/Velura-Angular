import test from "node:test";
import assert from "node:assert/strict";
import { countWords, createAccountService, validateLock, validateRoleChange, validateUnlock } from "../../apps/api/src/accounts/account-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const VALID_REASON = "Tai khoan co dau hieu vi pham nghiem trong dieu khoan bao mat cua he thong";

test("countWords counts normalized whitespace", () => {
  assert.equal(countWords(" mot   hai\nba "), 3);
  assert.equal(countWords(""), 0);
});

test("validateLock requires more than ten words", () => {
  assert.throws(
    () => validateLock({ lockType: "temporary", reason: "mot hai ba", expectedVersion: 1 }),
    (error) => error.status === 422 && error.code === "VALIDATION_ERROR"
  );
});

test("validateLock rejects an expiry for permanent locks", () => {
  assert.throws(
    () => validateLock({ lockType: "permanent", reason: VALID_REASON, expectedVersion: 1, lockedUntil: "2099-01-01T00:00:00.000Z" }),
    (error) => error.details.lockedUntil.length === 1
  );
});

test("validateUnlock requires a positive optimistic-lock version", () => {
  assert.throws(
    () => validateUnlock({ reason: VALID_REASON, expectedVersion: 0 }),
    (error) => error.details.expectedVersion.length === 1
  );
});

test("validateRoleChange enforces the canonical BA role matrix", () => {
  assert.deepEqual(validateRoleChange({ role: "member", adminRole: null, expectedVersion: 2 }), {
    role: "member",
    adminRole: null,
    expectedVersion: 2,
    ipAddress: "0.0.0.0"
  });
  assert.throws(
    () => validateRoleChange({ role: "admin", adminRole: "product_admin", expectedVersion: 2 }),
    (error) => error.status === 422
  );
});

test("account service denies an operator before repository access", async () => {
  let called = false;
  const service = createAccountService({ repository: { list: async () => { called = true; } } });
  await assert.rejects(
    () => service.list(operatorContext(), new URLSearchParams()),
    (error) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  assert.equal(called, false);
});

test("account service denies a member and an inactive super admin", async () => {
  let called = false;
  const service = createAccountService({ repository: { list: async () => { called = true; } } });
  await assert.rejects(
    () => service.list({ authUser: { id: "auth-member" }, profile: { is_active: true }, isAdmin: false, roleCode: "member" }, new URLSearchParams()),
    (error) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  await assert.rejects(
    () => service.list({ ...superAdminContext(), profile: { user_id: "actor-1", is_active: false } }, new URLSearchParams()),
    (error) => error.status === 403 && error.code === "RBAC_DENIED"
  );
  assert.equal(called, false);
});

test("account service validates identifiers and list filters before database access", async () => {
  const service = createAccountService({ repository: { get: async () => ({}), list: async () => ({}) } });
  await assert.rejects(
    () => service.get(superAdminContext(), "not-a-uuid"),
    (error) => error.status === 422 && error.details.userId.length === 1
  );
  await assert.rejects(
    () => service.list(superAdminContext(), new URLSearchParams("role=owner")),
    (error) => error.status === 422 && error.details.role.length === 1
  );
  await assert.rejects(
    () => service.list(superAdminContext(), new URLSearchParams("isActive=yes")),
    (error) => error.status === 422 && error.details.isActive.length === 1
  );
});

test("temporary lock expiry must be in the future", () => {
  assert.throws(
    () => validateLock({ lockType: "temporary", reason: VALID_REASON, expectedVersion: 1, lockedUntil: "2020-01-01T00:00:00.000Z" }),
    (error) => error.status === 422 && error.details.lockedUntil.length === 1
  );
});

test("admin role requires a canonical adminRole", () => {
  assert.throws(
    () => validateRoleChange({ role: "admin", adminRole: null, expectedVersion: 1 }),
    (error) => error.status === 422 && error.details.adminRole.length === 1
  );
});

test("account service forwards a valid lock to the repository", async () => {
  let received;
  const service = createAccountService({
    repository: {
      lock: async (...args) => {
        received = args;
        return { user_id: USER_ID, is_active: false, version: 4 };
      }
    }
  });
  const result = await service.lock(superAdminContext(), USER_ID, {
    lockType: "temporary",
    reason: VALID_REASON,
    expectedVersion: 3
  }, { ipAddress: "127.0.0.1" });

  assert.equal(result.version, 4);
  assert.equal(received[0], USER_ID);
  assert.equal(received[1].expectedVersion, 3);
  assert.equal(received[2], "actor-1");
});

test("approval rejection requires a reason longer than ten words", async () => {
  const service = createAccountService({ repository: { reviewRoleRequest: async () => ({}) } });
  await assert.rejects(
    () => service.reviewRoleRequest(superAdminContext(), REQUEST_ID, "reject", { expectedVersion: 1, note: "khong du dieu kien" }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.details.note.length === 1
  );
});

function superAdminContext() {
  return {
    authUser: { id: "auth-1" },
    profile: { user_id: "actor-1", is_active: true },
    isAdmin: true,
    roleCode: "super_admin",
    accessToken: "valid-access-token"
  };
}

function operatorContext() {
  return {
    authUser: { id: "auth-2" },
    profile: { user_id: "actor-2", is_active: true },
    isAdmin: true,
    roleCode: "admin_operator_sanpham",
    accessToken: "operator-token"
  };
}
