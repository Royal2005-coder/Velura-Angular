import { createHmac } from "node:crypto";
import QRCode from "qrcode";
import { config } from "../config.js";
import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne } from "../supabase.js";
import { asJsonObject, asString, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";
import {
  gatewayCredentials,
  handleLocalGatewayIpn,
  localGatewaySimulated,
  momoSignature,
  sameSignature,
  verifyVnpayNotification,
  vnpayDate,
  vnpayPipeHash,
  vnpaySigningData,
  type GatewayCredentials,
  type LocalGateway
} from "./local-gateways.js";

/**
 * Bộ giả lập VNPay/MoMo cho sandbox.
 *
 * Vì sao phải có: credential merchant thật chỉ được cấp sau hợp đồng, nên MVP không có cách nào
 * demo "quét QR → trả tiền → thoát ra → vào lại → hoàn tiền". Simulator đứng ở ĐÍCH của nhà mạng:
 * cùng hình hài request, cùng định dạng chữ ký, cùng cách trả kết quả. Vì thế verify / IPN /
 * reconcile / refund chạy đúng một lần code như khi gặp cổng thật — đổi simulator sang VNPay/MoMo
 * chỉ là đổi endpoint.
 *
 * Nó không bịa tiền: kết quả query/refund đọc lại từ chính sổ ledger, còn trạng thái thanh toán
 * chỉ đổi qua `velura_reconcile_gateway_attempt` y như một IPN thật.
 */

const SANDBOX_TTL_MS = 15 * 60 * 1000;
/** Cùng danh sách MoMo ký IPN: accessKey được ký nhưng không có trong body. */
const MOMO_IPN_KEYS = ["accessKey", "amount", "extraData", "message", "orderId", "orderInfo", "orderType", "partnerCode", "payType", "requestId", "responseTime", "resultCode", "transId"];
const MOMO_CREATE_KEYS = ["accessKey", "amount", "extraData", "ipnUrl", "orderId", "orderInfo", "partnerCode", "redirectUrl", "requestId", "requestType"];
const MOMO_CREATE_RESPONSE_KEYS = ["accessKey", "amount", "orderId", "partnerCode", "payUrl", "requestId", "responseTime", "resultCode"];
const MOMO_QUERY_KEYS = ["accessKey", "orderId", "partnerCode", "requestId"];
const MOMO_REFUND_KEYS = ["accessKey", "amount", "description", "orderId", "partnerCode", "requestId", "transId"];
const VNPAY_QUERY_SIGNED = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef", "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"];
const VNPAY_REFUND_SIGNED = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TransactionType", "vnp_TxnRef", "vnp_Amount", "vnp_TransactionNo", "vnp_TransactionDate", "vnp_CreateBy", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"];
const VNPAY_QUERY_RESPONSE_SIGNED = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];
const VNPAY_REFUND_RESPONSE_SIGNED = VNPAY_QUERY_RESPONSE_SIGNED.slice(0, 13);

/** Nội dung một phiên hosted, do simulator ký để khách quay lại vẫn đúng phiên đó. */
interface SimulatedSession {
  provider: LocalGateway;
  reference: string;
  amount: number;
  orderInfo: string;
  returnUrl: string;
  expiresAtMs: number;
}

export function simulatorReady(provider: LocalGateway): boolean {
  return localGatewaySimulated(provider);
}

