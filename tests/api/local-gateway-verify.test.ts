import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import { handleLocalGatewayVerify, verifyLocalGatewayOrder } from "../../apps/api/src/payments/local-gateway-verify.js";
import { vnpayPipeHash } from "../../apps/api/src/payments/local-gateways.js";
import { signJwt } from "../../apps/api/src/auth-helper.js";
import type { AuthContext, HttpRequest, HttpResponse } from "../../apps/api/src/types.js";

const SECRET = "sandbox-hash-secret-for-tests";
const TMN = "VELURATM01";
const REFERENCE = "a".repeat(32);
const ORDER_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const CREATED_AT = "2026-11-06T02:00:00.000Z";
const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

/** Bảng mã phản hồi QueryDR theo tài liệu VNPay 2.1.0 — thử nghiệm chốt thứ tự này độc lập với code. */
const VNPAY_RESPONSE_ORDER = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];
const MOMO_QUERY_ORDER = ["accessKey", "orderId", "partnerCode", "requestId"];

function vnpayQueryResponse(fields: Record<string, string>): Record<string, string> {
  const response = { ...fields };
  response.vnp_SecureHash = vnpayPipeHash(VNPAY_RESPONSE_ORDER.map(key => response[key] ?? ""), SECRET);
  return response;
}

function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payment_id: "pay-1", payment_provider: "vnpay", payment_status: "pending", amount: 150000,
    gateway_session_id: REFERENCE, gateway_environment: "sandbox", created_at: CREATED_AT,
    gateway_expires_at: FUTURE, gateway_transaction_ref: null, ...overrides
  };
}

interface HarnessOptions {
  rows?: Record<string, unknown>[];
  /** Nhà mạng trả lời gì cho lệnh query. `null` = không kết nối được. */
  query?: (call: { path: string; body: Record<string, unknown> }) => unknown;
  reconcile?: Record<string, unknown>;
}

/** Chặn mọi fetch: PostgREST + API nhà mạng, và ghi lại để kiểm chứng thứ tự ký. */
function harness(options: HarnessOptions) {
  const original = { fetch: globalThis.fetch, ...snapshotConfig() };
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const call = { method: init?.method || "GET", path: url.pathname, body };
    calls.push(call);
    if (url.pathname === "/rest/v1/orders") return json([{ order_id: ORDER_ID, order_code: "VLR-109", user_id: "member-1", total_amount: 150000, status: "waiting_payment" }]);
    if (url.pathname === "/rest/v1/payment") return json(options.rows ?? [paymentRow()]);
    // PostgREST trả kết quả hàm `returns jsonb` KHÔNG bọc trong mảng (đo thực tế trên production),
    // nên mock phải trả object thô — nếu bọc mảng thì test sẽ "sửa" code theo một hợp đồng sai.
    if (url.pathname.startsWith("/rest/v1/rpc/velura_reconcile_gateway_attempt")) return json(options.reconcile ?? { code: "00", message: "Capture recorded", payment_status: "paid" });
    return json(options.query ? options.query(call) : null);
  }) as typeof fetch;
  return {
    calls,
    gatewayCalls: () => calls.filter(call => !call.path.startsWith("/rest/v1")),
    rpc: () => calls.find(call => call.path.includes("velura_reconcile_gateway_attempt"))?.body ?? {},
    restore() { globalThis.fetch = original.fetch; restoreConfig(original); }
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function snapshotConfig() {
  return {
    vnpayTmnCode: config.vnpayTmnCode, vnpayHashSecret: config.vnpayHashSecret, vnpayPaymentUrl: config.vnpayPaymentUrl,
    vnpayApiUrl: config.vnpayApiUrl, momoPartnerCode: config.momoPartnerCode, momoAccessKey: config.momoAccessKey,
    momoSecretKey: config.momoSecretKey, momoApiOrigin: config.momoApiOrigin, apiPublicOrigin: config.apiPublicOrigin,
    paymentGatewayEnvironment: config.paymentGatewayEnvironment, paymentGatewaySimulator: config.paymentGatewaySimulator,
    paymentSimulatorSecret: config.paymentSimulatorSecret, supabaseUrl: config.supabaseUrl, supabaseServiceRoleKey: config.supabaseServiceRoleKey
  };
}

function restoreConfig(values: ReturnType<typeof snapshotConfig>): void {
  Object.assign(config, values);
}

function useSandboxCredentials(): void {
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key";
  config.apiPublicOrigin = "https://api.velura.test";
  config.vnpayTmnCode = TMN;
  config.vnpayHashSecret = SECRET;
  config.vnpayPaymentUrl = "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
  config.vnpayApiUrl = "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction";
  config.momoPartnerCode = "VELURAMOMO";
  config.momoAccessKey = "momo-access-key";
  config.momoSecretKey = SECRET;
  config.momoApiOrigin = "https://test-payment.momo.vn";
  config.paymentGatewayEnvironment = "sandbox";
  config.paymentGatewaySimulator = false;
  config.paymentSimulatorSecret = "";
}

const member = { profile: { user_id: "member-1" } } as unknown as AuthContext;

test("VNPay QueryDR signs the documented field order and only captures when the gateway says so", async () => {
  useSandboxCredentials();
  const h = harness({
    query: () => vnpayQueryResponse({
      vnp_ResponseId: "Q1", vnp_Command: "querydr", vnp_ResponseCode: "00", vnp_Message: "Thành công",
      vnp_TmnCode: TMN, vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB",
      vnp_PayDate: "20261106020500", vnp_TransactionNo: "90001", vnp_TransactionType: "01",
      vnp_TransactionStatus: "00", vnp_OrderInfo: "query", vnp_PromotionCode: "", vnp_PromotionAmount: ""
    })
  });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    const request = h.gatewayCalls()[0]?.body as Record<string, string>;
    assert.equal(request.vnp_Command, "querydr");
    assert.equal(
      request.vnp_SecureHash,
      vnpayPipeHash(["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef", "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"]
        .map(key => request[key]), SECRET),
      "QueryDR must use the pipe-joined value hash, not the pay-page URL hash"
    );
    assert.equal(result.paid, true);
    assert.deepEqual(h.rpc(), {
      p_provider: "vnpay", p_reference: REFERENCE, p_amount: 150000, p_transaction: "90001",
      p_success: true, p_response_code: "00", p_environment: "sandbox"
    });
  } finally { h.restore(); }
});

