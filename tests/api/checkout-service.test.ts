import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckoutOtpRateLimiter,
  CheckoutOtpService,
  CheckoutService,
  checkoutClientIp,
  checkoutPaymentState,
  createCheckoutActivation,
  generateCheckoutOtp,
  hashCheckoutActivationToken,
  normalizeVietnamesePhone,
  validateCheckoutContact
} from "../../apps/api/src/user/checkout-service.js";
import { buildSavedAddressBook, type CheckoutRepository } from "../../apps/api/src/user/checkout-repository.js";
import type { JsonObject } from "../../apps/api/src/types.js";

function checkoutRepositoryStub(overrides: Partial<CheckoutRepository> = {}): CheckoutRepository {
  const noop = async (): Promise<void> => {};
  return {
    findVariant: async () => ({ stock_quantity: 10, reserved_quantity: 0 }),
    findUserByPhone: async () => null,
    findUserByEmail: async () => null,
    findUserByActivationHash: async () => null,
    createGuestUser: async (input) => ({ user_id: "guest-1", ...input }),
    updateGuestUser: noop,
    activateGuestUser: noop,
    createOrder: async (input) => ({ order_id: "order-1", ...input }),
    createPayment: noop,
    createOrderItem: async (input) => ({ order_item_id: "item-1", ...input }),
    updateVariantStock: noop,
    createEmailOutbox: noop,
    appendAddress: async (_userId, _contact, input) => ({ detail: input.detail }),
    ...overrides
  };
}

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

test("checkout OTP is generated as six digits", () => {
  for (let index = 0; index < 20; index += 1) {
    const otp = generateCheckoutOtp();
    assert.match(otp, /^\d{6}$/);
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

test("checkout OTP service owns issue, attempt limits and one-time consumption", () => {
  const service = new CheckoutOtpService();
  const now = Date.UTC(2026, 8, 26);
  const session = service.issue({
    fullName: "Nguyễn Văn An",
    phone: "0912345678",
    email: "an@example.com",
    ip: "203.0.113.10"
  }, now);
  assert.equal(service.verify("0912345678", session.otpCode, now + 1), session);
  service.consume("0912345678");
  assert.throws(
    () => service.verify("0912345678", session.otpCode, now + 2),
    (error: { code?: string }) => error.code === "INVALID_OTP"
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

test("checkout service persists COD through the repository and decrements stock", async () => {
  const calls: JsonObject[] = [];
  const repository = checkoutRepositoryStub({
    createOrder: async (input) => {
      calls.push({ operation: "order", input });
      return { order_id: "order-1", ...input };
    },
    createOrderItem: async (input) => {
      calls.push({ operation: "item", input });
      return { order_item_id: "item-1", ...input };
    },
    updateVariantStock: async (variantId, quantity) => {
      calls.push({ operation: "stock", variantId, quantity });
    }
  });
  const service = new CheckoutService(repository);
  const result = await service.persistOrder({
    userId: "member-1",
    contact: { fullName: "Nguyễn Văn An", phone: "0912345678", email: null },
    shippingAddress: "123 Nguyễn Huệ",
    shippingFee: 30_000,
    voucherId: null,
    discountAmount: 0,
    subtotal: 100_000,
    totalAmount: 130_000,
    paymentMethod: "COD",
    paymentProvider: "COD",
    orderStatus: "pending",
    orderCode: "VLRTEST",
    internalNote: null,
    items: [{
      variantId: "variant-1",
      productName: "Áo",
      productImage: null,
      quantity: 2,
      unitPrice: 50_000,
      subtotal: 100_000
    }]
  });
  assert.equal(result.order.order_id, "order-1");
  assert.deepEqual(calls.map((call) => call.operation), ["order", "item", "stock"]);
  assert.equal(calls[2]?.quantity, 8);
});

test("online checkout delegates real gateway attempt creation without fabricated references", async () => {
  let payment: JsonObject | null = null;
  const service = new CheckoutService(checkoutRepositoryStub({
    createOrder: async (input) => ({ order_id: "order-online", ...input }),
    createPayment: async (input) => {
      payment = input;
    },
    createOrderItem: async (input) => ({ order_item_id: "item-online", ...input })
  }));

  await service.persistOrder({
    userId: "member-1",
    contact: { fullName: "Nguyen Van An", phone: "0912345678", email: null },
    shippingAddress: "123 Nguyen Hue",
    shippingFee: 30_000,
    voucherId: null,
    discountAmount: 0,
    subtotal: 100_000,
    totalAmount: 130_000,
    paymentMethod: "ONLINE_PAYMENT",
    paymentProvider: "VNPAY",
    orderStatus: "waiting_payment",
    orderCode: "VLRONLINE",
    internalNote: null,
    items: [{
      variantId: "variant-1",
      productName: "Ao",
      productImage: null,
      quantity: 1,
      unitPrice: 100_000,
      subtotal: 100_000
    }]
  });

  assert.equal(payment, null, "A real hosted gateway owns its durable attempt; checkout must not fabricate a reference");
});

test("checkout service activates a guest only through the repository", async () => {
  const token = "one-time-token";
  let activatedUserId = "";
  const service = new CheckoutService(checkoutRepositoryStub({
    findUserByActivationHash: async (hash) => {
      assert.equal(hash, hashCheckoutActivationToken(token));
      return { user_id: "guest-1", activation_expires_at: new Date(Date.now() + 60_000).toISOString() };
    },
    activateGuestUser: async (userId, passwordHash) => {
      activatedUserId = userId;
      assert.match(passwordHash, /^scrypt\$/);
    }
  }));
  const user = await service.activateGuest(token, "StrongPass1!");
  assert.equal(user.user_id, "guest-1");
  assert.equal(activatedUserId, "guest-1");
});
