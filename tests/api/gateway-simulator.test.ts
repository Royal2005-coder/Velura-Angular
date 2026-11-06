import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import {
  handleSimulatorApi,
  handleSimulatorCheckout,
  handleSimulatorReturn,
  simulatorReady
} from "../../apps/api/src/payments/gateway-simulator.js";
import {
  gatewayCredentials,
  localGatewayConfigured,
  localGatewaySimulated,
  openLocalGateway,
  verifyVnpayNotification
} from "../../apps/api/src/payments/local-gateways.js";
import { verifyLocalGatewayOrder } from "../../apps/api/src/payments/local-gateway-verify.js";
import { refundLocalGatewayOrder } from "../../apps/api/src/payments/local-gateway-refund.js";
import type { HttpRequest, HttpResponse, JsonObject } from "../../apps/api/src/types.js";

const SIM_SECRET = "simulator-secret-for-tests-0123456789";
const ORDER_ID = "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a";
const AMOUNT = 120000;

interface Recorded { method: string; path: string; body: JsonObject }

function response(): HttpResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const res = {
    statusCode: 200, headers: {} as Record<string, string>, body: "",
    writeHead(status: number, headers?: Record<string, string>) { this.statusCode = status; Object.assign(this.headers, headers || {}); return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    end(data?: string) { this.body += data ?? ""; return this; }
  };
  return res as typeof res;
}

function formRequest(fields: Record<string, string>): HttpRequest {
  const payload = new URLSearchParams(fields).toString();
  return {
    method: "POST", url: "/api/user/payments/simulator/checkout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    async *[Symbol.asyncIterator]() { yield payload; }
  } as unknown as HttpRequest;
}

function getRequest(url: string): HttpRequest {
  return { method: "GET", url, headers: {} } as unknown as HttpRequest;
}

/**
 * Một fetch giả định tuyến cả PostgREST lẫn hai nhà mạng: simulator được gọi đúng như gọi cổng thật,
 * qua cùng URL và cùng định dạng chữ ký mà `openLocalGateway`/`verifyLocalGatewayOrder` phát ra.
 */
