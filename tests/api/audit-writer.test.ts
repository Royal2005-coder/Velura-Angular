import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("audit writer targets the canonical audit_log table", async () => {
  const audit = await readFile(path.join(ROOT, "apps/api/src/audit.ts"), "utf8");

  assert.match(audit, /insertRow\("audit_log"/);
  assert.doesNotMatch(audit, /audit_logs/);
  assert.doesNotMatch(audit, /useAnonKey/);
});

test("auth sign-in and sign-out write through the canonical audit writer", async () => {
  const signin = await readFile(path.join(ROOT, "apps/api/src/auth-signin.ts"), "utf8");

  assert.match(signin, /writeAuthAudit/);
  assert.match(signin, /action: "signin"/);
  assert.match(signin, /signin_failed/);
  assert.match(signin, /action: "signin_blocked"/);
  assert.match(signin, /action: "signout"/);
  assert.doesNotMatch(signin, /useAnonKey/);
});