function assertSimulatorReady(provider: LocalGateway): void {
  // 404 chứ không phải 503: khi simulator tắt, route phải trông như không tồn tại.
  if (!simulatorReady(provider)) throw new HttpError(404, "NOT_FOUND", "Route not found");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function money(amount: number): string {
  return Math.round(amount).toLocaleString("vi-VN");
}

/** Số giao dịch tất định theo reference: IPN, query và refund phải nói cùng một số. */
function gatewayTransactionNo(seed: string): string {
  return String(Number(`0x${createHmac("sha256", "txn").update(seed).digest("hex").slice(0, 7)}`) % 900_000_000 + 1_000_000);
}

function signToken(payload: string, credentials: GatewayCredentials): string {
  return createHmac("sha256", credentials.secret).update(payload).digest("hex");
}

function sessionToken(session: SimulatedSession, credentials: GatewayCredentials): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signToken(payload, credentials)}`;
}

function readSessionToken(token: string, provider: LocalGateway, credentials: GatewayCredentials): SimulatedSession | null {
  const [payload, signature = ""] = String(token).split(".");
  if (!payload || !sameSignature(signature, signToken(payload, credentials))) return null;
  let parsed: JsonObject;
  try {
    parsed = asJsonObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  const session: SimulatedSession = {
    provider,
    reference: asString(parsed.reference),
    amount: Number(parsed.amount),
    orderInfo: asString(parsed.orderInfo),
    returnUrl: asString(parsed.returnUrl),
    expiresAtMs: Number(parsed.expiresAtMs)
  };
  if (!session.reference || !Number.isFinite(session.amount) || session.amount <= 0) return null;
  if (!Number.isFinite(session.expiresAtMs) || !session.returnUrl) return null;
  return session;
}

/** VNPay trả bộ `vnp_*` đã ký (sorted urlencoded, HMAC-SHA512) cho cả IPN lẫn ReturnUrl. */
function vnpayResultParams(session: SimulatedSession, credentials: GatewayCredentials, success: boolean): URLSearchParams {
  const fields: Record<string, string> = {
    vnp_TmnCode: credentials.merchantId,
    vnp_Amount: String(Math.round(session.amount * 100)),
    vnp_BankCode: "SIMU",
    vnp_BankTranNo: `SIMU${gatewayTransactionNo(session.reference)}`,
    vnp_CardType: "QRCODE",
    vnp_OrderInfo: session.orderInfo,
    vnp_PayDate: vnpayDate(new Date()),
    vnp_TransactionNo: success ? gatewayTransactionNo(session.reference) : "0",
    vnp_ResponseCode: success ? "00" : "10",
    vnp_TransactionStatus: success ? "00" : "10",
    vnp_TxnRef: session.reference
  };
  const params = new URLSearchParams(fields);
  params.set("vnp_SecureHash", createHmac("sha512", credentials.secret).update(vnpaySigningData(fields)).digest("hex"));
  return params;
}

/** MoMo ký IPN trên danh sách 13 trường; accessKey tham gia chữ ký nhưng không nằm trong body. */
function momoResultBody(session: SimulatedSession, credentials: GatewayCredentials, success: boolean): JsonObject {
  const body: JsonObject = {
    partnerCode: credentials.merchantId,
    orderId: session.reference,
    requestId: session.reference,
    amount: Math.round(session.amount),
    transId: success ? gatewayTransactionNo(session.reference) : "0",
    resultCode: success ? 0 : 1006,
    message: success ? "Giao dịch thành công (sandbox)" : "Khách hủy giao dịch (sandbox)",
    payType: "qrCode",
    orderInfo: session.orderInfo,
    orderType: "other",
    extraData: "",
    responseTime: Date.now(),
    accessKey: credentials.accessKey
  };
  body.signature = momoSignature(body, MOMO_IPN_KEYS, credentials.secret);
  delete body.accessKey;
  return body;
}

/** Kết quả được ký rồi giao cho chính handler IPN của Velura — cùng đường kiểm tra như cổng thật. */
async function deliverNotification(provider: LocalGateway, session: SimulatedSession, credentials: GatewayCredentials, success: boolean): Promise<string> {
  const headers: HeaderMap = { "content-type": "application/json" };
  const res = captureResponse();
  if (provider === "VNPAY") {
    const params = vnpayResultParams(session, credentials, success);
    const url = new URL(`${config.apiPublicOrigin}/api/user/payments/vnpay/ipn?${params.toString()}`);
    await handleLocalGatewayIpn(fakeRequest({ method: "GET" }), res, url, "VNPAY", headers);
    // VNPay quy định merchant trả {"RspCode":"00"} khi đã ghi nhận và "02" khi giao dịch đã xác nhận
    // trước đó; mọi mã khác nghĩa là Velura chưa chấp nhận giao dịch.
    const rspCode = asString(asJsonObject(readBodyJson(res.body)).RspCode);
    return ["00", "02"].includes(rspCode) ? "accepted" : `rejected:RspCode ${rspCode || "?"}`;
  }
  const body = momoResultBody(session, credentials, success);
  await handleLocalGatewayIpn(fakeRequest({ method: "POST", body }), res, new URL(`${config.apiPublicOrigin}/api/user/payments/momo/ipn`), "MOMO", headers);
  return res.statusCode === 204 ? "accepted" : `rejected:HTTP ${res.statusCode}`;
}

function readBodyJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

function fakeRequest(init: { method: string; body?: JsonObject }): HttpRequest {
  return {
    method: init.method,
    url: `${config.apiPublicOrigin}/api/user/payments/simulator`,
    headers: { "content-type": init.body ? "application/json" : "text/html" },
    ...(init.body ? { body: init.body } : {}),
    async *[Symbol.asyncIterator]() { if (init.body) yield JSON.stringify(init.body); }
  } as unknown as HttpRequest;
}

function captureResponse() {
  const sink = { statusCode: 200, body: "" };
  return Object.assign(sink, {
    writeHead(statusCode: number) { sink.statusCode = statusCode; return sink; },
    setHeader() { return sink; },
    end(chunk?: string | Buffer) { sink.body = String(chunk ?? ""); return sink; }
  });
}

type LedgerState = "paid" | "pending" | "failed" | "unknown";

/** Simulator chỉ thuật lại sổ ledger, nên không tồn tại đường nào để nó tự tạo tiền. */
async function ledgerState(reference: string, provider: LocalGateway): Promise<{ state: LedgerState; row: JsonObject | null }> {
  const row = await selectOne("payment", {
    payment_provider: `eq.${provider.toLowerCase()}`,
    gateway_session_id: `eq.${reference}`,
    select: "payment_id,amount,refunded_amount,payment_status,gateway_environment,paid_at,created_at",
    order: "created_at.desc"
  });
  if (!row) return { state: "unknown", row: null };
  const status = asString(row.payment_status);
  if (["paid", "refund_pending", "refunded"].includes(status)) return { state: "paid", row };
  if (status === "pending") return { state: "pending", row };
  return { state: "failed", row };
}

function brands(provider: LocalGateway): { name: string; accent: string; action: string } {
  return provider === "VNPAY"
    ? { name: "VNPay", accent: "#c1272d", action: "#0068bf" }
    : { name: "MoMo", accent: "#a021a2", action: "#a021a2" };
}

function page(provider: LocalGateway, title: string, inner: string): string {
  const brand = brands(provider);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,no follow">
<title>${escapeHtml(title)} — ${brand.name} sandbox</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
.sb{background:#7c2d12;color:#ffedd5;text-align:center;padding:9px 14px;font-size:12px;font-weight:600;letter-spacing:.3px}
.wrap{max-width:520px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.12)}
.head{background:${brand.accent};color:#fff;padding:18px 22px;display:flex;justify-content:space-between;align-items:center}
.head b{font-size:22px;letter-spacing:2px}.head span{font-size:12px;opacity:.92}
.body{padding:22px}.amount{font-size:30px;font-weight:700;text-align:center;margin:4px 0}
.muted{font-size:12px;color:#64748b;text-align:center;margin:0 0 14px}
.qr{display:flex;justify-content:center;margin:6px 0 16px}.qr img{width:220px;height:220px;border:1px solid #e2e8f0;border-radius:10px}
.row{display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-top:1px dashed #e2e8f0}
.actions{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:13px;border-radius:9px;font-size:15px;font-weight:600;border:0;cursor:pointer}
button[disabled]{opacity:.5;cursor:not-allowed}.pay{background:${brand.action};color:#fff}
.cancel{background:#fff;border:1px solid #cbd5e1;color:#334155}
.note{font-size:12px;color:#64748b;margin-top:14px;line-height:1.6}
.done{text-align:center;padding:26px 0}.done p{font-size:15px}
</style></head><body>
<div class="sb">MÔI TRƯỜNG MÔ PHỎNG SANDBOX — ${brand.name} giả lập, không có tiền thật</div>
<div class="wrap"><div class="head"><b>${brand.name}</b><span>${escapeHtml(title)}</span></div>
<div class="body">${inner}</div></div></body></html>`;
}