function world(options: { ledger?: JsonObject; reconcile?: (body: JsonObject) => JsonObject } = {}) {
  const saved = { ...config };
  const calls: Recorded[] = [];
  let ledger: JsonObject = options.ledger ?? { payment_status: "pending", amount: AMOUNT, gateway_environment: "sandbox", refunded_amount: 0, created_at: new Date().toISOString(), paid_at: null };
  const reference = "c".repeat(32);
  Object.assign(config, {
    supabaseUrl: "https://postgrest.test", supabaseServiceRoleKey: "service-key",
    apiPublicOrigin: "https://api.velura.test", storefrontOrigin: "https://velura.test",
    nodeEnv: "test", vnpayTmnCode: "", vnpayHashSecret: "", vnpayApiUrl: "",
    momoPartnerCode: "", momoAccessKey: "", momoSecretKey: "",
    momoApiOrigin: "https://test-payment.momo.vn", vnpayPaymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
    paymentGatewayEnvironment: "sandbox", paymentGatewaySimulator: true, paymentSimulatorSecret: SIM_SECRET
  });
  const reconcileCalls: JsonObject[] = [];
  const rpcCalls: string[] = [];

  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as JsonObject : {};
    calls.push({ method: init?.method || "GET", path: url.pathname, body });
    if (url.hostname === "postgrest.test") {
      const name = url.pathname.split("/").pop() || "";
      rpcCalls.push(name);
      if (name === "velura_begin_gateway_attempt") {
        return json({ payment_id: "pay-1", order_id: ORDER_ID, amount: AMOUNT, payment_provider: "vnpay", payment_status: "pending", gateway_session_id: reference, gateway_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), created_at: new Date().toISOString(), gateway_environment: "sandbox", gateway_checkout_url: null });
      }
      if (name === "velura_reconcile_gateway_attempt") { reconcileCalls.push(body); return json(options.reconcile?.(body) ?? { code: "00", message: "Capture recorded", payment_status: "paid" }); }
      if (name === "velura_prepare_return_refund") return json({ refund_id: "d".repeat(32), return_id: "ret-1", return_item_id: "item-1", payment_id: "pay-1", amount: AMOUNT, status: "requested" });
      if (name === "velura_complete_return_refund") return json({ status: "succeeded" });
      if (url.pathname === "/rest/v1/orders") return json([{ order_id: ORDER_ID, order_code: "VLR-SIM", is_guest: true }]);
      if (url.pathname === "/rest/v1/payment") {
        // PostgREST lọc theo tham số: simulator chỉ được thấy ledger của đúng reference được hỏi.
        const wanted = String(url.searchParams.get("gateway_session_id") || "").replace(/^eq\./, "");
        if (wanted && wanted !== reference) return json([]);
        return json([{ payment_id: "pay-1", order_id: ORDER_ID, amount: AMOUNT, payment_provider: "vnpay", gateway_session_id: reference, ...ledger }]);
      }
      return json([]);
    }
    // Host của simulator chính là API origin của Velura: điều phối tới handler thật.
    if (url.pathname.endsWith("/simulator/vnpay/api")) {
      const res = response();
      await handleSimulatorApi({ method: "POST", url: url.pathname, headers: {}, body } as unknown as HttpRequest, res, url, "VNPAY", {});
      return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  return {
    calls, rpcCalls, reference,
    reconciles: () => reconcileCalls,
    setLedger(values: Partial<JsonObject>) { ledger = { ...ledger, ...values }; },
    restore() { globalThis.fetch = async () => { throw new Error("original fetch not restored"); }; Object.assign(config, saved); }
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test.afterEach(() => { /* config được world() phục hồi trong từng test */ });

test("the simulator only exists when it is opted into, sandboxed, and has a signing secret", () => {
  const saved = { ...config };
  Object.assign(config, { apiPublicOrigin: "https://api.velura.test", vnpayTmnCode: "", vnpayHashSecret: "", momoPartnerCode: "", momoAccessKey: "", momoSecretKey: "", paymentGatewayEnvironment: "sandbox", paymentGatewaySimulator: true, paymentSimulatorSecret: "short" });
  assert.equal(localGatewaySimulated("VNPAY"), false, "khoá demo quá ngắn thì không bật simulator");
  config.paymentSimulatorSecret = SIM_SECRET;
  assert.equal(localGatewaySimulated("VNPAY"), true);
  assert.equal(localGatewayConfigured("VNPAY"), true);

  // Production không được phục vụ simulator, kể cả khi bật nhầm.
  config.paymentGatewayEnvironment = "production";
  assert.equal(simulatorReady("VNPAY"), false);
  config.paymentGatewayEnvironment = "sandbox";
  config.paymentGatewaySimulator = false;
  assert.equal(simulatorReady("VNPAY"), false, "không bật tường minh thì route simulator phải vô hình");
  Object.assign(config, saved);
});

test("route off the simulator when it is disabled, instead of pretending to be a gateway", async () => {
  const saved = { ...config };
  Object.assign(config, { apiPublicOrigin: "https://api.velura.test", paymentGatewaySimulator: false, paymentSimulatorSecret: SIM_SECRET, paymentGatewayEnvironment: "sandbox", vnpayTmnCode: "", vnpayHashSecret: "", momoPartnerCode: "", momoAccessKey: "", momoSecretKey: "" });
  await assert.rejects(
    () => handleSimulatorCheckout(getRequest("/checkout"), response(), new URL("https://api.velura.test/x"), "VNPAY", {}),
    (error: unknown) => error instanceof HttpError && error.status === 404
  );
  Object.assign(config, saved);
});

test("round trip: hosted URL from the gateway helper, signed page, IPN capture, then QueryDR confirms", async () => {
  const env = world();
  const original = globalThis.fetch;
  try {
    const hosted = await openLocalGateway(ORDER_ID, "VNPAY", "10.0.0.9");
    assert.match(hosted.url, /\/api\/user\/payments\/simulator\/vnpay\/checkout/);
    assert.equal(hosted.environment, "sandbox");
    assert.equal(hosted.qr_url, hosted.url, "VNPay không có payload QR riêng nên QR là chính đường dẫn đã ký");

    const page = response();
    await handleSimulatorCheckout(getRequest(hosted.url), page, new URL(hosted.url), "VNPAY", {});
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /MÔI TRƯỜNG MÔ PHỎNG SANDBOX/);
    assert.match(page.body, /120\.000 đ/);
    assert.match(page.body, /data:image\/png;base64,/);

    // Khách bấm "đã thanh toán": simulator ký IPN và giao cho handler của chính Velura.
    const post = response();
    const token = /name="t" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
    assert.ok(token, "trang sandbox phải mang token phiên của đơn này");
    await handleSimulatorReturn(formRequest({ t: token, result: "success" }), post, {} as never, "VNPAY");
    assert.equal(post.statusCode, 303);
    const redirect = new URL(post.headers.location);
    assert.equal(redirect.searchParams.get("payment_return"), "vnpay");
    assert.equal(verifyVnpayNotification(redirect.searchParams, gatewayCredentials("VNPAY").secret), true,
      "phản hồi trình duyệt phải verify được bằng đúng bộ kiểm chữ ký dùng cho VNPay thật");
    const ipn = env.reconciles()[0];
    assert.equal(ipn?.p_success, true);
    assert.equal(ipn?.p_environment, "sandbox");
    assert.equal(ipn?.p_amount, AMOUNT);

    // Đối soát chủ động: simulator trả đúng trạng thái sổ ledger, có chữ ký thật.
    env.setLedger({ payment_status: "paid", gateway_transaction_ref: "123456", paid_at: new Date().toISOString() });
    const verified = await verifyLocalGatewayOrder({ orderId: ORDER_ID, provider: "VNPAY" }, () => {});
    assert.equal(verified.paid, true);
    assert.equal(verified.status, "paid");
  } finally { globalThis.fetch = original; env.restore(); }
});

test("a cancelled session is recorded as a failure, not silently left pending", async () => {
  const env = world({ reconcile: () => ({ code: "00", message: "Failure recorded" }) });
  const original = globalThis.fetch;
  try {
    const hosted = await openLocalGateway(ORDER_ID, "VNPAY", "10.0.0.9");
    const page = response();
    await handleSimulatorCheckout(getRequest(hosted.url), page, new URL(hosted.url), "VNPAY", {});
    const token = /name="t" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
    await handleSimulatorReturn(formRequest({ t: token, result: "cancel" }), response(), {}, "VNPAY");
    const ipn = env.reconciles()[0];
    assert.equal(ipn.p_success, false, "hủy thì không được báo thu tiền");
    assert.equal(ipn.p_environment, "sandbox");
  } finally { globalThis.fetch = original; env.restore(); }
});

test("a tampered checkout link is refused exactly like a bad gateway signature", async () => {
  const env = world();
  const original = globalThis.fetch;
  try {
    const hosted = await openLocalGateway(ORDER_ID, "VNPAY", "10.0.0.9");
    const tampered = new URL(hosted.url);
    // Sửa số tiền ngay trên link: khách không thể tự hạ giá thanh toán của mình.
    tampered.searchParams.set("vnp_Amount", "1000");
    const res = response();
    await handleSimulatorCheckout(getRequest(tampered.pathname + tampered.search), res, tampered, "VNPAY", {});
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /chữ ký/i);
  } finally { globalThis.fetch = original; env.restore(); }
});

