import test from "node:test";
import assert from "node:assert/strict";
import { maskEmail } from "../../apps/api/src/email/mailer.js";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import {
  GUEST_OTP_TTL_SECONDS,
  maskTrackingPhone,
  sendGuestTrackingOtp,
  type GuestOtpDelivery,
} from "../../apps/api/src/user/guest-order-session.js";

const ORDER = "44444444-4444-4444-8444-444444444444";
const ORDER_EMAIL = "customer@example.test";

interface GatewayLog {
  issued: number;
  invalidated: boolean;
  scopeLost: boolean;
  issuedOrder: unknown;
}

/**
 * Minimal PostgREST double for the tracking challenge: orders by code, the scoped issue RPC and
 * the invalidation PATCH. Kept in one place so every delivery test asserts the same contract.
 */
function trackingGateway(options: { issueStatus?: number; shippingPhone?: string; shippingEmail?: string | null } = {}) {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, {
    supabaseUrl: "https://tracking.test",
    supabaseServiceRoleKey: "test-service",
    nodeEnv: "production",
    smtpHost: "",
    smtpUser: "",
    smtpAppPassword: "",
    supportAlertTo: "staff@example.test",
    twilioAccountSid: "",
    twilioAuthToken: "",
    twilioApiKeySid: "",
    twilioApiKeySecret: "",
    esmsApiKey: "",
    stringeeApiKeySid: "",
  });
  const log: GatewayLog = { issued: 0, invalidated: false, scopeLost: false, issuedOrder: null };
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    let data: unknown = [];
    let status = 200;
    if (url.pathname.endsWith("/orders")) {
      data = [
        {
          order_id: ORDER,
          shipping_phone: options.shippingPhone ?? "0912345678",
          shipping_name: "Customer",
          shipping_email: options.shippingEmail ?? null,
        },
      ];
    }
    if (url.pathname.endsWith("/rpc/velura_issue_guest_tracking_otp")) {
      const payload = JSON.parse(String(init?.body));
      log.issued += 1;
      log.issuedOrder = payload.p_order;
      log.scopeLost ||= payload.p_order !== ORDER;
      status = options.issueStatus ?? 200;
      data = status === 200 ? null : { code: "PGRST202", message: "Missing scoped OTP function" };
    }
    if (url.pathname.endsWith("/guest_tracking_otp") && init?.method === "PATCH") log.invalidated = true;
    return new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    log,
    restore() {
      globalThis.fetch = originalFetch;
      Object.assign(config, saved);
    },
  };
}

/** Delivery double: records who was asked, returns whatever the test needs to claim. */
function deliveryStub(sms: { success: boolean; simulated?: boolean }, emailOk = true) {
  const smsTargets: string[] = [];
  const emailTargets: unknown[] = [];
  const stub: GuestOtpDelivery = {
    async sendSms(phone) {
      smsTargets.push(phone);
      return sms;
    },
    async sendEmail(to) {
      emailTargets.push(to);
      return emailOk;
    },
  };
  return { stub, smsTargets, emailTargets };
}

test("an order challenge cannot downgrade to unscoped authorization when scoped issuance fails", async () => {
  const gateway = trackingGateway({ issueStatus: 404 });
  const { stub } = deliveryStub({ success: true });
  try {
    await assert.rejects(sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1", stub), HttpError);
    assert.equal(gateway.log.scopeLost, false);
    assert.equal(gateway.log.invalidated, false);
  } finally {
    gateway.restore();
  }
});

test("no working channel invalidates the challenge and answers with a 4xx the UI can render", async () => {
  const gateway = trackingGateway();
  const { stub, smsTargets } = deliveryStub({ success: false });
  try {
    const error = await sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1", stub).catch((e) => e);
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "OTP_CHANNEL_UNAVAILABLE");
    assert.equal(error.status, 422, "5xx bodies are replaced by the CDN, which is why this read as a generic system failure");
    assert.match(error.message, /thử lại sau|hotline/i);
    assert.equal(gateway.log.invalidated, true, "an undelivered code must never stay usable");
    assert.equal(smsTargets.length, 0, "an unconfigured carrier is not even attempted");
  } finally {
    gateway.restore();
  }
});

test("the order's own linked email receives the challenge when SMS is unavailable", async () => {
  const gateway = trackingGateway({ shippingEmail: ORDER_EMAIL });
  const { stub, emailTargets } = deliveryStub({ success: false });
  try {
    const response = await sendGuestTrackingOtp(
      { order_code: ORDER, email: "attacker@elsewhere.test" },
      "127.0.0.1",
      stub,
    );
    assert.equal(response.success, true);
    assert.equal(response.channel, "email");
    assert.deepEqual(emailTargets, [ORDER_EMAIL], "only the address stored on the order is used");
    assert.equal(response.masked_email, maskEmail(ORDER_EMAIL));
    assert.equal(response.expires_in, GUEST_OTP_TTL_SECONDS);
    assert.equal(GUEST_OTP_TTL_SECONDS, 300, "AUTH-08: five minutes, matching the 05:00 countdown");
    assert.equal(gateway.log.invalidated, false);
  } finally {
    gateway.restore();
  }
});

test("a delivered SMS does not also send an email", async () => {
  const gateway = trackingGateway({ shippingEmail: ORDER_EMAIL });
  const { stub, smsTargets, emailTargets } = deliveryStub({ success: true });
  Object.assign(config, { twilioAccountSid: "AC123", twilioAuthToken: "token", twilioPhoneNumber: "+15005550001" });
  try {
    const response = await sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1", stub);
    assert.equal(response.channel, "sms");
    assert.deepEqual(smsTargets, ["0912345678"]);
    assert.equal(emailTargets.length, 0);
    assert.equal(response.masked_email, null);
  } finally {
    gateway.restore();
  }
});

test("a simulated SMS provider is not reported as a delivered code", async () => {
  const gateway = trackingGateway({ shippingEmail: ORDER_EMAIL });
  const { stub } = deliveryStub({ success: true, simulated: true });
  Object.assign(config, { twilioAccountSid: "AC123", twilioAuthToken: "token", twilioPhoneNumber: "+15005550001" });
  try {
    const response = await sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1", stub);
    assert.equal(response.channel, "email", "a simulated send proves nothing to the customer");
  } finally {
    gateway.restore();
  }
});

test("an order without a mobile number fails before any challenge is stored", async () => {
  const gateway = trackingGateway({ shippingPhone: "02838221212" });
  const { stub } = deliveryStub({ success: true });
  try {
    const error = await sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1", stub).catch((e) => e);
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "ORDER_PHONE_UNAVAILABLE");
    assert.equal(error.status, 409);
    assert.equal(gateway.log.issued, 0, "no challenge is issued for a number that cannot receive it");
  } finally {
    gateway.restore();
  }
});

test("local tracking uses the shared 123456 shortcut and reveals only the final phone digits", async () => {
  const gateway = trackingGateway({ shippingEmail: ORDER_EMAIL });
  const { stub } = deliveryStub({ success: false });
  config.nodeEnv = "development";
  try {
    const response = await sendGuestTrackingOtp(
      { order_code: ORDER, email: "unverified-recipient@example.test" },
      "127.0.0.1",
      stub,
    );
    assert.equal(response.success, true);
    assert.equal(response.development_otp, "123456");
    assert.equal(response.expires_in, 300);
    assert.equal(response.masked_phone, "*******678");
    assert.equal("phone" in response, false);
    assert.equal(maskTrackingPhone("+84912345678"), "*******678");
    assert.equal(gateway.log.invalidated, false);
  } finally {
    gateway.restore();
  }
});
