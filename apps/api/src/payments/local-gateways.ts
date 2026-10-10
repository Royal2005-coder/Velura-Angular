import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError, readJson, sendJson, sendNoContent } from "../http.js";
import { callRpc, selectOne, updateRows } from "../supabase.js";
import { asJsonObject, asString, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";

/** Hosted payment providers whose signed callbacks share the existing order ledger. */
export type LocalGateway = "VNPAY" | "MOMO";
/** A resumable hosted attempt belongs to one immutable order, not a new cart checkout. */
export interface HostedPayment {
  provider: LocalGateway;
  url: string;
  payment_id: string;
  expires_at: string;
}

function secureHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

/** Missing merchant credentials disable the provider before an order is persisted. */
export function localGatewayConfigured(provider: LocalGateway): boolean {
  if (!secureHttps(config.apiPublicOrigin)) return false;
  return provider === "VNPAY"
    ? Boolean(config.vnpayTmnCode && config.vnpayHashSecret && secureHttps(config.vnpayPaymentUrl))
    : Boolean(config.momoPartnerCode && config.momoAccessKey && config.momoSecretKey && secureHttps(config.momoApiOrigin));
}

/** Fail closed rather than create a simulated QR payment in a production ledger. */
export function assertLocalGatewayReady(provider: LocalGateway): void {
  if (!localGatewayConfigured(provider)) throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Phương thức thanh toán chưa được cấu hình. Vui lòng chọn phương thức khác.");
}

function sameSignature(actual: string, expected: string): boolean {
  if (!/^[a-f\d]+$/i.test(actual)) return false;
  const left = Buffer.from(actual.toLowerCase(), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

/** VNPay 2.1.0 signs sorted URL-encoded fields with HMAC-SHA512. */
export function vnpaySigningData(fields: Record<string, string>): string {
  return Object.keys(fields).filter(key => key.startsWith("vnp_") && !["vnp_SecureHash", "vnp_SecureHashType"].includes(key))
    .sort().map(key => `${formEncode(key)}=${formEncode(fields[key])}`).join("&");
}

/** Reject a modified amount, merchant reference or duplicate query parameter. */
export function verifyVnpayNotification(params: URLSearchParams, secret: string): boolean {
  if (!secret) return false;
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in fields) return false;
    fields[key] = value;
  }
  return sameSignature(fields.vnp_SecureHash || "", createHmac("sha512", secret).update(vnpaySigningData(fields)).digest("hex"));
}

/** MoMo signs specified scalar fields in the provider's documented order. */
export function momoSignature(fields: JsonObject, keys: readonly string[], secret: string): string {
  return createHmac("sha256", secret).update(keys.map(key => `${key}=${fields[key] ?? ""}`).join("&")).digest("hex");
}

const MOMO_CREATE_KEYS = ["accessKey", "amount", "extraData", "ipnUrl", "orderId", "orderInfo", "partnerCode", "redirectUrl", "requestId", "requestType"] as const;
const MOMO_RESULT_KEYS = ["accessKey", "amount", "extraData", "message", "orderId", "orderInfo", "orderType", "partnerCode", "payType", "requestId", "responseTime", "resultCode", "transId"] as const;
const MOMO_CREATE_RESPONSE_KEYS = ["accessKey", "amount", "orderId", "partnerCode", "payUrl", "requestId", "responseTime", "resultCode"] as const;

/** Only an authenticated server notification can authorize a captured MoMo payment. */
export function verifyMomoNotification(body: JsonObject, accessKey: string, secret: string): boolean {
  return Boolean(secret && accessKey) && sameSignature(asString(body.signature), momoSignature({ ...body, accessKey }, MOMO_RESULT_KEYS, secret));
}

function vnpayDate(date: Date): string {
  return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 19).replace(/[-T:]/g, "");
}

