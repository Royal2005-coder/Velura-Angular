import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { errorMessage } from "../types.js";

/**
 * Result of attempting to send an SMS via Twilio.
 */
export interface TwilioSendResult {
  success: boolean;
  sid?: string;
  status?: string;
  error?: string;
  code?: number;
  simulated?: boolean;
}

/**
 * Normalizes phone numbers to standard E.164 international format.
 * Defaults to Vietnam country code (+84) when local format (09..., 03..., 07..., 08..., 05...) is detected.
 *
 * @param phone Raw phone number from client or database
 * @returns Normalized E.164 phone string (e.g., "+84912345678")
 */
export function toE164(phone: string): string {
  if (!phone) return "";
  let clean = phone.trim().replace(/[\s().-]/g, "");
  if (clean.startsWith("+")) {
    return clean;
  }
  if (clean.startsWith("84") && clean.length >= 10 && clean.length <= 12) {
    return `+${clean}`;
  }
  if (clean.startsWith("0") && clean.length === 10) {
    return `+84${clean.slice(1)}`;
  }
  if (/^\d{9,15}$/.test(clean)) {
    return `+84${clean}`;
  }
  return clean;
}

/**
 * Masks a phone number for secure client-facing display (e.g. "091****567" or "+8491****567").
 *
 * @param phone The raw or normalized phone number
 * @returns Masked phone string
 */
export function maskPhone(phone: string): string {
  if (!phone) return "";
  const clean = phone.trim();
  if (clean.length < 7) return clean;
  const startLen = clean.startsWith("+") ? 5 : 3;
  const endLen = 3;
  const prefix = clean.slice(0, startLen);
  const suffix = clean.slice(-endLen);
  return `${prefix}****${suffix}`;
}

/**
 * Checks whether Twilio credentials and phone/service sender are configured.
 */
export function isTwilioConfigured(): boolean {
  const hasAccount = Boolean(config.twilioAccountSid);
  const hasCredentials = Boolean(
    (config.twilioApiKeySid && config.twilioApiKeySecret) ||
    (config.twilioAccountSid && config.twilioAuthToken)
  );
  const hasSender = Boolean(config.twilioPhoneNumber || config.twilioMessagingServiceSid);
  return hasAccount && hasCredentials && hasSender;
}

/** Checks whether the selected eSMS account and an approved Brandname are configured. */
export function isEsmsConfigured(): boolean {
  return Boolean(config.esmsApiKey && config.esmsSecretKey && config.esmsBrandname);
}

/** Checks whether Stringee can authenticate REST SMS requests and identify the approved sender. */
export function isStringeeConfigured(): boolean {
  return Boolean(config.stringeeApiKeySid && config.stringeeApiKeySecret && config.stringeeBrandname);
}

/** Checks whether the selected SMS provider can accept delivery requests. */
export function isSmsConfigured(): boolean {
  if (config.smsProvider === "esms") return isEsmsConfigured();
  if (config.smsProvider === "stringee") return isStringeeConfigured();
  return isTwilioConfigured();
}

/** Builds the short-lived HS256 credential required by Stringee's server-side SMS REST API. */
export function createStringeeRestJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object | string) => Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value)
  ).toString("base64url");
  const header = encode({ typ: "JWT", alg: "HS256", cty: "stringee-api;v=1" });
  const payload = encode({
    jti: `${config.stringeeApiKeySid}_${nowSeconds}`,
    iss: config.stringeeApiKeySid,
    exp: nowSeconds + 300,
    rest_api: true
  });
  const signature = createHmac("sha256", config.stringeeApiKeySecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Sends one transactional SMS through Stringee using the approved Velura Brandname. */
async function sendStringeeSms(to: string, body: string): Promise<TwilioSendResult> {
  if (!isStringeeConfigured()) {
    return { success: false, error: "Stringee chưa cấu hình đủ API Key SID, API Key Secret và Brandname" };
  }
  const destination = toE164(to).replace(/^\+/, "");
  if (!destination) return { success: false, error: "Số điện thoại không hợp lệ hoặc để trống" };

  try {
    const response = await withTimeout(fetch("https://api.stringee.com/v1/sms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-STRINGEE-AUTH": createStringeeRestJwt()
      },
      body: JSON.stringify({
        sms: [{ from: config.stringeeBrandname, to: destination, text: body }]
      })
    }), 12000, "Stringee SMS");
    const payload = await response.json() as Record<string, unknown>;
    const results = Array.isArray(payload.result) ? payload.result as Record<string, unknown>[] : [];
    const first = results[0] ?? {};
    const code = Number(first.r ?? response.status);
    const success = response.ok && Number(payload.smsSent ?? 0) > 0 && code === 0;
    if (!success) {
      const providerMessage = String(first.msg || `HTTP ${response.status}`);
      console.error(`[STRINGEE SMS ERROR] Code: ${code}. Message: ${providerMessage}`);
      return { success: false, code, error: providerMessage };
    }
    return { success: true, status: "accepted" };
  } catch (err: unknown) {
    const providerMessage = errorMessage(err);
    console.error("[STRINGEE SMS EXCEPTION]", providerMessage);
    return { success: false, error: providerMessage };
  }
}

