import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { HttpError, readJson, sendJson } from "../http.js";
import { callRpc, selectOne, selectRows } from "../supabase.js";
import { asJsonObject, asString, type AuthContext, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";
import { requireCustomerOrderAccess } from "../user/order-access.js";
import {
  gatewayCredentials,
  gatewayEndpoints,
  gatewayEnvironment,
  localGatewayConfigured,
  momoSignature,
  sameSignature,
  vnpayDate,
  vnpayPipeHash,
  type GatewayCredentials,
  type LocalGateway
} from "./local-gateways.js";

/**
 * Kết quả một lần hỏi nhà mạng. `not_found` tách khỏi `failed` có chủ ý: giao dịch chưa từng
 * tồn tại chỉ đủ điều kiện đóng phiên khi cửa sổ thanh toán đã hết, còn `failed` thì đóng ngay.
 */
export interface GatewayTransactionQuery {
  outcome: "paid" | "pending" | "failed" | "not_found";
  reference: string;
  transaction: string;
  amount: number;
  response_code: string;
  message: string;
}

/** Một phiên hosted cần được hỏi lại: reference của merchant, số tiền và thời điểm tạo. */
export interface GatewayAttempt {
  provider: LocalGateway;
  payment_id: string;
  reference: string;
  amount: number;
  created_at: string;
  expires_at: string;
  environment: string;
  transaction_ref: string;
  payment_status: string;
}

/** VNPay nối tối đa 15 trường phản hồi QueryDR; MoMo không ký phản hồi query. */
const VNPAY_QUERY_REQUEST = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef", "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"] as const;
const VNPAY_QUERY_RESPONSE = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"] as const;
const MOMO_QUERY_KEYS = ["accessKey", "orderId", "partnerCode", "requestId"] as const;

/** MoMo: các mã chưa phải kết quả cuối, vẫn phải chờ (1000 chờ khách xác nhận, 9000 ủy quyền, 7000/7002 đang xử lý). */
const MOMO_PENDING_CODES = [1000, 7000, 7002, 9000, 10, 11, 12, 13, 20, 21, 22, 40, 43, 45, 47];
/** VNPay: 01 chưa hoàn tất, 05/06 đang hoàn trả — chỉ 00 là tiền đã vào. */
const VNPAY_PENDING_STATUS = ["01", "05", "06"];

function jsonRequest(url: string, body: JsonObject): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
}

/**
 * VNPay QueryDR. Chữ ký là chuỗi giá trị nối bằng '|', khác bảng mã của `pay`; phản hồi lỗi
 * (99/Parameter required) KHÔNG có chữ ký, nên chỉ verify khi `vnp_SecureHash` hiện diện.
 */
async function queryVnpay(attempt: GatewayAttempt, credentials: GatewayCredentials, clientIp: string): Promise<GatewayTransactionQuery> {
  const { api } = gatewayEndpoints("VNPAY");
  if (!api) throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "VNPay chưa cấu hình URL QueryDR. Khai báo VNPAY_API_URL theo hợp đồng.");
  const request: JsonObject = {
    vnp_RequestId: randomUUID().replace(/-/g, ""), vnp_Version: "2.1.0", vnp_Command: "querydr",
    vnp_TmnCode: credentials.merchantId, vnp_TxnRef: attempt.reference,
    vnp_TransactionDate: vnpayDate(new Date(attempt.created_at)), vnp_CreateDate: vnpayDate(new Date()),
    vnp_IpAddr: clientIp || "127.0.0.1", vnp_OrderInfo: `Velura query ${attempt.reference}`
  };
  request.vnp_SecureHash = vnpayPipeHash(VNPAY_QUERY_REQUEST.map(key => asString(request[key])), credentials.secret);
  const response = await jsonRequest(api, request);
  const result = asJsonObject(await response.json());
  const code = asString(result.vnp_ResponseCode) || asString(result.vnpCode) || "99";
  const message = asString(result.vnp_Message) || "Truy vấn VNPay không thành công";
  if (!response.ok) throw new HttpError(502, "VNPAY_QUERY_FAILED", `VNPay từ chối truy vấn (${code}).`);
  if (result.vnp_SecureHash) {
    const expected = vnpayPipeHash(VNPAY_QUERY_RESPONSE.map(key => asString(result[key])), credentials.secret);
    if (!sameSignature(asString(result.vnp_SecureHash), expected)) throw new HttpError(502, "VNPAY_QUERY_INVALID", "Chữ ký phản hồi VNPay không hợp lệ.");
  } else if (code === "00") {
    throw new HttpError(502, "VNPAY_QUERY_INVALID", "Phản hồi thành công của VNPay thiếu chữ ký.");
  }
  // 91 = không thấy giao dịch phía VNPay; những mã khác là lỗi truy vấn, không phải kết quả thanh toán.
  if (code !== "00") return { outcome: code === "91" ? "not_found" : "pending", reference: attempt.reference, transaction: "", amount: attempt.amount, response_code: code, message };
  if (asString(result.vnp_TmnCode) !== credentials.merchantId || asString(result.vnp_TxnRef) !== attempt.reference) {
    throw new HttpError(502, "VNPAY_QUERY_MISMATCH", "Phản hồi VNPay không thuộc phiên truy vấn.");
  }
  const amount = Number(result.vnp_Amount) / 100;
  if (!Number.isFinite(amount) || amount !== attempt.amount) {
    throw new HttpError(502, "VNPAY_QUERY_MISMATCH", "Số tiền VNPay báo cáo khác với phiên đã lưu.");
  }
  const status = asString(result.vnp_TransactionStatus);
  return {
    outcome: status === "00" ? "paid" : VNPAY_PENDING_STATUS.includes(status) ? "pending" : "failed",
    reference: attempt.reference, transaction: asString(result.vnp_TransactionNo), amount,
    response_code: status || code, message
  };
}