test("a sandbox answer never captures a production session, and the mismatch is a 4xx the UI can show", async () => {
  useSandboxCredentials();
  const h = harness({
    rows: [paymentRow({ gateway_environment: "production" })],
    query: () => vnpayQueryResponse({
      vnp_ResponseId: "Q1", vnp_Command: "querydr", vnp_ResponseCode: "00", vnp_Message: "", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB", vnp_PayDate: "20261106020500",
      vnp_TransactionNo: "90001", vnp_TransactionType: "01", vnp_TransactionStatus: "00", vnp_OrderInfo: "", vnp_PromotionCode: "", vnp_PromotionAmount: ""
    }),
    reconcile: { code: "07", message: "Environment mismatch" }
  });
  try {
    await assert.rejects(
      () => verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {}),
      (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === "PAYMENT_SESSION_ENVIRONMENT_MISMATCH"
    );
    // Environment tới từ cấu hình cổng đang gọi, không phải từ row đang đọc — nếu lấy từ row thì kiểm tra này vô nghĩa.
    assert.equal(h.rpc().p_environment, "sandbox");
  } finally { h.restore(); }
});

test("an unreachable or mismatching gateway leaves the order pending instead of inventing a capture", async () => {
  useSandboxCredentials();
  const offline = harness({ query: () => { throw new Error("ETIMEDOUT"); } });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    assert.equal(result.paid, false);
    assert.equal(result.status, "pending");
    assert.equal(offline.rpc().p_success ?? false, false, "no reconcile call may assert a capture");
  } finally { offline.restore(); }

  const wrongAmount = harness({
    query: () => vnpayQueryResponse({
      vnp_ResponseId: "Q1", vnp_Command: "querydr", vnp_ResponseCode: "00", vnp_Message: "", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "10000", vnp_BankCode: "NCB", vnp_PayDate: "20261106020500",
      vnp_TransactionNo: "90001", vnp_TransactionType: "01", vnp_TransactionStatus: "00", vnp_OrderInfo: "", vnp_PromotionCode: "", vnp_PromotionAmount: ""
    })
  });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    assert.equal(result.paid, false);
    assert.equal(wrongAmount.gatewayCalls().length, 1);
    assert.deepEqual(wrongAmount.rpc(), {}, "a tampered amount must never reach the ledger");
  } finally { wrongAmount.restore(); }
});

