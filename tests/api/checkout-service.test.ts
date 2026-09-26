import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckoutOtpRateLimiter,
  checkoutClientIp,
  checkoutPaymentState,
  createCheckoutActivation,
  generateCheckoutOtp,
  hashCheckoutActivationToken,
  normalizeVietnamesePhone,
  validateCheckoutContact
} from "../../apps/api/src/user/checkout-service.js";
import { buildSavedAddressBook } from "../../apps/api/src/user/checkout-repository.js";

test("guest checkout rejects a missing phone", () => {
  assert.throws(
    () => validateCheckoutContact({ fullName: "Nguyễn Văn An", phone: "" }),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "INVALID_PHONE"
  );
});

test("checkout validates a two-word name and optional email", () => {
  assert.throws(
    () => validateCheckoutContact({ fullName: "An", phone: "0912345678" }),
    (error: { code?: string }) => error.code === "INVALID_FULL_NAME"
  );
  assert.deepEqual(validateCheckoutContact({
    fullName: "  Nguyễn   Văn An ",
    phone: "+84 912 345 678",
    email: ""
  }), { fullName: "Nguyễn Văn An", phone: "0912345678", email: null });
});

test("Vietnamese phone normalization rejects foreign and malformed numbers", () => {
  assert.equal(normalizeVietnamesePhone("84.912.345.678"), "0912345678");
  assert.throws(
    () => validateCheckoutContact({ fullName: "Nguyễn Văn An", phone: "0212345678" }),
    (error: { code?: string }) => error.code === "INVALID_PHONE"
  );
});

test("COD starts pending while online checkout waits for payment", () => {
  assert.deepEqual(checkoutPaymentState("cod"), { method: "COD", orderStatus: "pending" });
  assert.deepEqual(checkoutPaymentState("stripe"), {
    method: "ONLINE_PAYMENT",
    orderStatus: "waiting_payment"
  });
});

test("checkout OTP is generated as four digits", () => {
  for (let index = 0; index < 20; index += 1) {
    const otp = generateCheckoutOtp();
    assert.match(otp, /^\d{4}$/);
  }
});

test("checkout OTP limits one phone to three sends per fifteen minutes", () => {
  const limiter = new CheckoutOtpRateLimiter();
  const now = Date.UTC(2026, 8, 26);
  limiter.consume("0912345678", "203.0.113.1", now);
  limiter.consume("0912345678", "203.0.113.1", now + 1);
  limiter.consume("0912345678", "203.0.113.1", now + 2);
  assert.throws(
    () => limiter.consume("0912345678", "203.0.113.1", now + 3),
    (error: { status?: number; code?: string }) => error.status === 429 && error.code === "OTP_PHONE_RATE_LIMIT"
  );
  limiter.consume("0912345678", "203.0.113.1", now + 15 * 60 * 1000 + 1);
});

test("checkout OTP limits one IP to five distinct phones per hour", () => {
  const limiter = new CheckoutOtpRateLimiter();
  const now = Date.UTC(2026, 8, 26);
  for (let index = 0; index < 5; index += 1) {
    limiter.consume(`091234567${index}`, "203.0.113.2", now + index);
  }
  assert.throws(
    () => limiter.consume("0987654321", "203.0.113.2", now + 10),
    (error: { code?: string }) => error.code === "OTP_IP_RATE_LIMIT"
  );
});

test("checkout client IP prefers the first proxy address", () => {
  assert.equal(checkoutClientIp({ "x-forwarded-for": "203.0.113.3, 10.0.0.1" }, "127.0.0.1"), "203.0.113.3");
});

test("member checkout appends a saved address without overwriting existing entries", () => {
  const result = buildSavedAddressBook(
    [{ id: "old", detail: "Địa chỉ cũ", is_default: true }],
    { fullName: "Nguyễn Văn An", phone: "0912345678", email: null },
    { detail: "123 Nguyễn Huệ", province: "TP.HCM", district: "Quận 1", ward: "Bến Nghé" },
    "addr_new"
  );
  assert.equal(result.addresses.length, 2);
  assert.equal(result.addresses[0]?.detail, "Địa chỉ cũ");
  assert.deepEqual(result.entry, {
    id: "addr_new",
    name: "Nguyễn Văn An",
    phone: "0912345678",
    detail: "123 Nguyễn Huệ",
    address: "123 Nguyễn Huệ",
    province: "TP.HCM",
    district: "Quận 1",
    ward: "Bến Nghé",
    is_default: false
  });
});

test("guest activation token is hashed and expires after 24 hours", () => {
  const now = Date.UTC(2026, 8, 26, 10);
  const activation = createCheckoutActivation(now);
  assert.notEqual(activation.token, activation.tokenHash);
  assert.equal(activation.tokenHash, hashCheckoutActivationToken(activation.token));
  assert.equal(new Date(activation.expiresAt).getTime(), now + 24 * 60 * 60 * 1000);
});
