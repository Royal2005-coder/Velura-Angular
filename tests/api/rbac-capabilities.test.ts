import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import {
  capabilitiesForRole,
  hasCapability,
  requirePermission
} from "../../apps/api/src/rbac.js";
import type { AuthContext, UserProfile } from "../../apps/api/src/types.js";

function context(roleCode: string): AuthContext {
  const profile: UserProfile = {
    user_id: "u1",
    email: "admin@velura.test",
    role: "admin",
    admin_role: roleCode,
    is_active: true,
    is_verified: true
  };
  const capabilities = capabilitiesForRole(roleCode);
  return {
    authUser: { id: "u1", email: "admin@velura.test" },
    profile,
    roleCode,
    roleName: roleCode,
    isAdmin: true,
    allowedPages: [],
    allowedModules: Object.keys(capabilities),
    capabilities,
    accessToken: "test"
  };
}

test("super admin receives the wildcard capability", () => {
  const caps = capabilitiesForRole("super_admin");
  assert.deepEqual(caps["*"], ["read", "create", "update", "delete", "approve"]);
  assert.equal(hasCapability(context("super_admin"), "accounts", "delete"), true);
});

test("product operator can create and update products only", () => {
  const ctx = context("admin_operator_sanpham");
  assert.deepEqual(capabilitiesForRole("admin_operator_sanpham").products, ["read", "create", "update"]);
  assert.equal(hasCapability(ctx, "products", "update"), true);
  assert.equal(hasCapability(ctx, "orders", "update"), false);
  assert.throws(
    () => requirePermission(ctx, "orders", "update"),
    (error: unknown) => error instanceof HttpError && error.code === "RBAC_DENIED"
  );
});

test("price operator cannot mutate catalog products", () => {
  const ctx = context("admin_operator_gia_km");
  assert.equal(hasCapability(ctx, "pricing", "update"), true);
  assert.equal(hasCapability(ctx, "products", "update"), false);
  assert.throws(
    () => requirePermission(ctx, "products", "write"),
    (error: unknown) => error instanceof HttpError && error.code === "RBAC_DENIED"
  );
});

test("legacy write action normalizes to update", () => {
  const ctx = context("admin_operator_donhang");
  assert.doesNotThrow(() => requirePermission(ctx, "orders", "write"));
  assert.equal(hasCapability(ctx, "orders", "update"), true);
});

test("viewer is read-only even when a capability is present", () => {
  const ctx = context("admin_viewer");
  assert.equal(hasCapability(ctx, "dashboard", "read"), true);
  assert.throws(
    () => requirePermission(ctx, "dashboard", "update"),
    (error: unknown) => error instanceof HttpError && error.code === "RBAC_DENIED"
  );
});

test("viewer gets read-only access to every dashboard drill-down module and no write action anywhere", () => {
  const caps = capabilitiesForRole("admin_viewer");
  for (const moduleName of Object.keys(caps)) assert.deepEqual(caps[moduleName], ["read"], moduleName);
  for (const moduleName of ["dashboard", "orders", "returns", "support_tickets", "products", "reviews"]) assert.ok(caps[moduleName], moduleName);
  assert.equal(caps["*"], undefined);
  assert.equal(caps.accounts, undefined);
  const ctx = context("admin_viewer");
  for (const moduleName of ["orders", "returns", "products", "reviews", "support_tickets"]) {
    assert.doesNotThrow(() => requirePermission(ctx, moduleName, "read"));
    for (const action of ["create", "update", "delete", "approve", "write"]) {
      assert.throws(
        () => requirePermission(ctx, moduleName, action),
        (error: unknown) => error instanceof HttpError && error.code === "RBAC_DENIED",
        `${moduleName}.${action}`
      );
    }
  }
});

test("viewer page list exposes the drill-down workspaces so dashboard links are not 'Sắp mở'", async () => {
  const { rolePages } = await import("../../apps/api/src/rbac.js");
  for (const page of ["dashboard", "orders", "products", "returns-cskh", "reviews"]) assert.ok(rolePages.admin_viewer.includes(page), page);
});