/** MoMo ký yêu cầu query bằng accessKey+orderId+partnerCode+requestId, dù accessKey không nằm trong body. */
async function queryMomo(attempt: GatewayAttempt, credentials: GatewayCredentials): Promise<GatewayTransactionQuery> {
  const { api } = gatewayEndpoints("MOMO");
  const fields = { accessKey: credentials.accessKey, orderId: attempt.reference, partnerCode: credentials.merchantId, requestId: attempt.reference };
  const request: JsonObject = {
    partnerCode: credentials.merchantId, requestId: attempt.reference, orderId: attempt.reference, lang: "vi",
    signature: momoSignature(fields, MOMO_QUERY_KEYS, credentials.secret)
  };
  const response = await jsonRequest(`${api}/query`, request);
  const result = asJsonObject(await response.json());
  if (!response.ok) throw new HttpError(502, "MOMO_QUERY_FAILED", `MoMo từ chối truy vấn (${asString(result.resultCode) || response.status}).`);
  if (asString(result.orderId) !== attempt.reference || asString(result.partnerCode) !== credentials.merchantId) {
    throw new HttpError(502, "MOMO_QUERY_MISMATCH", "Phản hồi MoMo không thuộc phiên truy vấn.");
  }
  const code = Number(result.resultCode);
  const amount = Number(result.amount);
  if (code === 0 && Number.isFinite(amount) && amount !== attempt.amount) {
    throw new HttpError(502, "MOMO_QUERY_MISMATCH", "Số tiền MoMo báo cáo khác với phiên đã lưu.");
  }
  return {
    outcome: code === 0 ? "paid" : code === 42 ? "not_found" : MOMO_PENDING_CODES.includes(code) ? "pending" : "failed",
    reference: attempt.reference, transaction: String(result.transId ?? ""), amount: Number.isFinite(amount) ? amount : attempt.amount,
    response_code: String(code), message: asString(result.message) || "Truy vấn MoMo không thành công"
  };
}

/** Hỏi nhà mạng về đúng một phiên đã lưu. Không tự suy ra tiền: chỉ nhà mạng trả lời. */
export async function queryGatewayTransaction(attempt: GatewayAttempt, clientIp = ""): Promise<GatewayTransactionQuery> {
  const credentials = gatewayCredentials(attempt.provider);
  if (!credentials.secret) throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Cổng thanh toán chưa được cấu hình.");
  return attempt.provider === "VNPAY" ? queryVnpay(attempt, credentials, clientIp) : queryMomo(attempt, credentials);
}

export interface LocalGatewayVerifyResult {
  success: boolean;
  paid: boolean;
  status: string;
  order_id: string;
  order_code: string;
  provider: string;
  message: string;
}

function latestAttempt(rows: JsonObject[], provider: LocalGateway): GatewayAttempt | null {
  const captured = rows.find(row => ["paid", "refund_pending", "refunded"].includes(asString(row.payment_status)) && asString(row.payment_provider) === provider.toLowerCase());
  const row = captured || rows.find(row => asString(row.payment_provider) === provider.toLowerCase() && asString(row.payment_status) === "pending" && asString(row.gateway_session_id));
  if (!row) return null;
  return {
    provider, payment_id: asString(row.payment_id), reference: asString(row.gateway_session_id),
    amount: Number(row.amount), created_at: asString(row.created_at), expires_at: asString(row.gateway_expires_at),
    environment: asString(row.gateway_environment) || "production", transaction_ref: asString(row.gateway_transaction_ref),
    payment_status: asString(row.payment_status)
  };
}

/**
 * Đối soát chủ động một đơn VNPay/MoMo — bản sao của `verifyStripeOrder` cho hai nhà mạng này.
 *
 * Vì sao cần: VNPay chỉ gửi IPN nếu họ đã đăng ký URL của mình (nhà phát triển sandbox thường
 * không có), MoMo thì IPN không có lịch retry được công bố. Khách thoát khỏi trang thanh toán
 * rồi quay lại vì thế phải hỏi lại nhà mạng, và trạng thái chỉ đổi khi RPC có chữ ký khớp.
 */
