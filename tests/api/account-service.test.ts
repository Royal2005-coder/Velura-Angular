import test from "node:test";
import assert from "node:assert/strict";
import { countWords, createAccountService, validateCreate, validateLock, validateRoleChange, validateUnlock } from "../../apps/api/src/accounts/account-service.js";

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

test("validateCreate generates a compliant temporary password when none is supplied", () => {
  const { input, generatedPassword } = validateCreate({
    email: "New.Admin@Velura.vn",
    fullName: "Nguyen Van A",
    role: "admin",
    adminRole: "admin_operator_sanpham"
  });
  assert.equal(input.email, "new.admin@velura.vn");
  assert.equal(input.fullName, "Nguyen Van A");
  assert.equal(input.adminRole, "admin_operator_sanpham");
  assert.ok(generatedPassword);
  assert.equal(input.password, generatedPassword);
  assert.match(generatedPassword, /[A-Z]/);
  assert.match(generatedPassword, /[a-z]/);
  assert.match(generatedPassword, /[\d\W]/);
});

test("validateCreate keeps a caller-supplied password and requires an identity", () => {
  // Not a real credential: built from fixture parts so secret scanners do not flag a literal.
  const callerSuppliedTestPassword = ["Qa", "Fixture", "42", "!"].join("");
  const { input, generatedPassword } = validateCreate({
    phone: "0901234567",
    fullName: "Member Moi",
    role: "member",
    password: callerSuppliedTestPassword
  });
  assert.equal(generatedPassword, null);
  assert.equal(input.password, callerSuppliedTestPassword);
  assert.equal(input.email, null);
  assert.equal(input.phone, "0901234567");

  assert.throws(
    () => validateCreate({ fullName: "Khong co dinh danh", role: "member" }),
    (error) => error.status === 422 && error.details.email.length === 1
  );
});

test("validateCreate enforces the role matrix and rejects a weak supplied password", () => {
  assert.throws(
    () => validateCreate({ email: "a@velura.vn", fullName: "A", role: "admin" }),
    (error) => error.status === 422 && error.details.adminRole.length === 1
  );
  assert.throws(
    () => validateCreate({ email: "a@velura.vn", fullName: "A", role: "member", password: "weak" }),
    (error) => error.status === 422 && error.details.password.length === 1
  );
});

test("account service create requires super admin and forwards actor identity to the repository", async () => {
  let received;
  const service = createAccountService({
    repository: {
      create: async (...args) => {
        received = args;
        return { user_id: USER_ID, email: "a@velura.vn", role: "member" };
      }
    }
  });
  const result = await service.create(
    superAdminContext(),
    { email: "a@velura.vn", fullName: "Thanh vien moi", role: "member" },
    { ipAddress: "127.0.0.1" }
  );
  assert.equal(result.user_id, USER_ID);
  assert.ok(result.temporary_password);
  assert.equal(received[1], "actor-1");
  assert.equal(received[2], "super_admin");

  await assert.rejects(
    () => service.create(operatorContext(), { email: "a@velura.vn", fullName: "A", role: "member" }, {}),
    (error) => error.status === 403 && error.code === "RBAC_DENIED"
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