function sendHtml(res: HttpResponse, status: number, html: string, headers: HeaderMap): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...headers });
  res.end(html);
}

/**
 * `GET /api/user/payments/simulator/:provider/checkout` — trang thanh toán mô phỏng.
 *
 * VNPay: kiểm `vnp_SecureHash` của chính request `pay` (sai chữ ký là từ chối như cổng thật).
 * MoMo: kiểm token do simulator ký ở bước create. Trang hiển thị QR là ĐƯỜNG DẪN phiên, nên quét
 * bằng camera điện thoại mở đúng trang này — mô phỏng đủ trường hợp "thoát ra rồi vào lại".
 */
export async function handleSimulatorCheckout(req: HttpRequest, res: HttpResponse, url: URL, provider: LocalGateway, headers: HeaderMap): Promise<void> {
  assertSimulatorReady(provider);
  const credentials = gatewayCredentials(provider);
  let session: SimulatedSession | null = null;
  if (provider === "VNPAY") {
    if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET required");
    if (!verifyVnpayNotification(url.searchParams, credentials.secret) || url.searchParams.get("vnp_TmnCode") !== credentials.merchantId) {
      sendHtml(res, 400, page(provider, "Chữ ký không hợp lệ", "<p>Yêu cầu thanh toán không mang chữ ký hợp lệ của terminal sandbox.</p>"), headers);
      return;
    }
    const expire = vnpayFromGmt7(url.searchParams.get("vnp_ExpireDate") || "");
    session = {
      provider,
      reference: url.searchParams.get("vnp_TxnRef") || "",
      amount: Number(url.searchParams.get("vnp_Amount") || 0) / 100,
      orderInfo: url.searchParams.get("vnp_OrderInfo") || "",
      returnUrl: url.searchParams.get("vnp_ReturnUrl") || "",
      expiresAtMs: Number.isFinite(expire) ? expire : Date.now() + SANDBOX_TTL_MS
    };
  } else {
    session = readSessionToken(url.searchParams.get("t") || "", provider, credentials);
  }
  if (!session || !session.reference || !session.returnUrl || !Number.isFinite(session.amount)) {
    sendHtml(res, 400, page(provider, "Phiên không hợp lệ", "<p>Phiên sandbox này không hợp lệ hoặc đã quá cũ. Hãy mở lại thanh toán từ đơn hàng.</p>"), headers);
    return;
  }
  const token = sessionToken(session, credentials);
  const { state } = await ledgerState(session.reference, provider);
  if (state === "paid") {
    sendHtml(res, 200, page(provider, "Đã thanh toán", `<div class="done"><p class="amount">${money(session.amount)} đ</p>
<p class="muted">Giao dịch ${escapeHtml(session.reference)} đã được ghi nhận trên cổng sandbox.</p></div>
<form method="get" action="${escapeHtml(session.returnUrl)}"><div class="actions"><button class="pay" type="submit">Quay lại Velura</button></div></form>`), headers);
    return;
  }
  const expired = session.expiresAtMs <= Date.now();
  const action = `${config.apiPublicOrigin}/api/user/payments/simulator/${provider.toLowerCase()}/checkout`;
  const qr = await QRCode.toDataURL(`${config.apiPublicOrigin}/api/user/payments/simulator/${provider.toLowerCase()}/checkout?t=${encodeURIComponent(token)}`, { width: 440, margin: 1, errorCorrectionLevel: "M" }).catch(() => "");
  sendHtml(res, 200, page(provider, expired ? "Hết hạn thanh toán" : "Xác nhận thanh toán", `
<p class="muted">${escapeHtml(session.orderInfo || session.reference)}</p>
<p class="amount">${money(session.amount)} đ</p>
<div class="qr">${qr ? `<img alt="Mã QR thanh toán ${provider} sandbox" src="${qr}">` : "<p>Không tạo được mã QR</p>"}</div>
<div class="row"><span>Trạng thái phiên</span><strong>${expired ? "Hết hạn" : state === "failed" ? "Đã hủy trước đó" : "Đang chờ"}</strong></div>
<div class="row"><span>Số giao dịch sandbox</span><strong>${gatewayTransactionNo(session.reference)}</strong></div>
<p class="note">Quét mã này bằng camera điện thoại để mở đúng phiên trên (mô phỏng khách rời desktop). Hoặc bấm nút dưới đây để cổng trả kết quả về Velura qua IPN đã ký.</p>
<form method="post" action="${action}">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<div class="actions">
<button class="pay" name="result" value="success" type="submit" ${expired ? "disabled" : ""}>Xác nhận đã thanh toán</button>
<button class="cancel" name="result" value="cancel" type="submit" ${expired ? "disabled" : ""}>Hủy giao dịch</button>
</div></form>`), headers);
}

