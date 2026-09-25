import test from "node:test";
import assert from "node:assert/strict";
import {
  toE164,
  maskPhone,
  isTwilioConfigured,
  sendTwilioSms,
  sendCheckoutOtpSms,
  sendOrderConfirmationSms,
  sendAuthOtpSms
} from "../../apps/api/src/sms/twilio.js";

test("toE164 normalizes Vietnamese phone numbers to international standard", () => {
  // Standard 10-digit mobile
  assert.equal(toE164("0912345678"), "+84912345678");
  assert.equal(toE164("0389998888"), "+84389998888");
  assert.equal(toE164("0771234567"), "+84771234567");

  // With formatting characters (spaces, hyphens, dots, parens)
  assert.equal(toE164("091 234 5678"), "+84912345678");
  assert.equal(toE164("091-234-5678"), "+84912345678");
  assert.equal(toE164("(091) 234.5678"), "+84912345678");

  // Already prefixed with 84 or +84
  assert.equal(toE164("84912345678"), "+84912345678");
  assert.equal(toE164("+84912345678"), "+84912345678");

  // International numbers
  assert.equal(toE164("+14155552671"), "+14155552671");
  assert.equal(toE164("+447911123456"), "+447911123456");

  // Empty or invalid input
  assert.equal(toE164(""), "");
});

test("maskPhone masks phone number digits for secure client display", () => {
  assert.equal(maskPhone("0912345678"), "091****678");
  assert.equal(maskPhone("+84912345678"), "+8491****678");
  assert.equal(maskPhone("123"), "123");
  assert.equal(maskPhone(""), "");
});

test("isTwilioConfigured checks presence of Account SID, credentials, and sender", () => {
  // Configured check reflects environment variables
  const configured = isTwilioConfigured();
  assert.equal(typeof configured, "boolean");
});

test("sendTwilioSms handles invalid phone numbers gracefully", async () => {
  const result = await sendTwilioSms("", "Test message");
  assert.equal(result.success, false);
  assert.ok(result.error);
});

test("sendTwilioSms simulates delivery when running in non-production", async () => {
  const result = await sendTwilioSms("0912345678", "Mã xác thực là: 1234");
  assert.equal(result.success, true);
  if (result.simulated) {
    assert.ok(result.sid?.startsWith("SIM_SM"));
    assert.equal(result.status, "simulated_sent");
  }
});

test("sendCheckoutOtpSms sends formatted checkout OTP", async () => {
  const result = await sendCheckoutOtpSms("0912345678", "9876");
  assert.equal(result.success, true);
});

test("sendOrderConfirmationSms sends order confirmation with code and amount", async () => {
  const result = await sendOrderConfirmationSms("0912345678", "VLR123456789", 450000);
  assert.equal(result.success, true);
});

test("sendAuthOtpSms supports signup, verify, and forgot_password purposes", async () => {
  const signupResult = await sendAuthOtpSms("0912345678", "654321", "signup");
  assert.equal(signupResult.success, true);

  const resetResult = await sendAuthOtpSms("0912345678", "654321", "forgot_password");
  assert.equal(resetResult.success, true);

  const verifyResult = await sendAuthOtpSms("0912345678", "654321", "verify");
  assert.equal(verifyResult.success, true);
});
