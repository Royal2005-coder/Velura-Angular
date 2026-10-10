import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import { sendGuestTrackingOtp } from "../../apps/api/src/user/guest-order-session.js";

const ORDER = "44444444-4444-4444-8444-444444444444";

function trackingGateway(issueStatus = 200) {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, { supabaseUrl: "https://tracking.test", supabaseServiceRoleKey: "test-service", nodeEnv: "production", smtpHost: "", smtpUser: "", smtpAppPassword: "", supportAlertTo: "staff@example.test", twilioAccountSid: "", twilioAuthToken: "", twilioApiKeySid: "", twilioApiKeySecret: "", esmsApiKey: "", stringeeApiKeySid: "" });
  let invalidated = false;
  let scopeLost = false;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    let data: unknown = [];
    let status = 200;
    if (url.pathname.endsWith("/orders")) data = [{ order_id: ORDER, shipping_phone: "0912345678", shipping_name: "Customer" }];
    if (url.pathname.endsWith("/rpc/velura_issue_guest_tracking_otp")) {
      const payload = JSON.parse(String(init?.body));
      scopeLost ||= payload.p_order !== ORDER;
      status = issueStatus;
      data = status === 200 ? null : { code: "PGRST202", message: "Missing scoped OTP function" };
    }
    if (url.pathname.endsWith("/guest_tracking_otp") && init?.method === "PATCH") invalidated = true;
    return new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { get invalidated() { return invalidated; }, get scopeLost() { return scopeLost; }, restore() { globalThis.fetch = originalFetch; Object.assign(config, saved); } };
}

test("an order challenge cannot downgrade to unscoped authorization when scoped issuance fails", async () => {
  const gateway = trackingGateway(404);
  try {
    await assert.rejects(sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1"), HttpError);
    assert.equal(gateway.scopeLost, false);
    assert.equal(gateway.invalidated, false);
  } finally { gateway.restore(); }
});

test("an undelivered customer OTP is invalidated instead of sent to staff or reported successful", async () => {
  const gateway = trackingGateway();
  try {
    await assert.rejects(sendGuestTrackingOtp({ order_code: ORDER }, "127.0.0.1"), (error: unknown) => error instanceof HttpError && error.code === "OTP_SEND_FAILED");
    assert.equal(gateway.invalidated, true);
    assert.equal(gateway.scopeLost, false);
  } finally { gateway.restore(); }
});