/** Sends an SMS through eSMS using the account's approved customer-care Brandname. */
async function sendEsmsSms(to: string, body: string): Promise<TwilioSendResult> {
  if (!isEsmsConfigured()) {
    return { success: false, error: "eSMS chưa cấu hình đủ API key, secret và Brandname" };
  }

  try {
    const response = await withTimeout(
      fetch("https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ApiKey: config.esmsApiKey,
          SecretKey: config.esmsSecretKey,
          Phone: toE164(to).replace(/^\+84/, "0"),
          Content: body,
          Brandname: config.esmsBrandname,
          SmsType: "2",
          IsUnicode: "0"
        })
      }),
      12000,
      "eSMS"
    );
    const payload = await response.json() as Record<string, unknown>;
    const code = String(payload.CodeResult || payload.CodeResponse || "");
    if (!response.ok || code !== "100") {
      const providerMessage = String(payload.ErrorMessage || payload.Message || `HTTP ${response.status}`);
      console.error(`[eSMS ERROR] Code: ${code || response.status}. Message: ${providerMessage}`);
      return { success: false, code: Number(code) || response.status, error: providerMessage };
    }
    return {
      success: true,
      sid: String(payload.SMSID || payload.SmsId || ""),
      status: "accepted"
    };
  } catch (err: unknown) {
    const providerMessage = errorMessage(err);
    console.error("[eSMS EXCEPTION]", providerMessage);
    return { success: false, error: providerMessage };
  }
}

/**
 * Executes a promise with an enforced timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Sends an SMS message using Twilio REST API.
 * Uses HTTP Basic Auth with API Key SID/Secret or Account SID/Auth Token.
 *
 * In development or when credentials are not yet configured, simulates sending
 * and logs the payload to the console without breaking execution.
 *
 * @param to Recipient phone number (local or international)
 * @param body SMS text content (UTF-8)
 * @returns TwilioSendResult indicating delivery status or error
 */
export async function sendTwilioSms(to: string, body: string): Promise<TwilioSendResult> {
  if (config.smsProvider === "esms") {
    return sendEsmsSms(to, body);
  }
  if (config.smsProvider === "stringee") {
    return sendStringeeSms(to, body);
  }
  const formattedTo = toE164(to);
  if (!formattedTo) {
    return { success: false, error: "Số điện thoại không hợp lệ hoặc để trống" };
  }

  const accountSid = config.twilioAccountSid;
  const configured = isTwilioConfigured();

  // If Twilio is not fully configured, log diagnostic and handle gracefully
  if (!configured) {
    if (config.nodeEnv !== "production") {
      console.log(`\n==================================================`);
      console.log(`[TWILIO SMS SIMULATED] To: ${formattedTo} (${to})`);
      console.log(`[TWILIO SMS BODY] ${body}`);
      console.log(`==================================================\n`);
      return {
        success: true,
        simulated: true,
        sid: `SIM_SM${Date.now()}`,
        status: "simulated_sent"
      };
    }
    console.warn(`[TWILIO SMS WARNING] Twilio is not fully configured. Missing Account SID or Sender Phone. Target: ${formattedTo}`);
    return {
      success: false,
      error: "Twilio SMS chưa được cấu hình đầy đủ Account SID và Phone Number"
    };
  }

  // Construct Basic Auth credentials:
  // Twilio accepts API Key SID as username and API Key Secret as password.
  const username = config.twilioApiKeySid || config.twilioAccountSid;
  const password = config.twilioApiKeySecret || config.twilioAuthToken;
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const payload = new URLSearchParams();
  payload.append("To", formattedTo);
  if (config.twilioMessagingServiceSid) {
    payload.append("MessagingServiceSid", config.twilioMessagingServiceSid);
  } else if (config.twilioPhoneNumber) {
    payload.append("From", config.twilioPhoneNumber);
  }
  payload.append("Body", body);

  try {
    const res = await withTimeout(
      fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: payload.toString()
      }),
      12000,
      "Twilio SMS"
    );

    const responseText = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }

    if (!res.ok) {
      const errorCode = typeof data.code === "number" ? data.code : res.status;
      const errorMessageStr = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
      console.error(`[TWILIO SMS ERROR] Failed to send to ${formattedTo}. Code: ${errorCode}. Message: ${errorMessageStr}`);
      return {
        success: false,
        code: errorCode,
        error: errorMessageStr
      };
    }

    const sid = typeof data.sid === "string" ? data.sid : "";
    const status = typeof data.status === "string" ? data.status : "sent";
    console.log(`[TWILIO SMS SUCCESS] Message sent to ${formattedTo}. SID: ${sid}, Status: ${status}`);
    return {
      success: true,
      sid,
      status
    };
  } catch (err: unknown) {
    const errorStr = errorMessage(err);
    console.error(`[TWILIO SMS EXCEPTION] Error sending SMS to ${formattedTo}:`, errorStr);
    return {
      success: false,
      error: errorStr
    };
  }
}