/** `POST .../checkout` — nút bấm của khách: ký kết quả như nhà mạng, giao cho IPN, rồi redirect về Velura. */
export async function handleSimulatorReturn(req: HttpRequest, res: HttpResponse, headers: HeaderMap, provider: LocalGateway): Promise<void> {
  assertSimulatorReady(provider);
  const credentials = gatewayCredentials(provider);
  const fields = await readForm(req);
  const session = readSessionToken(fields.t || "", provider, credentials);
  if (!session) throw new HttpError(400, "PAYMENT_SESSION_INVALID", "Phiên sandbox không hợp lệ.");
  const success = fields.result === "success" && session.expiresAtMs > Date.now();
  const outcome = await deliverNotification(provider, session, credentials, success);
  if (outcome.startsWith("rejected")) {
    // IPN bị chính ledger từ chối nghĩa là giả lập đang lệch với thật: báo thẳng, không im lặng redirect.
    throw new HttpError(502, "PAYMENT_SIMULATOR_REJECTED", `Cổng sandbox từ chối ghi nhận giao dịch: ${outcome.slice(9)}`);
  }
  const target = new URL(session.returnUrl);
  if (provider === "VNPAY") {
    for (const [key, value] of vnpayResultParams(session, credentials, success)) target.searchParams.set(key, value);
  } else {
    for (const [key, value] of Object.entries(momoResultBody(session, credentials, success))) target.searchParams.set(key, String(value));
  }
  target.searchParams.set("sandbox", "1");
  res.writeHead(303, { ...headers, location: target.toString() });
  res.end();
}

