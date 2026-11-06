import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError, readJson, sendJson, sendNoContent } from "../http.js";
import { callRpc, selectOne, updateRows } from "../supabase.js";
import { asJsonObject, asString, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";

/** Hosted payment providers whose signed callbacks share the existing order ledger. */
export type LocalGateway = "VNPAY" | "MOMO";
/** Môi trường tiền của một phiên: sandbox không được chạm đơn của production và ngược lại. */
export type GatewayEnvironment = "sandbox" | "production";
/** A resumable hosted attempt belongs to one immutable order, not a new cart checkout. */
export interface HostedPayment {
  provider: LocalGateway;
  url: string;
  payment_id: string;
  expires_at: string;
  environment: GatewayEnvironment;
  /** QR content for the checkout panel: scan with the bank/MoMo app instead of moving the desktop. */
  qr_url: string;
}

const SANDBOX_HOSTS = ["sandbox.vnpayment.vn", "test-payment.momo.vn"];

function secureHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

/**
 * Môi trường của một nhà mạng: khai báo tường minh thắng, nếu không thì suy ra từ host thật
 * (sandbox.vnpayment.vn / test-payment.momo.vn là sandbox; payment.momo.vn và vnpay.vn là production).
 */
export function gatewayEnvironment(provider: LocalGateway): GatewayEnvironment {
  const declared = config.paymentGatewayEnvironment;
  if (declared === "sandbox" || declared === "production") return declared;
  const origin = provider === "VNPAY" ? config.vnpayPaymentUrl : config.momoApiOrigin;
  try {
    return SANDBOX_HOSTS.includes(new URL(origin).hostname.toLowerCase()) ? "sandbox" : "production";
  } catch {
    return "production";
  }
}

/** Định danh + khoá HMAC của nhà mạng, hoặc của bộ giả lập khi đang chạy simulator. */
export interface GatewayCredentials {
  merchantId: string;
  accessKey: string;
  secret: string;
  simulator: boolean;
}

/** Merchant ID demo của bộ giả lập: tên sân chơi, không phải credential, nên không phải bí mật. */
const SIMULATOR_MERCHANT_ID = "VELURASB";

/**
 * Khoá ký của simulator, theo thứ tự ưu tiên:
 *  1. `PAYMENT_SIMULATOR_SECRET` nếu người vận hành đặt;
 *  2. dẫn xuất có ngữ cảnh từ khoá ký đã có của cluster (JWT_SIGNING_SECRET / service role key);
 *  3. khoá sinh ngẫu nhiên lúc process bật, chỉ cho môi trường không có secret nào (test/local).
 *
 * Vì sao khoá không cần là bí mật vận hành: an toàn của sandbox KHÔNG nằm ở việc giấu khoá demo — nó
 * nằm ở migration 112, nơi mỗi phiên lưu `gateway_environment` của mình và
 * `velura_reconcile_gateway_attempt` trả `07` trước khi đụng bất kỳ hàng nào. Một chữ ký sandbox do
 * đó không capture nổi phiên production, kể cả khi khoá demo là số công khai.
 *
 * Vì sao khoá phải ỔN ĐỊNH (đo thật khi verify trên cluster, không phải suy đoán): nếu mỗi process
 * một khoá, link QR mà pod A ký sẽ bị pod B — hoặc chính pod sau restart — từ chối checksum. Dẫn xuất
 * có ngữ cảnh giữ liên kết sống sót qua deploy và nhân bản, mà vẫn không lấy khoá JWT dùng trực tiếp.
 */
const SIMULATOR_KEY_CONTEXT = "velura:gateway-simulator:v1";
const BOOT_SIMULATOR_SECRET = randomBytes(32).toString("hex");

function simulatorSigningKey(): string {
  if (config.paymentSimulatorSecret) return config.paymentSimulatorSecret;
  const material = process.env.JWT_SIGNING_SECRET || config.supabaseServiceRoleKey;
  return material ? createHmac("sha256", material).update(SIMULATOR_KEY_CONTEXT).digest("hex") : BOOT_SIMULATOR_SECRET;
}

function realGatewayCredentials(provider: LocalGateway): GatewayCredentials {
  return provider === "VNPAY"
    ? { merchantId: config.vnpayTmnCode, accessKey: "", secret: config.vnpayHashSecret, simulator: false }
    : { merchantId: config.momoPartnerCode, accessKey: config.momoAccessKey, secret: config.momoSecretKey, simulator: false };
}

function realGatewayConfigured(provider: LocalGateway): boolean {
  const credentials = realGatewayCredentials(provider);
  return Boolean(credentials.merchantId && credentials.secret && (provider === "VNPAY" || credentials.accessKey));
}

/**
 * Bộ giả lập chỉ thế chỗ khi nhà mạng chưa có credential THẬT và môi trường là sandbox.
 * Có credential thật thì luôn dùng thật, kể cả khi simulator đang bật.
 */
export function localGatewaySimulated(provider: LocalGateway): boolean {
  return !realGatewayConfigured(provider) && config.paymentGatewaySimulator && gatewayEnvironment(provider) === "sandbox";
}

export function gatewayCredentials(provider: LocalGateway): GatewayCredentials {
  if (realGatewayConfigured(provider)) return realGatewayCredentials(provider);
  return localGatewaySimulated(provider)
    ? { merchantId: SIMULATOR_MERCHANT_ID, accessKey: SIMULATOR_MERCHANT_ID, secret: simulatorSigningKey(), simulator: true }
    : realGatewayCredentials(provider);
}

/** Trang thanh toán + nơi gọi API server-to-server (QueryDR/refund của VNPay, query/refund của MoMo). */
export interface GatewayEndpoints {
  pay: string;
  api: string;
}

/**
 * Simulator phục vụ bằng chính API origin của Velura, nên đường đi của một request — ký, verify,
 * reconcile, refund — chạy đúng một lần code như khi gặp nhà mạng thật.
 */
export function gatewayEndpoints(provider: LocalGateway): GatewayEndpoints {
  const root = `${config.apiPublicOrigin}/api/user/payments/simulator/${provider.toLowerCase()}`;
  if (localGatewaySimulated(provider)) {
    // VNPay: `pay` là trang hosted, API server-to-server đi qua một URL. MoMo: mọi lệnh đi qua
    // cùng một API base (`/create`, `/query`, `/refund`) giống hệt bố cục của nhà mạng thật.
    return provider === "VNPAY" ? { pay: `${root}/checkout`, api: `${root}/api` } : { pay: `${root}/api`, api: `${root}/api` };
  }
  if (provider === "VNPAY") {
    if (config.vnpayApiUrl) return { pay: config.vnpayPaymentUrl, api: config.vnpayApiUrl };
    // VNPay không công bố production URL cho QueryDR/Refund — họ cấp riêng theo hợp đồng (VNPAY_API_URL).
    // Chưa khai báo thì suy ra từ host payment để sandbox chạy được.
    try {
      return { pay: config.vnpayPaymentUrl, api: `${new URL(config.vnpayPaymentUrl).origin}/merchant_webapi/api/transaction` };
    } catch {
      return { pay: config.vnpayPaymentUrl, api: "" };
    }
  }
  return { pay: `${config.momoApiOrigin}/v2/gateway/api`, api: `${config.momoApiOrigin}/v2/gateway/api` };
}

/**
 * Missing merchant credentials disable the provider before an order is persisted.
 *
 * Sandbox được phép chạy ở production, nhưng chỉ khi người vận hành khai báo tường minh
 * `PAYMENT_GATEWAY_ENVIRONMENT=sandbox`: mỗi phiên lưu môi trường của nó (migration 112) và callback
 * sai môi trường bị từ chối trước khi động tới tiền, nên "demo thật" không còn phải đánh đổi an toàn.
 */
export function localGatewayConfigured(provider: LocalGateway): boolean {
  if (!secureHttps(config.apiPublicOrigin)) return false;
  const environment = gatewayEnvironment(provider);
  if (config.nodeEnv === "production" && environment === "sandbox" && config.paymentGatewayEnvironment !== "sandbox") return false;
  return realGatewayConfigured(provider) || localGatewaySimulated(provider);
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

export { sameSignature, vnpayDate };

/**
 * VNPay 2.1.0 ký QueryDR/Refund bằng chuỗi GIÁ TRỊ nối với '|', HMAC-SHA512 — khác hoàn toàn bảng
 * mã đã URL-encode mà `pay` và IPN dùng. Trường tuỳ chọn vắng mặt vẫn giữ vị trí, rỗng.
 */
export function vnpayPipeHash(values: readonly string[], secret: string): string {
  return createHmac("sha512", secret).update(values.join("|")).digest("hex");
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
const MOMO_CREATE_RESPONSE_KEYS_WITH_MESSAGE = ["accessKey", "amount", "message", "orderId", "partnerCode", "payUrl", "requestId", "responseTime", "resultCode"] as const;

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
  const environment = gatewayEnvironment(provider);
  const credentials = gatewayCredentials(provider);
  const endpoints = gatewayEndpoints(provider);
  const attempt = asJsonObject(await callRpc("velura_begin_gateway_attempt", {
    p_order_id: orderId, p_provider: provider.toLowerCase(), p_environment: environment
  }));
  const paymentId = asString(attempt.payment_id);
  const reference = asString(attempt.gateway_session_id);
  const expiresAt = asString(attempt.gateway_expires_at);
  if (attempt.gateway_checkout_url && !credentials.simulator) {
    return {
      provider, payment_id: paymentId, expires_at: expiresAt, environment,
      url: asString(attempt.gateway_checkout_url), qr_url: asString(attempt.gateway_qr_url) || asString(attempt.gateway_checkout_url)
    };
  }
  const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,order_code,is_guest" });
  if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
  // A browser return resumes the saved snapshot; it never updates payment status.
  const returnUrl = new URL(order.is_guest ? "/checkout/guest" : `/account/orders/${orderId}`, config.storefrontOrigin);
  returnUrl.searchParams.set("order", asString(order.order_code));
  returnUrl.searchParams.set("payment_return", provider.toLowerCase());
  let url: string;
  let qrUrl = "";
  if (provider === "VNPAY") {
    const params: Record<string, string> = {
      vnp_Version: "2.1.0", vnp_Command: "pay", vnp_TmnCode: credentials.merchantId,
      vnp_Amount: String(Number(attempt.amount) * 100), vnp_CurrCode: "VND", vnp_TxnRef: reference,
      vnp_OrderInfo: `Thanh toan don hang ${asString(order.order_code)}`, vnp_OrderType: "other",
      vnp_Locale: "vn", vnp_ReturnUrl: returnUrl.toString(), vnp_IpAddr: clientIp || "127.0.0.1",
      vnp_CreateDate: vnpayDate(new Date(asString(attempt.created_at))), vnp_ExpireDate: vnpayDate(new Date(expiresAt))
    };
    const signingData = vnpaySigningData(params);
    url = `${endpoints.pay}?${signingData}&vnp_SecureHash=${createHmac("sha512", credentials.secret).update(signingData).digest("hex")}`;
    // VNPay không phát hành payload QR riêng cho hosted pay: khách quét chính đường dẫn đã ký này
    // bằng camera điện thoại, và nó mở đúng trang thanh toán của đơn hàng đó.
    qrUrl = url;
  } else {
    if (Number(attempt.amount) < 1000 || Number(attempt.amount) > 50000000) throw new HttpError(422, "MOMO_AMOUNT_INVALID", "MoMo hỗ trợ thanh toán từ 1.000 đến 50.000.000 đồng.");
    const request: JsonObject = {
      partnerCode: credentials.merchantId, accessKey: credentials.accessKey, requestId: reference, orderId: reference,
      amount: Number(attempt.amount), orderInfo: `Thanh toan don hang ${asString(order.order_code)}`,
      redirectUrl: returnUrl.toString(), ipnUrl: `${config.apiPublicOrigin}/api/user/payments/momo/ipn`,
      extraData: "", requestType: "captureWallet", autoCapture: true, lang: "vi"
    };
    request.signature = momoSignature(request, MOMO_CREATE_KEYS, credentials.secret);
    const response = await fetch(`${endpoints.pay}/create`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(35000)
    });
    const result = asJsonObject(await response.json());
    if (!response.ok || Number(result.resultCode) !== 0) throw new HttpError(502, "MOMO_CHECKOUT_FAILED", "Chưa mở được phiên MoMo. Vui lòng thử lại trên đơn hàng hiện tại.");
    if (result.partnerCode !== credentials.merchantId || result.orderId !== reference || result.requestId !== reference || Number(result.amount) !== Number(attempt.amount)
      || !momoCreateResponseSigned(result, credentials)) {
      throw new HttpError(502, "MOMO_RESPONSE_INVALID", "Phản hồi thanh toán không hợp lệ.");
    }
    url = asString(result.payUrl);
    if (!secureHttps(url) || !isProviderPayHost(url, provider, credentials)) throw new HttpError(502, "MOMO_RESPONSE_INVALID", "Địa chỉ thanh toán không hợp lệ.");
    //qrCodeUrl là DỮ LIỆU để vẽ QR (chuẩn EMVCo/NAPAS), không phải ảnh: MoMo yêu cầu merchant tự render.
    //Vì thế khách quét được bằng app MoMo lẫn app ngân hàng, và đường dẫn payUrl vẫn còn cho desktop.
    qrUrl = asString(result.qrCodeUrl) || url;
  }
  await updateRows("payment", { payment_id: `eq.${paymentId}`, payment_status: `eq.pending` }, { gateway_checkout_url: url, gateway_qr_url: qrUrl });
  return { provider, url, payment_id: paymentId, expires_at: expiresAt, environment, qr_url: qrUrl };
}

/**
 * Tài liệu MoMo hiển thị chuỗi ký của phản hồi `/create` không nhất quán (có chỗ có `message`,
 * có chỗ không), và SDK chính thức của MoMo không kiểm phản hồi này. Thử cả hai bảng mã thay vì
 * từ chối một thanh toán hợp lệ chỉ vì suy đoán ordering.
 */
function momoCreateResponseSigned(result: JsonObject, credentials: GatewayCredentials): boolean {
  const expected = momoSignature({ ...result, accessKey: credentials.accessKey }, MOMO_CREATE_RESPONSE_KEYS, credentials.secret);
  if (sameSignature(asString(result.signature), expected)) return true;
  return sameSignature(asString(result.signature), momoSignature({ ...result, accessKey: credentials.accessKey }, MOMO_CREATE_RESPONSE_KEYS_WITH_MESSAGE, credentials.secret));
}

/** Trang thanh toán chỉ được trỏ về host của chính nhà mạng (hoặc simulator ở sandbox). */
function isProviderPayHost(value: string, provider: LocalGateway, credentials: GatewayCredentials): boolean {
  if (credentials.simulator) {
    try { return new URL(value).host === new URL(config.apiPublicOrigin).host; } catch { return false; }
  }
  try {
    const host = new URL(value).hostname.toLowerCase();
    return provider === "VNPAY"
      ? host === "sandbox.vnpayment.vn" || host.endsWith(".vnpay.vn") || host === "pay.vnpay.vn"
      : host === "payment.momo.vn" || host === "test-payment.momo.vn";
  } catch {
    return false;
  }
}

/** Signed IPNs reconcile the immutable attempt amount with the existing stock/order transaction. */
export async function handleLocalGatewayIpn(req: HttpRequest, res: HttpResponse, url: URL, provider: LocalGateway, headers: HeaderMap): Promise<void> {
  assertLocalGatewayReady(provider);
  const credentials = gatewayCredentials(provider);
  if (provider === "VNPAY") {
    if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET required");
    if (!verifyVnpayNotification(url.searchParams, credentials.secret) || url.searchParams.get("vnp_TmnCode") !== credentials.merchantId) {
      return sendJson(res, 200, { RspCode: "97", Message: "Invalid signature" }, headers);
    }
    const rawAmount = url.searchParams.get("vnp_Amount") || "";
    if (!/^\d+$/.test(rawAmount) || Number(rawAmount) % 100 !== 0) return sendJson(res, 200, { RspCode: "04", Message: "Invalid amount" }, headers);
    const result = asJsonObject(await callRpc("velura_reconcile_gateway_attempt", {
      p_provider: "vnpay", p_reference: url.searchParams.get("vnp_TxnRef"), p_amount: Number(rawAmount) / 100,
      p_transaction: url.searchParams.get("vnp_TransactionNo"), p_success: url.searchParams.get("vnp_ResponseCode") === "00" && url.searchParams.get("vnp_TransactionStatus") === "00",
      p_response_code: url.searchParams.get("vnp_ResponseCode") || "unknown", p_environment: gatewayEnvironment("VNPAY")
    }));
    return sendJson(res, 200, { RspCode: result.code || "99", Message: result.message || "Unknown error" }, headers);
  }
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
  const body = await readJson(req);
  if (!verifyMomoNotification(body, credentials.accessKey, credentials.secret) || body.partnerCode !== credentials.merchantId || body.requestId !== body.orderId) {
    throw new HttpError(400, "PAYMENT_SIGNATURE_INVALID", "Chữ ký thanh toán không hợp lệ.");
  }
  if (!Number.isSafeInteger(Number(body.amount)) || Number(body.amount) <= 0 || !Number.isInteger(Number(body.resultCode))) throw new HttpError(422, "PAYMENT_NOTIFICATION_INVALID", "Kết quả thanh toán không hợp lệ.");
  if (Number(body.resultCode) === 9000) return sendNoContent(res, headers); // Authorization is not a capture.
  const result = asJsonObject(await callRpc("velura_reconcile_gateway_attempt", {
    p_provider: "momo", p_reference: body.orderId, p_amount: Number(body.amount), p_transaction: String(body.transId ?? ""),
    p_success: Number(body.resultCode) === 0, p_response_code: String(body.resultCode), p_environment: gatewayEnvironment("MOMO")
  }));
  if (!["00", "02"].includes(asString(result.code))) throw new HttpError(422, "PAYMENT_NOTIFICATION_MISMATCH", "Thông tin giao dịch không khớp đơn hàng.");
  return sendNoContent(res, headers);
}
