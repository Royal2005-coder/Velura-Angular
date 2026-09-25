import { config } from "../config.js";
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
 * Sends a 4-digit guest checkout OTP via SMS.
 *
 * @param phone Recipient phone number
 * @param otpCode 4-digit OTP string
 */
export async function sendCheckoutOtpSms(phone: string, otpCode: string): Promise<TwilioSendResult> {
  const body = `[Velura] Ma xac thuc don hang cua ban la: ${otpCode}. Ma co hieu luc trong 5 phut. Vui long khong chia se ma cho bat ky ai.`;
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