/**
 * Ném lỗi khi Twilio không gửi được tin, để router không báo "đã gửi thành công" cho client.
 * OTP là bằng chứng xác thực: chỉ coi là gửi thành công khi nhà cung cấp xác nhận đã nhận.
 * Lỗi provider đã được log ở sendTwilioSms nên response chỉ nói nguyên nhân cho người dùng.
 *
 * @param result Kết quả trả về từ sendTwilioSms
 * @param message Thông báo thân thiện hiển thị cho client
 */
export function requireSmsDelivery(result: TwilioSendResult, message: string): void {
  if (result.success) return;
  throw new HttpError(502, "SMS_SEND_FAILED", message);
}

/**
 * Sends a 4-digit guest checkout OTP via SMS.
 *
 * @param phone Recipient phone number
 * @param otpCode 4-digit OTP string
 */
export async function sendCheckoutOtpSms(phone: string, otpCode: string): Promise<TwilioSendResult> {
  if (config.smsProvider === "esms") {
    return sendEsmsSms(
      phone,
      `${otpCode} la ma xac nhan so dien thoai tai Velura. Ma co hieu luc 5 phut. Khong chia se ma nay.`
    );
  }
  const body = `[Velura] Ma xac thuc don hang cua ban la: ${otpCode}. Ma co hieu luc trong 5 phut. Vui long khong chia se ma cho bat ky ai.`;
  return sendTwilioSms(phone, body);
}

/**
 * Sends one post-checkout message with the order summary and an optional,
 * one-time account activation link. No password is ever sent over SMS.
 */
export async function sendGuestOrderWelcomeSms(
  phone: string,
  orderCode: string,
  totalAmount: number,
  activationUrl: string | null
): Promise<TwilioSendResult> {
  const formattedTotal = `${totalAmount.toLocaleString("vi-VN")}d`;
  const accountHelp = activationUrl
    ? ` Tai khoan: ${toE164(phone)}. Neu muon tro thanh vien, kich hoat va tu dat mat khau trong 24 gio: ${activationUrl}`
    : " Don hang da duoc lien ket voi tai khoan Velura hien co.";
  const body = `Velura da tiep nhan don ${orderCode}. Tong thanh toan: ${formattedTotal}. Tra cuu: https://velura.royalai.dev/account/track?code=${encodeURIComponent(orderCode)}.${accountHelp}`;
  return sendTwilioSms(phone, body);
}

/**
 * Sends order placement confirmation via SMS.
 *
 * @param phone Customer phone number
 * @param orderCode Unique order tracking code (e.g., "VLR...")
 * @param totalAmount Order total in VND
 */
export async function sendOrderConfirmationSms(
  phone: string,
  orderCode: string,
  totalAmount: number
): Promise<TwilioSendResult> {
  const formattedTotal = `${totalAmount.toLocaleString("vi-VN")}d`;
  const body = `[Velura] Don hang #${orderCode} da duoc tiep nhan thanh cong. Tong thanh toan: ${formattedTotal}. Tra cuu tai: https://velura.royalai.dev/account/track?code=${orderCode}`;
  return sendTwilioSms(phone, body);
}

/**
 * Sends authentication OTP (signup activation, password reset, or account verification).
 *
 * @param phone Recipient phone number
 * @param otpCode 6-digit OTP string
 * @param purpose Purpose of OTP ('signup' | 'forgot_password' | 'verify')
 */
export async function sendAuthOtpSms(
  phone: string,
  otpCode: string,
  purpose: "signup" | "forgot_password" | "verify" = "verify"
): Promise<TwilioSendResult> {
  if (config.smsProvider === "esms") {
    const action = purpose === "forgot_password" ? "dat lai mat khau" : "xac minh dang ky";
    return sendEsmsSms(phone, `${otpCode} la ma ${action} ${config.esmsBrandname} cua ban`);
  }
  let body = "";
  if (purpose === "signup") {
    body = `[Velura] Ma OTP kich hoat tai khoan cua ban la: ${otpCode}. Co hieu luc trong 10 phut.`;
  } else if (purpose === "forgot_password") {
    body = `[Velura] Ma OTP khoi phuc mat khau cua ban la: ${otpCode}. Co hieu luc trong 5 phut.`;
  } else {
    body = `[Velura] Ma OTP xac thuc tai khoan cua ban la: ${otpCode}. Co hieu luc trong 5 phut.`;
  }
  return sendTwilioSms(phone, body);
}