export async function verifyLocalGatewayOrder(
  params: { orderId?: string; orderCode?: string; provider: LocalGateway; clientIp?: string },
  assertAccess?: (order: JsonObject) => void
): Promise<LocalGatewayVerifyResult> {
  const identity = asString(params.orderId || params.orderCode).trim();
  if (!identity) throw new HttpError(422, "VALIDATION_ERROR", "order_id hoặc order_code là bắt buộc.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity);
  const order = await selectOne("orders", uuid ? { order_id: `eq.${identity}` } : { order_code: `eq.${identity.toUpperCase()}` });
  if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng cần xác thực thanh toán.");
  assertAccess?.(order);
  const orderId = asString(order.order_id);

  const { rows } = await selectRows("payment", { order_id: `eq.${orderId}`, payment_provider: `eq.${params.provider.toLowerCase()}`, order: "created_at.desc", limit: "5", select: "payment_id,gateway_session_id,gateway_transaction_ref,gateway_expires_at,gateway_environment,payment_provider,payment_status,amount,created_at" }, { count: "none" });
  const attempt = latestAttempt(rows, params.provider);
  if (!attempt) throw new HttpError(422, "PAYMENT_SESSION_REQUIRED", "Đơn hàng này không có phiên thanh toán qua cổng này.");
  if (["paid", "refund_pending", "refunded"].includes(attempt.payment_status)) {
    return { success: true, paid: true, status: attempt.payment_status, order_id: orderId, order_code: asString(order.order_code), provider: params.provider, message: "Thanh toán đã được cổng xác nhận." };
  }

  let query: GatewayTransactionQuery;
  try {
    query = await queryGatewayTransaction(attempt, params.clientIp || "");
  } catch (error) {
    // Nhà mạng không trả lời không có nghĩa là khách chưa trả tiền — giữ nguyên phiên pending.
    if (error instanceof HttpError && error.status === 503) throw error;
    return { success: true, paid: false, status: "pending", order_id: orderId, order_code: asString(order.order_code), provider: params.provider, message: "Chưa kiểm được kết quả từ cổng thanh toán. Vui lòng thử lại." };
  }

  const windowOpen = Date.parse(attempt.expires_at) > Date.now();
  if (query.outcome === "pending" || (query.outcome === "not_found" && windowOpen)) {
    return { success: true, paid: false, status: "pending", order_id: orderId, order_code: asString(order.order_code), provider: params.provider, message: "Giao dịch chưa hoàn tất trên cổng thanh toán." };
  }

  // Sai môi trường ở đây là từ chối tiền, không phải lỗi hiển thị: phiên sandbox không được
  // capture đơn production và ngược lại (migration 112 giữ bất biến đó trong DB).
  const reconcile = asJsonObject(await callRpc("velura_reconcile_gateway_attempt", {
    p_provider: params.provider.toLowerCase(), p_reference: attempt.reference,
    p_amount: query.outcome === "paid" ? query.amount : attempt.amount,
    p_transaction: query.transaction, p_success: query.outcome === "paid",
    p_response_code: query.outcome === "not_found" ? "not_found" : query.response_code,
    p_environment: gatewayEnvironment(params.provider)
  }));
  const code = asString(reconcile.code) || "99";
  if (code === "07") throw new HttpError(422, "PAYMENT_SESSION_ENVIRONMENT_MISMATCH", "Phiên thanh toán thuộc môi trường khác nên không được chấp nhận.");
  if (query.outcome === "paid" && code !== "00") {
    return { success: true, paid: false, status: "pending", order_id: orderId, order_code: asString(order.order_code), provider: params.provider, message: asString(reconcile.message) || "Cổng báo đã thanh toán nhưng giao dịch chưa khớp đơn." };
  }
  const paid = query.outcome === "paid";
  return {
    success: true, paid, status: paid ? asString(reconcile.payment_status) || "paid" : "expired",
    order_id: orderId, order_code: asString(order.order_code), provider: params.provider,
    message: paid ? "Xác thực thành công: cổng thanh toán đã ghi nhận giao dịch." : "Phiên thanh toán đã hết hạn. Bạn có thể mở lại phiên mới trên cùng đơn hàng."
  };
}

/**
 * `POST /api/user/payments/{vnpay|momo}/verify` — khách (hoặc khách vãng lai có token) tự
 * kiểm tra đơn của mình sau khi thoát ra khỏi trang thanh toán rồi quay lại.
 */
export async function handleLocalGatewayVerify(
  req: HttpRequest, res: HttpResponse, corsHeaders: HeaderMap, context: AuthContext, provider: LocalGateway
): Promise<void> {
  if (!localGatewayConfigured(provider)) throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Cổng thanh toán này chưa khả dụng.");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const body = req.method === "POST" ? await readJson(req) : {};
  const orderId = asString(body.order_id || body.orderId || url.searchParams.get("order_id"));
  const orderCode = asString(body.order_code || body.code || url.searchParams.get("order_code"));
  const result = await verifyLocalGatewayOrder(
    { orderId, orderCode, provider, clientIp: asString(context.ipAddress) },
    order => requireCustomerOrderAccess(order, context, body)
  );
  return sendJson(res, 200, result, corsHeaders);
}
