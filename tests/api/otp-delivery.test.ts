import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AuthOtpRateLimiter } from "../../apps/api/src/user/auth.js";
import { requireSmsDelivery } from "../../apps/api/src/sms/twilio.js";

const ROOT = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

test("requireSmsDelivery passes only when the provider confirmed delivery", () => {
  assert.doesNotThrow(() => requireSmsDelivery({ success: true, sid: "SM1", status: "sent" }, "không gửi được"));
  assert.doesNotThrow(() =>
    requireSmsDelivery({ success: true, simulated: true, sid: "SIM_SM1", status: "simulated_sent" }, "không gửi được")
  );
  assert.throws(
    () => requireSmsDelivery({ success: false, code: 21211, error: "invalid To" }, "Chưa thể gửi mã OTP."),
    (error: { status?: number; code?: string }) => error.status === 502 && error.code === "SMS_SEND_FAILED"
  );
});

test("AuthOtpRateLimiter caps SMS sends per identity so a real Twilio bill cannot be burned", () => {
  const limiter = new AuthOtpRateLimiter();
  const now = 1_000_000_000;
  limiter.consume("0912345678", "1.1.1.1", now);
  limiter.consume("0912345678", "1.1.1.1", now + 1000);
  limiter.consume("0912345678", "1.1.1.1", now + 2000);
  assert.throws(
    () => limiter.consume("0912345678", "1.1.1.1", now + 3000),
    (error: { code?: string }) => error.code === "OTP_SEND_RATE_LIMIT"
  );

  // Cửa sổ 15 phút trượt theo thời gian nên lại được gửi.
  assert.doesNotThrow(() => limiter.consume("0912345678", "1.1.1.1", now + 16 * 60 * 1000));
});

test("AuthOtpRateLimiter caps distinct identities per IP", () => {
  const limiter = new AuthOtpRateLimiter();
  const now = 2_000_000_000;
  for (let index = 0; index < 10; index += 1) {
    limiter.consume(`09${String(index).padStart(8, "0")}`, "2.2.2.2", now + index);
  }
  assert.throws(
    () => limiter.consume("0911111199", "2.2.2.2", now + 50),
    (error: { code?: string }) => error.code === "OTP_SEND_IP_RATE_LIMIT"
  );
});

test("no OTP route fires SMS without awaiting the provider", async () => {
  const [auth, orders] = await Promise.all([
    source("apps/api/src/user/auth.ts"),
    source("apps/api/src/user/order-router.ts")
  ]);
  assert.doesNotMatch(auth, /void\s+sendAuthOtpSms/);
  assert.doesNotMatch(orders, /void\s+sendCheckoutOtpSms/);
  assert.match(orders, /void\s+sendGuestOrderWelcomeSms\(/);
  assert.doesNotMatch(orders, /sendTwilioSms\([^;]+activationUrl/s);
  assert.match(auth, /await\s+deliverAuthOtp\(/);
  assert.match(auth, /OTP_SEND_RATE_LIMIT/);
  // Route chỉ trả 200 khi ít nhất một kênh thật sự nhận được tin.
  assert.match(orders, /if \(!smsSent && !emailSent\)/);
  assert.doesNotMatch(orders, /const emailSent = Boolean\(otpEmail\)/);
});

test("Twilio credentials are documented in the env template", async () => {
  const env = await source(".env.example");
  for (const key of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_MESSAGING_SERVICE_SID"
  ]) {
    assert.match(env, new RegExp(`^${key}=`, "m"));
  }
});

test("guest order email includes tracking, phone account and optional activation", async () => {
  const orders = await source("apps/api/src/user/order-router.ts");
  assert.match(orders, /Tài khoản Velura:/);
  assert.match(orders, /Tra cứu đơn hàng tại:/);
  assert.match(orders, /liên kết dùng một lần, có hiệu lực trong 24 giờ/);
  assert.match(orders, /mật khẩu do bạn tự đặt/);
});

test("guest success messages are dispatched only after the order is persisted", async () => {
  const orders = await source("apps/api/src/user/order-router.ts");
  const persisted = orders.indexOf("const persistedGuestOrder = await checkoutService.persistOrder");
  const email = orders.indexOf("void sendDirectEmail(notice.targetEmail");
  const sms = orders.indexOf("void sendGuestOrderWelcomeSms(asString(phone)");
  assert.ok(persisted >= 0);
  assert.ok(email > persisted);
  assert.ok(sms > persisted);
  assert.match(orders, /if \(dbPaymentMethod === "COD" && guestEmailNotification\)/);
  assert.match(orders, /if \(dbPaymentMethod === "COD" && phone\)/);
});
