import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { reconcilePendingGatewayRefunds } from "../../apps/api/src/payments/local-gateway-reconcile.js";
import { momoSignature, vnpayPipeHash } from "../../apps/api/src/payments/local-gateways.js";

const SECRET = "reconcile-secret-for-tests";
const TMN = "VELURATM01";
const PARTNER = "VELURAMOMO";
const ACCESS = "momo-access-key";
const REFERENCE = "e".repeat(32);
const ORDER_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const CREATED_AT = "2026-11-04T02:00:00.000Z";

/**
 * Vòng đối soát giữ cooldown theo refund_id trong bộ nhớ process (đúng cho production: một process
 * chạy vòng lặp). Mỗi kịch bản vì thế phải dùng một refund_id riêng — giống hệt đời thực, nơi hai
 * lệnh hoàn không bao giờ chung số — thay vì chơi trò đồng hồ.
 */
let scenario = 0;
function newRefundId(): string {
  scenario += 1;
  return `00000000-0000-4000-8000-${String(scenario).padStart(12, "0")}`;
}

const VNPAY_QUERY_RESPONSE_ORDER = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];

function vnpayQueryResponse(fields: Record<string, string>): Record<string, string> {
  const copy = { ...fields };
  copy.vnp_SecureHash = vnpayPipeHash(VNPAY_QUERY_RESPONSE_ORDER.map(key => copy[key] ?? ""), SECRET);
  return copy;
}

function vnpayRefundAnswer(refundNo: string, status: string): Record<string, string> {
  return vnpayQueryResponse({
    vnp_ResponseId: "R1", vnp_Command: "querydr", vnp_ResponseCode: "00", vnp_Message: "OK", vnp_TmnCode: TMN,
    vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB", vnp_PayDate: "20261105020000",
    vnp_TransactionNo: refundNo, vnp_TransactionType: "02", vnp_TransactionStatus: status,
    vnp_OrderInfo: "q", vnp_PromotionCode: "", vnp_PromotionAmount: ""
  });
}

interface Options {
  provider?: "vnpay" | "momo";
  refundNo?: string;
  payment?: Record<string, unknown>;
  answer?: unknown;
}

/** Mock sổ ledger + nhà mạng cho MỘT lệnh hoàn đang chờ đối soát. */
function harness(options: Options) {
  const savedFetch = globalThis.fetch;
  const savedConfig = { ...config };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const patches: Record<string, unknown>[] = [];
  const rpcs: { name: string; body: Record<string, unknown> }[] = [];
  const provider = options.provider ?? "vnpay";
  const refundId = newRefundId();
  const refundHex = refundId.replace(/-/g, "");
  const refundNo = options.refundNo ?? "90002";
  const refund = {
    refund_id: refundId, return_id: "ret-1", return_item_id: "item-1", payment_id: "pay-1",
    amount: 150000, status: "pending", provider_ref: provider === "vnpay" ? `vnpay:${refundNo}` : null
  };
  const payment = {
    payment_id: "pay-1", order_id: ORDER_ID, amount: 150000, payment_provider: provider, payment_status: "refund_pending",
    gateway_session_id: REFERENCE, gateway_environment: "sandbox", gateway_transaction_ref: "90001",
    created_at: CREATED_AT, gateway_expires_at: new Date(Date.now() - 60_000).toISOString(), refunded_amount: 0, ...options.payment
  };
  Object.assign(config, {
    supabaseUrl: "https://postgrest.test", supabaseServiceRoleKey: "service-key", apiPublicOrigin: "https://api.velura.test",
    vnpayTmnCode: TMN, vnpayHashSecret: SECRET, vnpayPaymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
    vnpayApiUrl: "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
    momoPartnerCode: PARTNER, momoAccessKey: ACCESS, momoSecretKey: SECRET, momoApiOrigin: "https://test-payment.momo.vn",
    paymentGatewayEnvironment: "sandbox", paymentGatewaySimulator: false, paymentSimulatorSecret: ""
  });
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path: url.pathname, body });
    if (!url.pathname.startsWith("/rest/v1")) return json(options.answer ?? {});
    if (url.pathname === "/rest/v1/payment_refund" && (init?.method || "GET") === "GET") return json([refund]);
    if (url.pathname === "/rest/v1/payment_refund") { patches.push(body); return json([refund]); }
    if (url.pathname === "/rest/v1/payment") return json([payment]);
    if (url.pathname.includes("/rpc/")) rpcs.push({ name: url.pathname.split("/").pop() || "", body });
    return json([]);
  }) as typeof fetch;
  return {
    refundId, refundHex, refundNo, patches,
    rpc: (name: string) => rpcs.filter(entry => entry.name === name).map(entry => entry.body),
    gatewayPath: () => calls.filter(call => !call.path.startsWith("/rest/v1")).map(call => call.path),
    gatewayBody: () => calls.find(call => !call.path.startsWith("/rest/v1"))?.body ?? {},
    restore() { globalThis.fetch = savedFetch; Object.assign(config, savedConfig); }
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("a settled VNPay refund closes the ledger operation instead of leaving it pending forever", async () => {
  const h = harness({ provider: "vnpay", answer: vnpayRefundAnswer("90002", "00") });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.settled, 1);
    assert.equal(h.rpc("velura_complete_return_refund").length, 1, "phải gọi RPC tất toán đúng một lần");
    assert.equal(h.gatewayPath()[0], "/merchant_webapi/api/transaction");
  } finally { h.restore(); }
});

