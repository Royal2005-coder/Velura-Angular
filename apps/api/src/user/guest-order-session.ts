import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { callRpc, selectOne } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { isSmsConfigured, sendCheckoutOtpSms, maskPhone } from "../sms/twilio.js";
import { generateCheckoutOtp, normalizeVietnamesePhone } from "./checkout-service.js";
import { issueGuestPhoneAccess } from "./order-access.js";

/** Resolve a tracking challenge by phone or order code while keeping delivery server-controlled. */
async function phoneForTracking(body: JsonObject): Promise<string> {
  if (body.order_code) {
    const order = await selectOne("orders", { order_code: `eq.${asString(body.order_code).trim().toUpperCase()}` });
    if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
    return normalizeVietnamesePhone(order.shipping_phone);
  }
  const phone = normalizeVietnamesePhone(body.phone);
  if (!/^0(?:3|5|7|8|9)\d{8}$/.test(phone)) throw new HttpError(422, "INVALID_PHONE", "Số điện thoại không hợp lệ");
  return phone;
}

/** Store an OTP hash and rate limits in the database, then send only to the verified phone destination. */
export async function sendGuestTrackingOtp(body: JsonObject, ip: string): Promise<JsonObject> {
  if (!isSmsConfigured()) throw new HttpError(503, "OTP_SERVICE_UNAVAILABLE", "Dịch vụ SMS chưa sẵn sàng");
  const phone = await phoneForTracking(body);
  const code = generateCheckoutOtp();
  const nonce = randomUUID();
  await callRpc("velura_issue_guest_tracking_otp", {
    p_phone: phone, p_ip: ip, p_nonce: nonce, p_hash: createHash("sha256").update(`${nonce}:${code}`).digest("hex")
  });
  const delivered = await sendCheckoutOtpSms(phone, code);
  if (!delivered.success || delivered.simulated) throw new HttpError(502, "OTP_SEND_FAILED", "Chưa gửi được SMS xác thực");
  return { success: true, masked_phone: maskPhone(phone), expires_in: 60 };
}

/** Atomic attempt accounting grants one 15-minute session after a valid, unconsumed code. */
export async function verifyGuestTrackingOtp(body: JsonObject): Promise<JsonObject> {
  const phone = await phoneForTracking(body);
  const row = await selectOne("guest_tracking_otp", { phone: `eq.${phone}`, consumed_at: "is.null", order: "created_at.desc", limit: 1 });
  if (!row) throw new HttpError(400, "INVALID_OTP", "Không tìm thấy phiên xác thực");
  const result = asJsonObject(await callRpc("velura_verify_guest_tracking_otp", {
    p_id: row.challenge_id,
    p_hash: createHash("sha256").update(`${asString(row.nonce)}:${asString(body.otp_code || body.otp)}`).digest("hex")
  }));
  if (!result.verified) throw new HttpError(400, asString(result.code) || "INVALID_OTP", "Mã xác thực không hợp lệ hoặc hết hạn");
  return { success: true, phone, guest_access_token: issueGuestPhoneAccess(phone) };
}
