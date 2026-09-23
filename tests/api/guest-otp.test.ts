import test from "node:test";
import assert from "node:assert/strict";
import { maskEmail, requireGuestOtpEmail } from "../../apps/api/src/user/orders.js";

test("guest OTP requires an email because there is no SMS provider", () => {
  assert.equal(requireGuestOtpEmail("han@velura.vn"), "han@velura.vn");
  assert.throws(() => requireGuestOtpEmail(""), (error: { code?: string }) => error.code === "EMAIL_REQUIRED");
  assert.throws(() => requireGuestOtpEmail("not-an-email"), (error: { code?: string }) => error.code === "EMAIL_REQUIRED");
});

test("guest OTP destination hides the mailbox name", () => {
  assert.equal(maskEmail("han@velura.vn"), "h***@velura.vn");
});