test("a VNPay refund still in flight keeps its reservation and writes nothing", async () => {
  for (const status of ["05", "06"]) {
    const h = harness({ provider: "vnpay", answer: vnpayRefundAnswer("90002", status) });
    try {
      const result = await reconcilePendingGatewayRefunds(5, Date.now());
      assert.equal(result.still_pending, 1, `trạng thái ${status} là đang xử lý`);
      assert.equal(result.settled, 0);
      assert.equal(result.refused, 0);
      assert.equal(h.patches.length, 0, "chưa có bằng chứng thì không được sửa sổ");
      assert.equal(h.rpc("velura_complete_return_refund").length, 0);
    } finally { h.restore(); }
  }
});

test("a refused VNPay refund closes the operation as failed, which is what unlocks the manual transfer", async () => {
  const h = harness({ provider: "vnpay", answer: vnpayRefundAnswer("90002", "09") });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.refused, 1);
    assert.equal(h.patches[0]?.status, "failed", "migration 113 đòi một lệnh 'failed' trước khi cho ghi chuyển khoản tay");
    assert.equal(h.rpc("velura_complete_return_refund").length, 0);
  } finally { h.restore(); }
});

test("a VNPay answer about a DIFFERENT transaction number is not treated as this refund", async () => {
  // Số giao dịch phản hồi phải là số lệnh hoàn đã lưu. Đóng ledger theo một giao dịch khác là trả
  // tiền hai lần cho cùng một phần hàng.
  const h = harness({ provider: "vnpay", answer: vnpayRefundAnswer("777777", "00") });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.settled, 0);
    assert.equal(result.still_pending, 1);
    assert.equal(h.patches.length, 0);
  } finally { h.restore(); }
});

test("an unsigned VNPay refund answer is never taken as proof of settlement", async () => {
  const h = harness({ provider: "vnpay", answer: { vnp_ResponseCode: "00", vnp_TransactionStatus: "00", vnp_TransactionNo: "90002", vnp_TmnCode: TMN, vnp_TxnRef: REFERENCE } });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.settled, 0, "thiếu chữ ký thì chưa phải bằng chứng");
    assert.equal(h.patches.length, 0);
  } finally { h.restore(); }
});

test("MoMo refund/query signs the documented list and settles only on resultCode 0", async () => {
  const settled = harness({
    provider: "momo",
    answer: { partnerCode: PARTNER, amount: 150000, transId: 991001, resultCode: 0, message: "Ok", responseTime: Date.now() }
  });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.settled, 1);
    assert.equal(settled.gatewayPath()[0], "/v2/gateway/api/refund/query",
      "phải hỏi API tra trạng thái hoàn tiền, không phải API tra thanh toán");
    const request = settled.gatewayBody();
    assert.equal(request.orderId, settled.refundHex, "orderId của LỆNH HOÀN, không phải lệnh thu");
    assert.equal(request.signature, momoSignature(
      { accessKey: ACCESS, orderId: settled.refundHex, partnerCode: PARTNER, requestId: settled.refundHex },
      ["accessKey", "orderId", "partnerCode", "requestId"], SECRET));
    assert.equal("accessKey" in request, false, "accessKey chỉ tham gia chuỗi ký, không nằm trong body");
  } finally { settled.restore(); }

  const refused = harness({ provider: "momo", answer: { resultCode: 1081, message: "already refunded" } });
  try {
    assert.equal((await reconcilePendingGatewayRefunds(5, Date.now())).refused, 1);
  } finally { refused.restore(); }

  const processing = harness({ provider: "momo", answer: { resultCode: 7000, message: "processing" } });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.still_pending, 1);
    assert.equal(processing.patches.length, 0);
  } finally { processing.restore(); }
});

test("a production-tagged session is never reconciled by the sandbox loop", async () => {
  const h = harness({ provider: "vnpay", payment: { gateway_environment: "production" }, answer: vnpayRefundAnswer("90002", "00") });
  try {
    const result = await reconcilePendingGatewayRefunds(5, Date.now());
    assert.equal(result.checked, 0, "sai môi trường thì không hỏi cổng, không sửa sổ");
    assert.equal(h.gatewayPath().length, 0);
    assert.equal(h.patches.length, 0);
  } finally { h.restore(); }
});

test("the same refund is not re-queried on every tick, but is asked again after the cooldown", async () => {
  const h = harness({ provider: "vnpay", answer: vnpayRefundAnswer("90002", "05") });
  const now = Date.now();
  try {
    assert.equal((await reconcilePendingGatewayRefunds(5, now)).checked, 1);
    assert.equal((await reconcilePendingGatewayRefunds(5, now + 60_000)).checked, 0, "cooldown phải chặn lần hỏi thứ hai");
    assert.equal((await reconcilePendingGatewayRefunds(5, now + 6 * 60_000)).checked, 1,
      "hết cooldown phải hỏi lại, vì cổng tất toán sau nhiều ngày");
  } finally { h.restore(); }
});