async function readForm(req: HttpRequest): Promise<Record<string, string>> {
  const chunks: string[] = [];
  const stream = req as unknown as AsyncIterable<unknown>;
  if (req[Symbol.asyncIterator]) for await (const chunk of stream) chunks.push(String(chunk));
  const parsed = new URLSearchParams(chunks.join(""));
  return Object.fromEntries(parsed.entries());
}

/** `POST .../api` — API server-to-server mô phỏng, phân nhánh theo chính hình hài request của nhà mạng. */
export async function handleSimulatorApi(req: HttpRequest, res: HttpResponse, url: URL, provider: LocalGateway, headers: HeaderMap): Promise<void> {
  assertSimulatorReady(provider);
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
  const credentials = gatewayCredentials(provider);
  const body = asJsonObject(await readJson(req));
  const result = provider === "VNPAY"
    ? await simulatedVnpayApi(body, credentials)
    : await simulatedMomoApi(body, credentials, url.pathname.toLowerCase());
  sendJson(res, 200, result, headers);
}

/** VNPay dùng một URL cho mọi lệnh, phân biệt bằng `vnp_Command`; phản hồi lỗi thì không ký. */
async function simulatedVnpayApi(body: JsonObject, credentials: GatewayCredentials): Promise<JsonObject> {
  const command = asString(body.vnp_Command);
  const signedKeys = command === "querydr" ? VNPAY_QUERY_SIGNED : command === "refund" ? VNPAY_REFUND_SIGNED : null;
  if (!signedKeys) return { vnp_ResponseCode: "99", vnp_Message: "Command not support" };
  const expected = vnpayPipeHash(signedKeys.map(key => scalarOf(body[key])), credentials.secret);
  if (!sameSignature(asString(body.vnp_SecureHash), expected)) return { vnp_ResponseCode: "97", vnp_Message: "Invalid checksum" };
  if (asString(body.vnp_TmnCode) !== credentials.merchantId) return { vnp_ResponseCode: "02", vnp_Message: "Invalid TmnCode" };
  const reference = asString(body.vnp_TxnRef);
  const { state, row } = await ledgerState(reference, "VNPAY");
  const scaled = Number(body.vnp_Amount) || 0;
  if (command === "refund") {
    // Yêu cầu hoàn tiền sandbox chỉ hợp lệ khi giao dịch gốc thực sự đã thu và còn số dư.
    const already = Number(row?.refunded_amount || 0);
    const amount = scaled / 100;
    if (state !== "paid") return { vnp_ResponseCode: "95", vnp_Message: "Giao dịch gốc không thành công nên VNPAY từ chối hoàn tiền", vnp_TxnRef: reference };
    if (already + amount > Number(row?.amount || 0)) return { vnp_ResponseCode: "93", vnp_Message: "Số tiền hoàn vượt quá giá trị giao dịch gốc", vnp_TxnRef: reference };
    return signVnpayResponse({
      vnp_ResponseId: asString(body.vnp_RequestId), vnp_Command: "refund", vnp_ResponseCode: "00",
      vnp_Message: "Yêu cầu hoàn tiền được chấp nhận (sandbox)", vnp_TmnCode: credentials.merchantId, vnp_TxnRef: reference,
      vnp_Amount: String(scaled), vnp_BankCode: "SIMU", vnp_PayDate: vnpayDate(new Date()),
      vnp_TransactionNo: gatewayTransactionNo(`refund:${reference}`),
      vnp_TransactionType: amount < Number(row?.amount || 0) ? "03" : "02",
      vnp_TransactionStatus: "00", vnp_OrderInfo: asString(body.vnp_OrderInfo)
    }, VNPAY_REFUND_RESPONSE_SIGNED, credentials);
  }
  if (state === "unknown") return { vnp_ResponseCode: "91", vnp_Message: "Không tìm thấy giao dịch", vnp_TxnRef: reference };
  const status = state === "paid" ? "00" : state === "pending" ? "01" : "02";
  return signVnpayResponse({
    vnp_ResponseId: asString(body.vnp_RequestId), vnp_Command: "querydr", vnp_ResponseCode: "00",
    vnp_Message: "Truy vấn thành công (sandbox)", vnp_TmnCode: credentials.merchantId, vnp_TxnRef: reference,
    vnp_Amount: String(Math.round(Number(row?.amount || 0) * 100)), vnp_BankCode: "SIMU",
    vnp_PayDate: vnpayDate(new Date(asString(row?.paid_at) || asString(row?.created_at) || Date.now())),
    vnp_TransactionNo: state === "paid" ? gatewayTransactionNo(reference) : "0",
    vnp_TransactionType: "01", vnp_TransactionStatus: status,
    vnp_OrderInfo: asString(body.vnp_OrderInfo), vnp_PromotionCode: "", vnp_PromotionAmount: ""
  }, VNPAY_QUERY_RESPONSE_SIGNED, credentials);
}

