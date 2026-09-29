import { config } from "../config.js";
import { errorMessage } from "../types.js";
import type { TwilioSendResult } from "./twilio.js";

const ESMS_URL = "https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/";

/**
 * True when eSMS ApiKey and SecretKey are both set.
 */
export function isEsmsConfigured(): boolean {
  return Boolean(config.esmsApiKey && config.esmsSecretKey);
}

/**
 * Converts local or E.164 Vietnam numbers to the 0xxxxxxxxx form eSMS expects.
 */
export function toEsmsPhone(phone: string): string {
  const clean = phone.trim().replace(/[\s().-]/g, "");
  if (clean.startsWith("+84")) {
    return `0${clean.slice(3)}`;
  }
  if (clean.startsWith("84") && clean.length >= 11) {
    return `0${clean.slice(2)}`;
  }
  return clean;
}

/**
 * Sends one SMS through eSMS.
 * Sandbox=1 validates the request and does not deliver to the handset.
 * CodeResult 100 is the provider success code.
 */
export async function sendEsms(to: string, body: string): Promise<TwilioSendResult> {
  const phone = toEsmsPhone(to);
  if (!/^0\d{9}$/.test(phone)) {
    return { success: false, error: "Số điện thoại eSMS không hợp lệ" };
  }
  const payload: Record<string, string> = {
    ApiKey: config.esmsApiKey,
    SecretKey: config.esmsSecretKey,
    Phone: phone,
    Content: body,
    SmsType: config.esmsSmsType,
    IsUnicode: "0",
    Sandbox: config.esmsSandbox ? "1" : "0"
  };
  if (config.esmsBrandname) {
    payload.Brandname = config.esmsBrandname;
  }

  try {
    const response = await fetch(ESMS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = (await response.json()) as { CodeResult?: string; ErrorMessage?: string; SMSID?: string };
    const code = String(data.CodeResult ?? "");
    if (code === "100") {
      console.log(`[ESMS] accepted phone=${phone} sandbox=${config.esmsSandbox} id=${data.SMSID ?? ""}`);
      return {
        success: true,
        sid: data.SMSID,
        status: config.esmsSandbox ? "sandbox" : "sent",
        simulated: config.esmsSandbox
      };
    }
    const error = data.ErrorMessage || `eSMS CodeResult ${code || response.status}`;
    console.error(`[ESMS] failed phone=${phone} ${error}`);
    return { success: false, code: Number(code) || response.status, error };
  } catch (err: unknown) {
    const error = errorMessage(err);
    console.error(`[ESMS] exception phone=${phone} ${error}`);
    return { success: false, error };
  }
}
