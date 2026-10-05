import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { maskEmail, sendDirectEmail } from "../email/mailer.js";
import { HttpError } from "../http.js";
import { isSmsConfigured, maskPhone, sendCheckoutOtpSms } from "../sms/twilio.js";
import { callRpc, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, errorMessage, type JsonObject } from "../types.js";
import { generateCheckoutOtp, normalizeVietnamesePhone } from "./checkout-service.js";
import { issueGuestPhoneAccess } from "./order-access.js";

/** Resolve a tracking challenge by phone or order code while keeping delivery server-controlled. */
async function phoneForTracking(body: JsonObject): Promise<string> {
  if (body.order_code) {
    const code = asString(body.order_code).trim().toUpperCase();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let order: JsonObject | null = null;
    if (uuidRegex.test(code)) {
      order = await selectOne("orders", { order_id: `eq.${code}` });
    }
    if (!order) {
      order = await selectOne("orders", { order_code: `eq.${code}` });
    }
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng");
    return normalizeVietnamesePhone(order.shipping_phone);
  }
  const phone = normalizeVietnamesePhone(body.phone);
  if (!/^0(?:3|5|7|8|9)\d{8}$/.test(phone)) throw new HttpError(422, "INVALID_PHONE", "Số điện thoại không hợp lệ");
  return phone;
}

/**
 * Tạo và gửi mã OTP tra cứu đơn hàng: mô phỏng SMS chuẩn cho demo, đồng thời gửi email fallback để nhận mã thực hiện.
 */