/** Trường số trong JSON phải vào chuỗi ký đúng như giá trị thô, không qua asString rỗng. */
function scalarOf(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function signVnpayResponse(fields: JsonObject, keys: readonly string[], credentials: GatewayCredentials): JsonObject {
  const hash = vnpayPipeHash(keys.map(key => scalarOf(fields[key])), credentials.secret);
  return { ...fields, vnp_SecureHash: hash };
}

/** MoMo ký từng lệnh theo đúng bảng mã của tài liệu; accessKey không nằm trong body query/refund. */
async function simulatedMomoApi(body: JsonObject, credentials: GatewayCredentials, path: string): Promise<JsonObject> {
  const reference = asString(body.orderId);
  if (path.endsWith("/create")) {
    const signed = momoSignature({ ...body, accessKey: credentials.accessKey }, MOMO_CREATE_KEYS, credentials.secret);
    if (!sameSignature(asString(body.signature), signed)) {
      return { partnerCode: credentials.merchantId, requestId: asString(body.requestId), orderId: reference, resultCode: 97, message: "Invalid signature", responseTime: Date.now() };
    }
    const session: SimulatedSession = {
      provider: "MOMO", reference, amount: Number(body.amount), orderInfo: asString(body.orderInfo),
      returnUrl: asString(body.redirectUrl), expiresAtMs: Date.now() + SANDBOX_TTL_MS
    };
    const payUrl = `${config.apiPublicOrigin}/api/user/payments/simulator/momo/checkout?t=${encodeURIComponent(sessionToken(session, credentials))}`;
    const result: JsonObject = {
      partnerCode: credentials.merchantId, orderId: reference, requestId: asString(body.requestId),
      amount: session.amount, resultCode: 0, message: "Request thành công", responseTime: Date.now(),
      payUrl, qrCodeUrl: payUrl, deeplink: payUrl
    };
    result.signature = momoSignature({ ...result, accessKey: credentials.accessKey }, MOMO_CREATE_RESPONSE_KEYS, credentials.secret);
    return result;
  }
  const isRefund = path.endsWith("/refund");
  const keys = isRefund ? MOMO_REFUND_KEYS : MOMO_QUERY_KEYS;
  const signed = momoSignature({
    accessKey: credentials.accessKey,
    amount: scalarOf(body.amount),
    description: asString(body.description),
    orderId: reference,
    partnerCode: asString(body.partnerCode),
    requestId: asString(body.requestId),
    transId: asString(body.transId)
  }, keys, credentials.secret);
  if (!sameSignature(asString(body.signature), signed)) return { resultCode: 97, message: "Invalid signature", orderId: reference, responseTime: Date.now() };
  if (asString(body.partnerCode) !== credentials.merchantId) return { resultCode: 4, message: "Invalid partnerCode", orderId: reference, responseTime: Date.now() };

  if (isRefund) {
    const original = asString(body.transId);
    const source = await momoTransaction(original);
    if (!source) return { resultCode: 42, message: "Invalid transaction", orderId: reference, responseTime: Date.now() };
    if (Number(source.refunded_amount || 0) + Number(body.amount || 0) > Number(source.amount || 0)) {
      return { resultCode: 1081, message: "Refund rejected. The original transaction might have been refunded", orderId: reference, responseTime: Date.now() };
    }
    return {
      partnerCode: credentials.merchantId, orderId: reference, requestId: asString(body.requestId),
      amount: Number(body.amount), transId: gatewayTransactionNo(`refund:${reference}`),
      resultCode: 0, message: "Hoàn tiền sandbox thành công", responseTime: Date.now()
    };
  }
  const { state, row } = await ledgerState(reference, "MOMO");
  if (state === "unknown") return { resultCode: 42, message: "Invalid orderId", orderId: reference, responseTime: Date.now() };
  return {
    partnerCode: credentials.merchantId, requestId: asString(body.requestId), orderId: reference,
    extraData: "", amount: Number(row?.amount || 0), transId: state === "paid" ? Number(gatewayTransactionNo(reference)) : 0,
    payType: "qrCode", resultCode: state === "paid" ? 0 : state === "pending" ? 1000 : 1006,
    message: state === "paid" ? "Giao dịch thành công (sandbox)" : state === "pending" ? "Chờ khách xác nhận (sandbox)" : "Giao dịch thất bại (sandbox)",
    responseTime: Date.now()
  };
}

/** MoMo tra theo transId, không theo orderId của merchant. */
async function momoTransaction(transId: string): Promise<JsonObject | null> {
  if (!transId) return null;
  const row = await selectOne("payment", {
    payment_provider: "momo", gateway_transaction_ref: `eq.${transId}`,
    select: "payment_id,amount,refunded_amount,payment_status", order: "created_at.desc"
  });
  return row && ["paid", "refund_pending", "refunded"].includes(asString(row.payment_status)) ? row : null;
}

function vnpayFromGmt7(value: string): number {
  if (!/^\d{14}$/.test(value)) return NaN;
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(8, 10)) - 7, Number(value.slice(10, 12)), Number(value.slice(12, 14)));
}
