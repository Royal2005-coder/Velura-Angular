import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "../../apps/api/src/auth-helper.js";

test("hashPassword produces a salted scrypt hash, not the legacy unsalted digest", () => {
  const hash = hashPassword("Correct-Horse-Battery-9!");
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
});

test("hashPassword salts each call, so identical passwords hash differently", () => {
  const first = hashPassword("Same-Password-9!");
  const second = hashPassword("Same-Password-9!");
  assert.notEqual(first, second);
});

test("verifyPassword accepts the correct password against a freshly hashed scrypt digest", () => {
  const hash = hashPassword("Right-Password-9!");
  assert.equal(verifyPassword("Right-Password-9!", hash), true);
  assert.equal(verifyPassword("Wrong-Password-9!", hash), false);
});

test("verifyPassword still accepts legacy unsalted SHA-256 hashes for existing accounts", () => {
  const legacyHash = crypto.createHash("sha256").update("Legacy-Password-9!").digest("hex");
  assert.equal(verifyPassword("Legacy-Password-9!", legacyHash), true);
  assert.equal(verifyPassword("Wrong-Password-9!", legacyHash), false);
});

test("verifyPassword rejects malformed input without throwing", () => {
  assert.equal(verifyPassword("", "scrypt$abc$def"), false);
  assert.equal(verifyPassword("pw", ""), false);
  assert.equal(verifyPassword("pw", "scrypt$onlyonepart"), false);
});