test("an expired session with no gateway transaction is closed as failed, not left dangling", async () => {
  useSandboxCredentials();
  const h = harness({
    rows: [paymentRow({ gateway_expires_at: PAST })],
    query: () => ({ vnp_ResponseCode: "91", vnp_Message: "Không tìm thấy giao dịch" }),
    reconcile: { code: "00", message: "Failure recorded" }
  });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    assert.equal(result.paid, false);
    assert.equal(result.status, "expired");
    assert.equal(h.rpc().p_success, false);
  } finally { h.restore(); }

  const whileOpen = harness({
    rows: [paymentRow()],
    query: () => ({ vnp_ResponseCode: "91", vnp_Message: "Không tìm thấy giao dịch" })
  });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    assert.equal(result.status, "pending");
    assert.deepEqual(whileOpen.rpc(), {}, "chưa hết hạn thì chưa được đóng phiên");
  } finally { whileOpen.restore(); }
});

test("MoMo query signs accessKey+orderId+partnerCode+requestId and omits accessKey from the body", async () => {
  useSandboxCredentials();
  const h = harness({
    query: call => {
      assert.equal(call.path, "/v2/gateway/api/query");
      const expected = createHmac("sha256", SECRET).update(
        MOMO_QUERY_ORDER.map(key => `${key}=${key === "accessKey" ? config.momoAccessKey : (call.body[key] ?? "")}`).join("&")
      ).digest("hex");
      assert.equal(call.body.signature, expected, "MoMo signs a sorted key=value list, with accessKey injected");
      assert.equal("accessKey" in call.body, false, "MoMo must not receive accessKey in the query body");
      return { partnerCode: config.momoPartnerCode, orderId: REFERENCE, requestId: REFERENCE, amount: 150000, transId: 777001, resultCode: 0, message: "Thành công", responseTime: Date.now() };
    },
    rows: [paymentRow({ payment_provider: "momo" })]
  });
  try {
    const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "MOMO" }, () => {});
    assert.equal(result.paid, true);
    assert.deepEqual(h.rpc(), {
      p_provider: "momo", p_reference: REFERENCE, p_amount: 150000, p_transaction: "777001",
      p_success: true, p_response_code: "0", p_environment: "sandbox"
    });
  } finally { h.restore(); }
});

test("MoMo reports pending codes as still open, so a later poll — not this one — decides", async () => {
  useSandboxCredentials();
  for (const resultCode of [1000, 7000, 9000]) {
    const h = harness({
      rows: [paymentRow({ payment_provider: "momo" })],
      query: () => ({ partnerCode: config.momoPartnerCode, orderId: REFERENCE, amount: 150000, resultCode, message: "Đang xử lý" })
    });
    try {
      const result = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "MOMO" }, () => {});
      assert.equal(result.paid, false, `resultCode ${resultCode} is not a capture`);
      assert.deepEqual(h.rpc(), {}, `resultCode ${resultCode} must not touch the ledger`);
    } finally { h.restore(); }
  }
});

test("a foreign customer cannot probe another order, while a signed guest capability can", async () => {
  useSandboxCredentials();
  const res = () => ({ statusCode: 0, body: "", writeHead(status: number) { this.statusCode = status; return this; }, end(data?: string) { this.body += data ?? ""; return this; }, setHeader() { return this; } }) as unknown as HttpResponse & { statusCode: number; body: string };
  const foreign = { profile: { user_id: "member-2" } } as unknown as AuthContext;
  const guest = { profile: null, roleCode: "guest" } as unknown as AuthContext;
  const request = (body: Record<string, unknown>): HttpRequest => ({ method: "POST", url: "/api/user/payments/vnpay/verify", headers: {}, body } as unknown as HttpRequest);

  const h = harness({ query: () => ({ vnp_ResponseCode: "91", vnp_Message: "Không tìm thấy giao dịch" }) });
  try {
    await assert.rejects(
      () => handleLocalGatewayVerify(request({ order_id: ORDER_ID }), res(), {}, foreign, "VNPAY"),
      (error: unknown) => error instanceof HttpError && error.status === 404 && error.code === "NOT_FOUND",
      "đơn của người khác phải vô hình như đơn không tồn tại, không được 403"
    );
    assert.equal(h.gatewayCalls().length, 0, "từ chối quyền thì không được gọi nhà mạng");

    const capability = signJwt({ purpose: "guest_order_access", order_id: ORDER_ID }, 900);
    const response = res();
    await handleLocalGatewayVerify(request({ order_id: ORDER_ID, order_access_token: capability }), response, {}, guest, "VNPAY");
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).paid, false);
    assert.equal(h.gatewayCalls().length, 1, "khách vãng lai có capability được đối soát đơn của mình");
  } finally { h.restore(); }
});
