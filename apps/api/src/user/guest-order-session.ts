import { createHash, randomUUID } from "node:crypto";
import { signJwt } from "../auth-helper.js";
import { maskEmail, sendDirectEmail } from "../email/mailer.js";
import { HttpError } from "../http.js";
import { isSmsConfigured, sendCheckoutOtpSms } from "../sms/twilio.js";
import { callRpc, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { generateCheckoutOtp, normalizeVietnamesePhone } from "./checkout-service.js";
import { allowDevOtpBypass } from "../config.js";
import { OTP_TTL_MS } from "./otp-policy.js";

/** AUTH-08: cùng một hạn 5 phút cho OTP tra cứu đơn, tính bằng giây cho UI đếm ngược. */
export const GUEST_OTP_TTL_SECONDS = Math.floor(OTP_TTL_MS / 1000);

/** Tracking notices reveal only the final three digits of the order phone. */
export function maskTrackingPhone(phone: string): string {
  const normalized = normalizeVietnamesePhone(phone);
  return normalized ? `${"*".repeat(Math.max(0, normalized.length - 3))}${normalized.slice(-3)}` : "";
}

/** Mobile prefixes actually in use; a landline or malformed stored number cannot receive a challenge. */
const TRACKING_PHONE = /^0(?:3|5|7|8|9)\d{8}$/;

/**
 * Delivery seams. Production uses SMS first and the customer's linked email as the fallback;
 * tests inject stubs so the fallback is proven without a live carrier or SMTP server.
 */
export interface GuestOtpDelivery {
  sendSms: (phone: string, code: string) => Promise<{ success?: boolean; simulated?: boolean }>;
  sendEmail: (to: unknown, subject: string, text: string, html: string) => Promise<boolean>;
}

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
    const phone = normalizeVietnamesePhone(order.shipping_phone);
    if (!TRACKING_PHONE.test(phone)) {
      throw new HttpError(409, "ORDER_PHONE_UNAVAILABLE", "Đơn này không có số điện thoại hợp lệ để gửi mã xác thực. Vui lòng kiểm tra lại thông tin nhận hàng.");
    }
    return phone;
  }
  const phone = normalizeVietnamesePhone(body.phone || body.challenge_id);
  if (!TRACKING_PHONE.test(phone)) throw new HttpError(422, "INVALID_PHONE", "Số điện thoại không hợp lệ");
  return phone;
}

/** Deliver the challenge by SMS first, then by the order's own linked email; never by a typed-in address. */
export async function sendGuestTrackingOtp(
  body: JsonObject,
  ip: string,
  delivery: GuestOtpDelivery = { sendSms: sendCheckoutOtpSms, sendEmail: sendDirectEmail }
): Promise<JsonObject> {
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

  const developmentOtp = allowDevOtpBypass();
  const code = developmentOtp ? "123456" : generateCheckoutOtp();
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
  if (!developmentOtp && isSmsConfigured()) {
    try {
      const delivered = await delivery.sendSms(phone, code);
      smsSent = delivered.success === true && delivered.simulated !== true;
    } catch {
      smsSent = false;
    }
  }

  // Email is the standing fallback, not a dev aid: without it a customer whose SMS carrier is
  // not configured cannot reach their own order. Recipients are always read from the order and
  // the accounts bound to that phone — never from whatever address the caller typed.
  const targetEmails = smsSent ? [] : recipientEmails.slice(0, 4);
  let emailSent = false;
  if (targetEmails.length > 0) {
    const greeting = customerName || "Quý khách";
    const masked = maskTrackingPhone(phone);
    const emailSubject = `[Velura] Mã xác thực tra cứu đơn hàng (${masked}): ${code}`;
    const emailBody = `Chào ${greeting},\n\nMã xác thực OTP tra cứu đơn hàng Velura của bạn (SĐT ${masked}) là: ${code}.\n\nMã có hiệu lực trong ${Math.floor(GUEST_OTP_TTL_SECONDS / 60)} phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.`;
    const emailHtml = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #fff;">
        <div style="background-color: #b89b88; padding: 24px; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px 28px;">
          <h2 style="color: #2a2522; margin-top: 0; font-size: 20px; font-weight: 600;">Mã xác thực tra cứu đơn hàng</h2>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Chào <strong>${escapeHtml(greeting)}</strong>,</p>
          <p style="color: #555; line-height: 1.6; font-size: 15px;">Bạn đang xác thực để tra cứu đơn hàng của số điện thoại <strong>${escapeHtml(masked)}</strong> tại Velura. Mã OTP 6 chữ số của bạn:</p>

          <div style="background-color: #fcfaf8; border: 1px dashed #b89b88; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
            <span style="font-size: 36px; font-weight: bold; color: #8e6d53; letter-spacing: 12px; display: inline-block; margin-left: 12px;">${code}</span>
          </div>

          <p style="color: #777; font-size: 14px; text-align: center; margin-bottom: 0;">Mã có hiệu lực trong <strong>${Math.floor(GUEST_OTP_TTL_SECONDS / 60)} phút</strong>. Vui lòng không chia sẻ mã này cho bất kỳ ai.</p>
        </div>
        <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
          <p style="color: #999; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
        </div>
      </div>
    `;
    const sent = await Promise.all(
      targetEmails.map((target) => delivery.sendEmail(target, emailSubject, emailBody, emailHtml).catch(() => false))
    );
    emailSent = sent.some((ok) => ok === true);
  }

  if (!developmentOtp && !smsSent && !emailSent) {
    // The challenge stays unusable, and the customer gets a 4xx the UI can actually show:
    // Cloudflare replaces 5xx bodies, which is why this used to read "hệ thống chưa xử lý được".
    await updateRows("guest_tracking_otp", { nonce: `eq.${nonce}`, consumed_at: "is.null" }, { consumed_at: new Date().toISOString() });
    throw new HttpError(
      422,
      "OTP_CHANNEL_UNAVAILABLE",
      "Chưa gửi được mã xác thực qua tin nhắn hoặc email liên kết của đơn. Vui lòng thử lại sau, hoặc liên hệ hotline Velura để được hỗ trợ."
    );
  }

  const channel: "sms" | "email" | "dev" = developmentOtp ? "dev" : smsSent ? "sms" : "email";

  return {
    success: true,
    masked_phone: maskTrackingPhone(phone),
    masked_email: emailSent ? targetEmails.map(maskEmail).join(", ") : null,
    expires_in: GUEST_OTP_TTL_SECONDS,
    channel,
    message: developmentOtp
      ? "Nhập mã OTP mặc định 123456 để xác thực tra cứu đơn hàng."
      : smsSent
        ? `Mã OTP đã được gửi tới số điện thoại ${maskTrackingPhone(phone)}.`
        : `Mã xác thực đã được gửi tới email liên kết của đơn. Mã có hiệu lực trong ${Math.floor(GUEST_OTP_TTL_SECONDS / 60)} phút.`,
    development_otp: developmentOtp ? "123456" : undefined
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