test("QueryDR emulation reports the ledger and refuses an unsigned probe", async () => {
  const env = world();
  const original = globalThis.fetch;
  try {
    const secret = gatewayCredentials("VNPAY").secret;
    const signed = (fields: JsonObject): JsonObject => {
      const order = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef", "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"];
      return { ...fields, vnp_SecureHash: order.map(key => String(fields[key] ?? "")).join("|").length ? hashOf(order.map(key => String(fields[key] ?? "")), secret) : "" };
    };
    const call = async (body: JsonObject) => {
      const res = response();
      await handleSimulatorApi({ method: "POST", url: "/x", headers: {}, body } as unknown as HttpRequest, res, new URL("https://api.velura.test/x"), "VNPAY", {});
      return JSON.parse(res.body) as JsonObject;
    };
    const unknown = await call(signed({ vnp_RequestId: "q1", vnp_Version: "2.1.0", vnp_Command: "querydr", vnp_TmnCode: gatewayCredentials("VNPAY").merchantId, vnp_TxnRef: "no-such-session", vnp_TransactionDate: "20261106020000", vnp_CreateDate: "20261106021000", vnp_IpAddr: "127.0.0.1", vnp_OrderInfo: "q" }));
    assert.equal(unknown.vnp_ResponseCode, "91", "simulator không bịa giao dịch chưa tồn tại");

    const unsigned = await call({ vnp_Command: "querydr", vnp_TxnRef: env.reference, vnp_TmnCode: gatewayCredentials("VNPAY").merchantId });
    assert.equal(unsigned.vnp_ResponseCode, "97", "checksum sai phải bị từ chối như VNPay thật");

    env.setLedger({ payment_status: "paid", gateway_transaction_ref: "123456" });
    const paid = await call(signed({ vnp_RequestId: "q2", vnp_Version: "2.1.0", vnp_Command: "querydr", vnp_TmnCode: gatewayCredentials("VNPAY").merchantId, vnp_TxnRef: env.reference, vnp_TransactionDate: "20261106020000", vnp_CreateDate: "20261106021000", vnp_IpAddr: "127.0.0.1", vnp_OrderInfo: "q" }));
    assert.equal(paid.vnp_ResponseCode, "00");
    assert.equal(paid.vnp_TransactionStatus, "00");
    assert.equal(paid.vnp_Amount, String(AMOUNT * 100));
    assert.equal(verifyVnpayHash(paid, secret), true, "phản hồi phải ký được bằng đúng bộ kiểm tra của client");
  } finally { globalThis.fetch = original; env.restore(); }
});

test("refund emulation refuses to reverse a session the gateway never captured", async () => {
  const env = world();
  const original = globalThis.fetch;
  try {
    // Khách chưa trả thật: phiên không có số giao dịch của cổng, nên lệnh hoàn không được phép gửi đi.
    const result = await refundLocalGatewayOrder(ORDER_ID, { amount: AMOUNT, returnId: "ret-1", returnItemId: "item-1", expectedVersion: 1 });
    assert.equal(result.status, "failed");
    assert.match(String(result.message), /số giao dịch/);
    assert.equal(env.calls.filter(call => !call.path.startsWith("/rest/v1")).length, 0, "không được gọi cổng khi chưa có bằng chứng thu tiền");
  } finally { globalThis.fetch = original; env.restore(); }
});

function hashOf(values: string[], secret: string): string {
  return createHmac("sha512", secret).update(values.join("|")).digest("hex");
}

/** Kiểm chữ ký phản hồi QueryDR của client, dùng lại đúng bảng mã tài liệu. */
function verifyVnpayHash(fields: JsonObject, secret: string): boolean {
  const order = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];
  return fields.vnp_SecureHash === hashOf(order.map(key => String(fields[key] ?? "")), secret);
}
