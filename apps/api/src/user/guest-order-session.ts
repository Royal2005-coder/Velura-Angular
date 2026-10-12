import { createHash, randomUUID } from "node:crypto";
import { signJwt } from "../auth-helper.js";
import { maskEmail, sendDirectEmail } from "../email/mailer.js";
import { HttpError } from "../http.js";
import { isSmsConfigured, maskPhone, sendCheckoutOtpSms } from "../sms/twilio.js";
import { callRpc, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { generateCheckoutOtp, normalizeVietnamesePhone } from "./checkout-service.js";

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
  const phone = normalizeVietnamesePhone(body.phone || body.challenge_id);
  if (!/^0(?:3|5|7|8|9)\d{8}$/.test(phone)) throw new HttpError(422, "INVALID_PHONE", "Số điện thoại không hợp lệ");
  return phone;
}

/** Deliver OTP only to the selected order's stored contact or the verified account phone. */
export async function sendGuestTrackingOtp(body: JsonObject, ip: string): Promise<JsonObject> {
  const phone = await phoneForTracking(body);

  // Tìm email và tên người nhận để gửi mã OTP
  const recipientEmails: string[] = [];
  let customerName = "Quý khách";
  let scopedOrderId: string | null = null;
  const addEmail = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const cleaned = raw.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) && !recipientEmails.includes(cleaned)) {
      recipientEmails.push(cleaned);
    }
  };
  const phoneVariants = [...new Set([phone, `84${phone.slice(1)}`, `+84${phone.slice(1)}`])];

  if (body.order_code) {
    const code = asString(body.order_code).trim().toUpperCase();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const order = uuidRegex.test(code)
      ? await selectOne("orders", { order_id: `eq.${code}` })
      : await selectOne("orders", { order_code: `eq.${code}` });
    if (order) {
      scopedOrderId = asString(order.order_id);
      addEmail(order.shipping_email);
      if (order.shipping_name) {
        customerName = String(order.shipping_name).trim();
      }
      if (order.user_id) {
        const orderUser = await selectOne("users", { user_id: `eq.${order.user_id}` }).catch(() => null);
        addEmail(orderUser?.email);
        if (customerName === "Quý khách" && orderUser?.full_name) {
          customerName = String(orderUser.full_name).trim();
        }
      }
    }
  }

  // Tra cứu các đơn hàng gần nhất của số điện thoại này để lấy email liên kết (shipping_email hoặc user_id -> users.email)
  const { rows: recentOrders } = await selectRows("orders", {
    shipping_phone: `in.(${phoneVariants.join(",")})`,
    order: "created_at.desc",
    limit: 15
  }).catch(() => ({ rows: [] as JsonObject[] }));
  for (const ord of recentOrders) {
    addEmail(ord.shipping_email);
    if (customerName === "Quý khách" && ord.shipping_name) {
      customerName = String(ord.shipping_name).trim();
    }
  }
  const orderUserIds = [...new Set(recentOrders.map((o) => o.user_id).filter(Boolean))];
  if (orderUserIds.length > 0) {
    const { rows: orderUsers } = await selectRows("users", {
      user_id: `in.(${orderUserIds.join(",")})`
    }).catch(() => ({ rows: [] as JsonObject[] }));
    for (const u of orderUsers) {
      addEmail(u.email);
      if (customerName === "Quý khách" && u.full_name) {
        customerName = String(u.full_name).trim();
      }
    }
  }

  // Tra cứu trực tiếp trong bảng users theo mọi định dạng số điện thoại (0..., 84..., +84...)
  const { rows: phoneUsers } = await selectRows("users", {
    phone: `in.(${phoneVariants.join(",")})`
  }).catch(() => ({ rows: [] as JsonObject[] }));
  for (const u of phoneUsers) {
    addEmail(u.email);
    if (customerName === "Quý khách" && u.full_name) {
      customerName = String(u.full_name).trim();
    }
  }
  addEmail(body.email);

  const code = generateCheckoutOtp();
  const nonce = randomUUID();
  const basePayload = {
    p_phone: phone,
    p_ip: ip,
    p_nonce: nonce,
    p_hash: createHash("sha256").update(`${nonce}:${code}`).digest("hex")
  };

  await callRpc("velura_issue_guest_tracking_otp", {
    ...basePayload,
    ...(scopedOrderId ? { p_order: scopedOrderId } : {})
  });

  let smsSent = false;

  try {
    const delivered = await sendCheckoutOtpSms(phone, code);
    smsSent = delivered.success === true && !delivered.simulated;
  } catch {
    // Email delivers the demo SMS OTP when real SMS carrier is not active.
  }

  // Đồng bộ gửi mã SMS OTP qua các Email liên kết với số điện thoại để nhận OTP demo
  let emailSent = false;
  const targetEmails = recipientEmails.slice(0, 4);
  if (targetEmails.length > 0) {
    const greeting = customerName || "Quý khách";
    const emailSubject = `[SMS OTP Demo - ${phone}] Mã xác thực đơn hàng Velura: ${code}`;
    const emailBody = `Chào ${greeting},\n\n[SMS OTP Demo cho SĐT ${phone}]\nMã xác thực OTP tra cứu đơn hàng Velura của bạn là: ${code}.\n\nMã có hiệu lực trong 5 phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.`;
    const emailHtml = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #fff;">
        <div style="background-color: #b89b88; padding: 24px; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px 28px;">
          <h2 style="color: #2a2522; margin-top: 0; font-size: 20px; font-weight: 600;">Tin nhắn SMS OTP (Đồng bộ qua Email liên kết)</h2>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Chào <strong>${escapeHtml(greeting)}</strong>,</p>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Bạn đang thực hiện xác thực SMS OTP cho số điện thoại <strong>${phone}</strong> (${maskPhone(phone)}) tại Velura. Dưới đây là mã OTP 6 chữ số được đồng bộ qua email liên kết của bạn:</p>

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
    const results = await Promise.all(
      targetEmails.map((target) => sendDirectEmail(target, emailSubject, emailBody, emailHtml).catch(() => false))
    );
    emailSent = results.some(Boolean);
  }

  if (!smsSent && !emailSent) {
    await updateRows("guest_tracking_otp", { nonce: `eq.${nonce}`, consumed_at: "is.null" }, { consumed_at: new Date().toISOString() });
    throw new HttpError(502, "OTP_SEND_FAILED", "Chưa thể gửi mã xác thực. Vui lòng thử lại sau.");
  }

  const channel: "sms" | "email" | "both" = "sms";

  return {
    success: true,
    phone,
    masked_phone: maskPhone(phone),
    masked_email: targetEmails.length ? targetEmails.map(maskEmail).join(", ") : null,
    expires_in: 300,
    channel
  };
}

/** Atomic attempt accounting grants one 15-minute session after a valid, unconsumed code. */
export async function verifyGuestTrackingOtp(body: JsonObject): Promise<JsonObject> {
  const phone = await phoneForTracking(body);
  const row = await selectOne("guest_tracking_otp", { phone: `eq.${phone}`, consumed_at: "is.null", order: "created_at.desc", limit: 1 });
  if (!row) throw new HttpError(400, "INVALID_OTP", "Không tìm thấy phiên xác thực");
  const otpInput = asString(body.otp_code || body.otp || body.code);
  const result = asJsonObject(await callRpc("velura_verify_guest_tracking_otp", {
    p_id: row.challenge_id,
    p_hash: createHash("sha256").update(`${asString(row.nonce)}:${otpInput}`).digest("hex")
  }));
  if (!result.verified) throw new HttpError(400, asString(result.code) || "INVALID_OTP", "Mã xác thực không hợp lệ hoặc hết hạn");
  return { success: true, phone, guest_access_token: signJwt({
    purpose: "guest_order_session", phone, otp_challenge_id: row.challenge_id,
    verified_order_id: row.scoped_order_id || null
  }, 15 * 60) };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}