/** Reserve one durable attempt under an order lock, then obtain the real provider URL. */
export async function openLocalGateway(orderId: string, provider: LocalGateway, clientIp: string): Promise<HostedPayment> {
  assertLocalGatewayReady(provider);
  const attempt = asJsonObject(await callRpc("velura_begin_gateway_attempt", { p_order_id: orderId, p_provider: provider.toLowerCase() }));
  const paymentId = asString(attempt.payment_id);
  const reference = asString(attempt.gateway_session_id);
  const expiresAt = asString(attempt.gateway_expires_at);
  if (attempt.gateway_checkout_url) return { provider, payment_id: paymentId, expires_at: expiresAt, url: asString(attempt.gateway_checkout_url) };
  const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,order_code,is_guest" });
  if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
  // A browser return resumes the saved snapshot; it never updates payment status.
  const returnUrl = new URL(order.is_guest ? "/checkout/guest" : `/account/orders/${orderId}`, config.storefrontOrigin);
  returnUrl.searchParams.set("order", asString(order.order_code));
  returnUrl.searchParams.set("payment_return", provider.toLowerCase());
  let url: string;
  if (provider === "VNPAY") {
    const params: Record<string, string> = {
      vnp_Version: "2.1.0", vnp_Command: "pay", vnp_TmnCode: config.vnpayTmnCode,
      vnp_Amount: String(Number(attempt.amount) * 100), vnp_CurrCode: "VND", vnp_TxnRef: reference,
      vnp_OrderInfo: `Thanh toan don hang ${asString(order.order_code)}`, vnp_OrderType: "other",
      vnp_Locale: "vn", vnp_ReturnUrl: returnUrl.toString(), vnp_IpAddr: clientIp || "127.0.0.1",
      vnp_CreateDate: vnpayDate(new Date(asString(attempt.created_at))), vnp_ExpireDate: vnpayDate(new Date(expiresAt))
    };
    const signingData = vnpaySigningData(params);
    url = `${config.vnpayPaymentUrl}?${signingData}&vnp_SecureHash=${createHmac("sha512", config.vnpayHashSecret).update(signingData).digest("hex")}`;
  } else {
    if (Number(attempt.amount) < 1000 || Number(attempt.amount) > 50000000) throw new HttpError(422, "MOMO_AMOUNT_INVALID", "MoMo hỗ trợ thanh toán từ 1.000 đến 50.000.000 đồng.");
    const request: JsonObject = {
      partnerCode: config.momoPartnerCode, accessKey: config.momoAccessKey, requestId: reference, orderId: reference,
      amount: Number(attempt.amount), orderInfo: `Thanh toan don hang ${asString(order.order_code)}`,
      redirectUrl: returnUrl.toString(), ipnUrl: `${config.apiPublicOrigin}/api/user/payments/momo/ipn`,
      extraData: "", requestType: "captureWallet", autoCapture: true, lang: "vi"
    };
    request.signature = momoSignature(request, MOMO_CREATE_KEYS, config.momoSecretKey);
    const response = await fetch(`${config.momoApiOrigin}/v2/gateway/api/create`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(35000)
    });
    const result = asJsonObject(await response.json());
    if (!response.ok || Number(result.resultCode) !== 0) throw new HttpError(502, "MOMO_CHECKOUT_FAILED", "Chưa mở được phiên MoMo. Vui lòng thử lại trên đơn hàng hiện tại.");
    if (result.partnerCode !== config.momoPartnerCode || result.orderId !== reference || result.requestId !== reference || Number(result.amount) !== Number(attempt.amount)
      || !sameSignature(asString(result.signature), momoSignature({ ...result, accessKey: config.momoAccessKey }, MOMO_CREATE_RESPONSE_KEYS, config.momoSecretKey))) {
      throw new HttpError(502, "MOMO_RESPONSE_INVALID", "Phản hồi thanh toán không hợp lệ.");
    }
    url = asString(result.payUrl);
    const payHost = new URL(url).hostname;
    if (!secureHttps(url) || !["payment.momo.vn", "test-payment.momo.vn"].includes(payHost)) throw new HttpError(502, "MOMO_RESPONSE_INVALID", "Địa chỉ thanh toán không hợp lệ.");
  }
  await updateRows("payment", { payment_id: `eq.${paymentId}`, payment_status: "eq.pending" }, { gateway_checkout_url: url });
  return { provider, url, payment_id: paymentId, expires_at: expiresAt };
}

/** Signed IPNs reconcile the immutable attempt amount with the existing stock/order transaction. */
export async function handleLocalGatewayIpn(req: HttpRequest, res: HttpResponse, url: URL, provider: LocalGateway, headers: HeaderMap): Promise<void> {
  assertLocalGatewayReady(provider);
  if (provider === "VNPAY") {
    if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET required");
    if (!verifyVnpayNotification(url.searchParams, config.vnpayHashSecret) || url.searchParams.get("vnp_TmnCode") !== config.vnpayTmnCode) {
      return sendJson(res, 200, { RspCode: "97", Message: "Invalid signature" }, headers);
    }
    const rawAmount = url.searchParams.get("vnp_Amount") || "";
    if (!/^\d+$/.test(rawAmount) || Number(rawAmount) % 100 !== 0) return sendJson(res, 200, { RspCode: "04", Message: "Invalid amount" }, headers);
    const result = asJsonObject(await callRpc("velura_reconcile_gateway_attempt", {
      p_provider: "vnpay", p_reference: url.searchParams.get("vnp_TxnRef"), p_amount: Number(rawAmount) / 100,
      p_transaction: url.searchParams.get("vnp_TransactionNo"), p_success: url.searchParams.get("vnp_ResponseCode") === "00" && url.searchParams.get("vnp_TransactionStatus") === "00",
      p_response_code: url.searchParams.get("vnp_ResponseCode") || "unknown"
    }));
    return sendJson(res, 200, { RspCode: result.code || "99", Message: result.message || "Unknown error" }, headers);
  }
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
  const body = await readJson(req);
  if (!verifyMomoNotification(body, config.momoAccessKey, config.momoSecretKey) || body.partnerCode !== config.momoPartnerCode || body.requestId !== body.orderId) {
    throw new HttpError(400, "PAYMENT_SIGNATURE_INVALID", "Chữ ký thanh toán không hợp lệ.");
  }
  if (!Number.isSafeInteger(Number(body.amount)) || Number(body.amount) <= 0 || !Number.isInteger(Number(body.resultCode))) throw new HttpError(422, "PAYMENT_NOTIFICATION_INVALID", "Kết quả thanh toán không hợp lệ.");
  if (Number(body.resultCode) === 9000) return sendNoContent(res, headers); // Authorization is not a capture.
  const result = asJsonObject(await callRpc("velura_reconcile_gateway_attempt", {
    p_provider: "momo", p_reference: body.orderId, p_amount: Number(body.amount), p_transaction: String(body.transId ?? ""),
    p_success: Number(body.resultCode) === 0, p_response_code: String(body.resultCode)
  }));
  if (!["00", "02"].includes(asString(result.code))) throw new HttpError(422, "PAYMENT_NOTIFICATION_MISMATCH", "Thông tin giao dịch không khớp đơn hàng.");
  return sendNoContent(res, headers);
}
