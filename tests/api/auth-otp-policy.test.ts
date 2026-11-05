import test from "node:test";
import assert from "node:assert/strict";
import { OTP_TTL_MS } from "../../apps/api/src/user/otp-policy.js";
import { CheckoutOtpService } from "../../apps/api/src/user/checkout-service.js";
import { signinPhoneFilter } from "../../apps/api/src/user/auth.js";

const contact = { fullName: "Nguyen Van A", phone: "0912345678", ip: "203.0.113.9" };

test("AUTH-08: OTP lives exactly 5 minutes (299s ok, 301s expired)", () => {
  assert.equal(OTP_TTL_MS, 300_000);
  const service = new CheckoutOtpService();
  const now = 1_700_000_000_000;
  service.issue(contact, now);
  assert.doesNotThrow(() => service.verify("0912345678", "123456", now + 299_000));
  assert.throws(() => service.verify("0912345678", "123456", now + 301_000), /hết hạn/);
});

test("AUTH-02: phone sign-in treats spaces, +84 and 84 as the same number", () => {
  assert.equal(signinPhoneFilter("0933112201"), "in.(0933112201,+84933112201)");
  assert.equal(signinPhoneFilter("0933 112 201"), "in.(0933112201,+84933112201)");
  assert.equal(signinPhoneFilter("+84933112201"), "in.(0933112201,+84933112201)");
  assert.equal(signinPhoneFilter("84933112201"), "in.(0933112201,+84933112201)");
});
