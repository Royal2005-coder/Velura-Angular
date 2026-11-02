import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole, rolePages } from "../../apps/api/src/rbac.js";
import { assertAccountNotLocked, assertNotLocked, isTemporaryLockExpired, loginLockStatus, nextFailedLoginState, releaseExpiredTemporaryLock, resetStaleLoginFailures } from "../../apps/api/src/auth-lockout.js";

const ROOT = process.cwd();

test("AUTH-02 lockout counts remaining attempts and locks on the fifth failure", () => {
  const first = nextFailedLoginState(0, new Date("2026-09-16T00:00:00.000Z"));
  assert.equal(first.login_fail_count, 1);
  assert.equal(first.remaining_attempts, 4);
  assert.equal(first.locked_until, null);

  const fifth = nextFailedLoginState(4, new Date("2026-09-16T00:00:00.000Z"));
  assert.equal(fifth.login_fail_count, 5);
  assert.equal(fifth.remaining_attempts, 0);
  assert.equal(fifth.locked_until, "2026-09-16T00:15:00.000Z");
  assert.equal(fifth.retry_after_seconds, 900);
});

test("AUTH-02 locked accounts stay closed until locked_until", () => {
  const until = "2026-09-16T00:15:00.000Z";
  const status = loginLockStatus(
    { user_id: "u1", login_fail_count: 5, locked_until: until },
    new Date("2026-09-16T00:10:00.000Z")
  );
  assert.equal(status.isLocked, true);
  assert.equal(status.retry_after_seconds, 300);
  assert.throws(
    () =>
      assertNotLocked(
        { user_id: "u1", login_fail_count: 5, locked_until: until },
        new Date("2026-09-16T00:10:00.000Z")
      ),
    (error) => error instanceof HttpError && error.status === 403 && error.code === "LOCKED"
  );
});

test("operator landing pages stay on the role module, not the HQ dashboard", () => {
  assert.deepEqual(rolePages.admin_operator_sanpham, ["products"]);
  assert.deepEqual(rolePages.admin_operator_donhang, ["orders"]);
  assert.deepEqual(rolePages.admin_operator_cskh_dt, ["returns-cskh"]);
  assert.deepEqual(rolePages.admin_operator_gia_km, ["pricing", "promotions"]);
  assert.deepEqual(rolePages.admin_operator_danhgia_review, ["reviews"]);
  assert.ok(rolePages.super_admin.includes("dashboard"));
  assert.ok(rolePages.admin_viewer.includes("dashboard"));
  assert.equal(rolePages.admin_operator_sanpham.includes("dashboard"), false);
  assert.ok(accessForRole("admin_operator_cskh_dt").allowedModules.includes("orders"));
  assert.equal(accessForRole("admin_operator_sanpham").allowedModules.includes("orders"), false);
  assert.equal(accessForRole("admin_operator_sanpham").allowedModules.includes("dashboard"), false);
});

test("admin password grant and sign-out stay on the custom API", async () => {
  const [server, signin, login, shell] = await Promise.all([
    readFile(path.join(ROOT, "apps/api/src/server.ts"), "utf8"),
    readFile(path.join(ROOT, "apps/api/src/auth-signin.ts"), "utf8"),
    readFile(path.join(ROOT, "apps/admin-ng/src/app/features/login/admin-login.page.ts"), "utf8"),
    readFile(path.join(ROOT, "apps/admin-ng/src/app/layout/admin-shell.ts"), "utf8")
  ]);
  assert.match(server, /completeAdminPasswordSignIn/);
  assert.match(server, /auth" && parts\[2\] === "signout"/);
  assert.match(signin, /recordFailedLogin/);
  assert.match(signin, /recordAdminSignOut/);
  assert.match(login, /\.signIn\(/);
  assert.doesNotMatch(login, /signInWithPassword/);
  assert.match(shell, /askLogout/);
  assert.match(shell, /signOut\(/);
});

test("admin lock_type blocks OTP/reset self-reactivation until an admin unlocks", async () => {
  assert.doesNotThrow(() => assertAccountNotLocked({ lock_type: null }));
  assert.throws(
    () => assertAccountNotLocked({ lock_type: "permanent" }),
    (error: unknown) => error instanceof HttpError && error.status === 423 && error.code === "ACCOUNT_LOCKED"
  );
  assert.throws(
    () => assertAccountNotLocked({ lock_type: "temporary" }),
    (error: unknown) => error instanceof HttpError && error.status === 423
  );
});

test("BA 3.1.9 expired temporary admin lock is treated as unlocked", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.doesNotThrow(() => assertAccountNotLocked({ lock_type: "temporary", locked_until: "2026-09-16T11:59:59.000Z" }, now));
  assert.equal(isTemporaryLockExpired({ lock_type: "temporary", locked_until: "2026-09-16T11:59:59.000Z" }, now), true);
});

test("BA 3.1.9 active temporary, permanent and open-ended locks still block", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  for (const user of [
    { lock_type: "temporary", locked_until: "2026-09-16T12:00:01.000Z" },
    { lock_type: "temporary", locked_until: null },
    { lock_type: "permanent", locked_until: "2020-01-01T00:00:00.000Z" }
  ]) {
    assert.throws(() => assertAccountNotLocked(user, now), (error) => error instanceof HttpError && error.code === "ACCOUNT_LOCKED");
  }
  assert.doesNotThrow(() => assertAccountNotLocked({ lock_type: null }, now));
});

test("releaseExpiredTemporaryLock only calls the RPC for expired temporary locks", async () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const active = { user_id: "u1", lock_type: "temporary", locked_until: "2026-09-17T00:00:00.000Z", is_active: false };
  assert.equal(await releaseExpiredTemporaryLock(active, now), active);
  const permanent = { user_id: "u2", lock_type: "permanent", locked_until: null, is_active: false };
  assert.equal(await releaseExpiredTemporaryLock(permanent, now), permanent);
});

test("resetStaleLoginFailures never wipes the expiry of an admin lock", async () => {
  const user = { user_id: "u1", lock_type: "temporary", locked_until: "2026-09-16T11:00:00.000Z", login_fail_count: 0 };
  assert.equal(await resetStaleLoginFailures(user, new Date("2026-09-16T12:00:00.000Z")), user);
});