export async function sendGuestTrackingOtp(body: JsonObject, ip: string): Promise<JsonObject> {
  const phone = await phoneForTracking(body);

  // Tìm email và tên người nhận để gửi mã OTP
  let recipientEmail: string | null = null;
  let customerName = "Quý khách";

  if (body.order_code) {
    const code = asString(body.order_code).trim().toUpperCase();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const order = uuidRegex.test(code)
      ? await selectOne("orders", { order_id: `eq.${code}` })
      : await selectOne("orders", { order_code: `eq.${code}` });
    if (order) {
      if (order.shipping_email && String(order.shipping_email).includes("@")) {
        recipientEmail = String(order.shipping_email).trim();
      }
      if (order.shipping_name) {
        customerName = String(order.shipping_name).trim();
      }
    }
  }

  // Nếu chưa có email từ mã đơn, tra cứu qua các đơn hàng gần nhất của số điện thoại này
  const { rows: orderRows } = await selectRows("orders", {
    shipping_phone: `eq.${phone}`,
    order: "created_at.desc",
    limit: 20
  });

  if (!recipientEmail && orderRows.length > 0) {
    const orderWithEmail = orderRows.find((r) => r.shipping_email && String(r.shipping_email).includes("@"));
    if (orderWithEmail) {
      recipientEmail = String(orderWithEmail.shipping_email).trim();
      customerName = String(orderWithEmail.shipping_name || "").trim() || customerName;
    } else if (orderRows[0]?.shipping_name) {
      customerName = String(orderRows[0].shipping_name).trim();
    }
  }

  // Nếu vẫn chưa có email, tra cứu trong bảng users
  if (!recipientEmail) {
    const user = await selectOne("users", { phone: `eq.${phone}` });
    if (user?.email && String(user.email).includes("@")) {
      recipientEmail = String(user.email).trim();
      customerName = String(user.full_name || "").trim() || customerName;
    }
  }

  // Nếu client gửi kèm email hoặc contact
  const explicitEmail = asString(body.email || body.contact).trim();
  if (!recipientEmail && explicitEmail && explicitEmail.includes("@")) {
    recipientEmail = explicitEmail;
  }

  // Fallback demo: Nếu không tìm thấy email nào, dùng email hệ thống để demo luôn nhận được mã
  if (!recipientEmail && config.smtpUser) {
    recipientEmail = config.smtpUser;
  }

  const code = generateCheckoutOtp();
  const nonce = randomUUID();

  await callRpc("velura_issue_guest_tracking_otp", {
    p_phone: phone,
    p_ip: ip,
    p_nonce: nonce,
    p_hash: createHash("sha256").update(`${nonce}:${code}`).digest("hex")
  });

  // Kéo dài thời gian hiệu lực OTP lên 5 phút (300 giây) để khớp với giao diện đếm ngược
  try {
    await updateRows("guest_tracking_otp", {
      phone: `eq.${phone}`,
      consumed_at: "is.null"
    }, {
      expires_at: new Date(Date.now() + 300 * 1000).toISOString()
    });
  } catch {
    /* ignore */
  }

  let smsSent = false;
  let smsSimulated = false;

  // Gửi qua SMS nếu nhà cung cấp đã cấu hình
  if (isSmsConfigured()) {
    try {
      const delivered = await sendCheckoutOtpSms(phone, code);
      smsSent = delivered.success === true && !delivered.simulated;
      smsSimulated = delivered.simulated === true;
      console.log(`[TRACKING SMS] Phone: ${phone}, success: ${smsSent}, simulated: ${smsSimulated}`);
    } catch (smsErr) {
      console.warn(`[TRACKING SMS WARN] Could not deliver SMS to ${phone}:`, errorMessage(smsErr));
    }
  } else {
    smsSimulated = true;
    console.log(`[TRACKING SMS MOCK] SMS provider not configured. Simulated standard SMS for demo.`);
  }

  // Đồng thời gửi OTP qua Email
  let emailSent = false;
  if (recipientEmail) {
    const greeting = customerName || "Quý khách";
    const emailSubject = `Mã xác thực tra cứu đơn hàng Velura: ${code}`;
    const emailBody = `Chào ${greeting},\n\nMã xác thực OTP tra cứu đơn hàng Velura của bạn là: ${code}.\n\nMã có hiệu lực trong 5 phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.`;
    const emailHtml = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #fff;">
        <div style="background-color: #b89b88; padding: 24px; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px 28px;">
          <h2 style="color: #2a2522; margin-top: 0; font-size: 20px; font-weight: 600;">Tra cứu &amp; Quản lý đơn hàng</h2>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Chào <strong>${greeting}</strong>,</p>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Bạn đang thực hiện tra cứu thông tin hành trình đơn hàng tại Velura cho số điện thoại <strong>${maskPhone(phone)}</strong>. Vui lòng sử dụng mã xác thực OTP dưới đây:</p>

          <div style="background-color: #fcfaf8; border: 1px dashed #b89b88; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
            <span style="font-size: 36px; font-weight: bold; color: #8e6d53; letter-spacing: 12px; display: inline-block; margin-left: 12px;">${code}</span>
          </div>

          <p style="color: #777; font-size: 14px; text-align: center; margin-bottom: 0;">Mã có hiệu lực trong <strong>5 phút</strong>. Vui lòng không chia sẻ mã này cho bất kỳ ai.</p>
        </div>
        <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
          <p style="color: #999; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
        </div>
      </div>
    `;
    try {
      emailSent = await sendDirectEmail(recipientEmail, emailSubject, emailBody, emailHtml);
      console.log(`[TRACKING OTP EMAIL] Sent to ${recipientEmail}: ${emailSent}`);
    } catch (mailErr) {
      console.error(`[TRACKING OTP EMAIL ERROR] Failed to send email to ${recipientEmail}:`, mailErr);
    }
  }

  console.log(`\n==================================================`);
  console.log(`[TRACKING OTP ISSUED] Phone: ${phone} | Code: ${code} | Email: ${recipientEmail || "none"} | SMS Sent: ${smsSent} | Email Sent: ${emailSent}`);
  console.log(`==================================================\n`);

  if (!smsSent && !emailSent && !smsSimulated && config.nodeEnv === "production") {
    throw new HttpError(502, "OTP_SEND_FAILED", "Chưa thể gửi mã xác thực. Vui lòng thử lại sau.");
  }

  const channel: "sms" | "email" | "both" = smsSent && emailSent ? "both" : emailSent ? "email" : "sms";

  return {
    success: true,
    masked_phone: maskPhone(phone),
    masked_email: recipientEmail ? maskEmail(recipientEmail) : null,
    expires_in: 300,
    channel
  };
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
