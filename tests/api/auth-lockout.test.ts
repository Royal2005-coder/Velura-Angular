import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole, rolePages } from "../../apps/api/src/rbac.js";
import { assertNotLocked, loginLockStatus, nextFailedLoginState } from "../../apps/api/src/auth-lockout.js";

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

test("operator landing pages stay on the role module, not a shared accounts screen", () => {
  assert.deepEqual(rolePages.admin_operator_sanpham, ["products", "dashboard"]);
  assert.deepEqual(rolePages.admin_operator_donhang, ["orders", "dashboard"]);
  assert.deepEqual(rolePages.admin_operator_cskh_dt, ["returns-cskh", "dashboard"]);
  assert.ok(accessForRole("admin_operator_cskh_dt").allowedModules.includes("orders"));
  assert.equal(accessForRole("admin_operator_sanpham").allowedModules.includes("orders"), false);
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
