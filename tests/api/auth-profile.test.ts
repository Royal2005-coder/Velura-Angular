import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isEmailUnconfirmed, preferLinkedProfile } from "../../apps/api/src/auth-profile.js";
import type { UserProfile } from "../../apps/api/src/types.js";

const ROOT = process.cwd();

function profile(partial: Partial<UserProfile> & { user_id: string }): UserProfile {
  return { role: "member", ...partial };
}

test("preferLinkedProfile keeps the granted admin row over a Google member duplicate", () => {
  const memberAuth = profile({ user_id: "auth-member", role: "member", email: "op@velura.vn" });
  const adminEmail = profile({
    user_id: "admin-row",
    role: "admin",
    admin_role: "admin_operator_sanpham",
    email: "op@velura.vn"
  });
  const chosen = preferLinkedProfile(memberAuth, adminEmail);
  assert.equal(chosen?.user_id, "admin-row");
  assert.equal(chosen?.admin_role, "admin_operator_sanpham");
});

test("preferLinkedProfile keeps a linked admin when the email row is only a member leftover", () => {
  const adminAuth = profile({
    user_id: "admin-row",
    role: "admin",
    admin_role: "admin_operator_donhang"
  });
  const memberEmail = profile({ user_id: "other", role: "member" });
  assert.equal(preferLinkedProfile(adminAuth, memberEmail)?.user_id, "admin-row");
});

test("GoTrue email_not_confirmed maps onto the admin login copy", () => {
  assert.equal(isEmailUnconfirmed({ error_code: "email_not_confirmed" }), true);
  assert.equal(isEmailUnconfirmed({ error_description: "Email not confirmed" }), true);
  assert.equal(isEmailUnconfirmed({ error_description: "Invalid login credentials" }), false);
});

test("auth sign-in and /me attach Auth onto the operator profile", async () => {
  const [signin, rbac, migration] = await Promise.all([
    readFile(path.join(ROOT, "apps/api/src/auth-signin.ts"), "utf8"),
    readFile(path.join(ROOT, "apps/api/src/rbac.ts"), "utf8"),
    readFile(path.join(ROOT, "database/migrations/023_auth_profile_verify_sync.sql"), "utf8")
  ]);
  assert.match(signin, /EMAIL_NOT_CONFIRMED/);
  assert.match(signin, /isEmailUnconfirmed/);
  assert.match(rbac, /loadProfileForAuthUser/);
  assert.match(migration, /velura_sync_auth_user_verified/);
  assert.match(migration, /lower\(u\.email\) = lower\(new\.email\)/);
});
