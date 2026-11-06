import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { refundLocalGatewayOrder, refundOrderPayment } from "../../apps/api/src/payments/local-gateway-refund.js";
import { momoSignature, vnpayPipeHash } from "../../apps/api/src/payments/local-gateways.js";

const SECRET = "gateway-secret-for-refund-tests";
const TMN = "VELURATM01";
const PARTNER = "VELURAMOMO";
const ACCESS = "momo-access-key";
const REFERENCE = "b".repeat(32);
const ORDER_ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const REFUND_ID = "5c4d3e2f-1a0b-9c8d-7e6f-5a4b3c2d1e0f";
const CREATED_AT = "2026-11-05T02:00:00.000Z";

const VNPAY_REFUND_REQUEST_ORDER = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TransactionType", "vnp_TxnRef", "vnp_Amount", "vnp_TransactionNo", "vnp_TransactionDate", "vnp_CreateBy", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"];
const VNPAY_REFUND_RESPONSE_ORDER = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo"];
const MOMO_REFUND_ORDER = ["accessKey", "amount", "description", "orderId", "partnerCode", "requestId", "transId"];

function vnpayRefundResponse(fields: Record<string, string>): Record<string, string> {
  const copy = { ...fields };
  copy.vnp_SecureHash = vnpayPipeHash(VNPAY_REFUND_RESPONSE_ORDER.map(key => copy[key] ?? ""), SECRET);
  return copy;
}

interface Options {
  provider?: "vnpay" | "momo" | "stripe";
  transactionRef?: string | null;
  refundedAmount?: number;
  response?: unknown;
  patchedRows?: unknown[];
  throwOnProvider?: boolean;
}

/** Mock PostgREST + cổng hoàn tiền; ghi lại từng lệnh gọi để kiểm chứng chữ ký và sổ ledger. */
function harness(options: Options) {
  const original = { fetch: globalThis.fetch, values: { ...config } };
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const provider = options.provider ?? "vnpay";
  const payment = {
    payment_id: "pay-1", order_id: ORDER_ID, amount: 150000, refunded_amount: options.refundedAmount ?? 0,
    payment_provider: provider, payment_status: "paid", gateway_session_id: REFERENCE,
    gateway_transaction_ref: options.transactionRef === undefined ? "90001" : options.transactionRef,
    created_at: CREATED_AT, gateway_environment: "sandbox", version: 1
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
    calls.push({ method: init?.method || "GET", path: url.pathname, body });
    if (!url.pathname.startsWith("/rest/v1")) {
      if (options.throwOnProvider) throw new Error("socket hang up");
      return json(options.response ?? {});
    }
    if (url.pathname === "/rest/v1/payment") return json([payment]);
    if (url.pathname === "/rest/v1/rpc/velura_prepare_return_refund") return json({ refund_id: REFUND_ID, return_id: "ret-1", return_item_id: "item-1", payment_id: "pay-1", amount: 150000, status: "requested", provider_ref: null });
    if (url.pathname === "/rest/v1/rpc/velura_complete_return_refund") return json({ status: "succeeded" });
    if (url.pathname === "/rest/v1/payment_refund") return json(options.patchedRows ?? [{ refund_id: REFUND_ID, status: "pending" }]);
    return json([]);
  }) as typeof fetch;
  return {
    calls,
    providerCall: () => calls.find(call => !call.path.startsWith("/rest/v1"))?.body ?? {},
    completed: () => calls.some(call => call.path.includes("velura_complete_return_refund")),
    ledgerStatuses: () => calls.filter(call => call.path === "/rest/v1/payment_refund").map(call => String(call.body.status ?? "")),
    restore() { globalThis.fetch = original.fetch; Object.assign(config, original.values); }
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const returnOptions = { amount: 150000, returnId: "ret-1", returnItemId: "item-1", expectedVersion: 3 };

test("VNPay refund signs the documented list, scales money by 100 and completes only on a settled status", async () => {
  const h = harness({
    response: vnpayRefundResponse({
      vnp_ResponseId: "R1", vnp_Command: "refund", vnp_ResponseCode: "00", vnp_Message: "Accepted", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB", vnp_PayDate: "20261106030000",
      vnp_TransactionNo: "90002", vnp_TransactionType: "02", vnp_TransactionStatus: "00", vnp_OrderInfo: "Hoan tien"
    })
  });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "refunded");
    const request = h.providerCall();
    assert.equal(request.vnp_Command, "refund");
    assert.equal(request.vnp_Amount, "15000000", "mọi trường tiền của VNPay đều nhân 100");
    assert.equal(request.vnp_TransactionType, "02", "hoàn toàn bộ số đã thu");
    assert.equal(request.vnp_TransactionNo, "90001", "lệnh hoàn phải dẫn số giao dịch của cổng, không phải reference của mình");
    assert.equal(request.vnp_SecureHash, vnpayPipeHash(VNPAY_REFUND_REQUEST_ORDER.map(key => String(request[key] ?? "")), SECRET));
    assert.equal(request.vnp_RequestId, REFUND_ID.replace(/-/g, ""), "requestId là refund_id bền vững để retry không thành hoàn tiền lần hai");
    assert.equal(h.completed(), true);
  } finally { h.restore(); }
});

test("a partial refund declares transaction type 03 and cites the smaller amount", async () => {
  const h = harness({
    response: vnpayRefundResponse({
      vnp_ResponseId: "R1", vnp_Command: "refund", vnp_ResponseCode: "00", vnp_Message: "", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "5000000", vnp_BankCode: "NCB", vnp_PayDate: "", vnp_TransactionNo: "90002",
      vnp_TransactionType: "03", vnp_TransactionStatus: "00", vnp_OrderInfo: ""
    })
  });
  try {
    // Không có returnId: đây là hoàn một phần theo yêu cầu hủy đơn, số tiền do người gọi đưa vào.
    await refundLocalGatewayOrder(ORDER_ID, { amount: 50000 });
    assert.equal(h.providerCall().vnp_TransactionType, "03");
    assert.equal(h.providerCall().vnp_Amount, "5000000");
  } finally { h.restore(); }
});

test("a VNPay answer of 00 with a still-processing status keeps the reservation instead of booking money", async () => {
  const h = harness({
    response: vnpayRefundResponse({
      vnp_ResponseId: "R1", vnp_Command: "refund", vnp_ResponseCode: "00", vnp_Message: "Processing", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB", vnp_PayDate: "", vnp_TransactionNo: "90002",
      vnp_TransactionType: "02", vnp_TransactionStatus: "05", vnp_OrderInfo: ""
    })
  });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "requested");
    assert.equal(h.completed(), false, "trạng thái 05 là đang xử lý, chưa được coi là đã hoàn");
    assert.match(String(result.message), /đang xử lý/);
  } finally { h.restore(); }
});

test("an unsigned or wrongly signed VNPay refund answer is never taken as success", async () => {
  const forged = harness({ response: { ...vnpayRefundResponse({
    vnp_ResponseId: "R1", vnp_Command: "refund", vnp_ResponseCode: "00", vnp_Message: "", vnp_TmnCode: TMN,
    vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "", vnp_PayDate: "", vnp_TransactionNo: "90002",
    vnp_TransactionType: "02", vnp_TransactionStatus: "00", vnp_OrderInfo: ""
  }), vnp_SecureHash: "f".repeat(128) } });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "requested", "chữ ký không khớp thì chưa có bằng chứng hoàn tiền");
    assert.equal(forged.completed(), false);
  } finally { forged.restore(); }
});

test("each VNPay refusal code closes the ledger operation so the hand-transfer fallback can run", async () => {
  for (const [code, needle] of [["93", "vượt quá"], ["95", "không thành công"], ["16", "thời gian"]] as const) {
    const h = harness({ response: { vnp_ResponseCode: code, vnp_Message: "Tu choi" } });
    try {
      const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
      assert.equal(result.status, "failed", `mã ${code} là kết quả cuối`);
      assert.match(String(result.message), new RegExp(needle));
      assert.equal(h.completed(), false);
      assert.ok(h.ledgerStatuses().includes("failed"), "phải đóng lệnh là failed thì DB mới cho ghi chuyển khoản tay");
    } finally { h.restore(); }
  }
});

test("a duplicate VNPay refund request is in-flight, not a fresh failure", async () => {
  const h = harness({ response: { vnp_ResponseCode: "94", vnp_Message: "Dang xu ly" } });
  try {
    assert.equal((await refundLocalGatewayOrder(ORDER_ID, returnOptions)).status, "requested");
    assert.equal(h.ledgerStatuses().includes("failed"), false, "một yêu cầu đang chạy không được đánh dấu thất bại");
  } finally { h.restore(); }
});

test("MoMo refund signs its documented field list with a fresh orderId and a stable requestId", async () => {
  const reference = REFUND_ID.replace(/-/g, "");
  const h = harness({
    provider: "momo",
    response: { partnerCode: PARTNER, orderId: reference, requestId: reference, amount: 150000, transId: 991000, resultCode: 0, message: "Ok", responseTime: Date.now() }
  });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "refunded");
    const request = h.providerCall();
    assert.equal(request.transId, 90001, "MoMo hoàn theo transId của giao dịch đã thu");
    assert.equal(request.orderId, reference, "hoàn tiền cần orderId mới hoàn toàn");
    assert.equal(request.requestId, reference, "requestId là khoá idempotent, retry phải giữ nguyên");
    assert.equal(request.signature, momoSignature({ ...request, accessKey: ACCESS }, MOMO_REFUND_ORDER, SECRET));
    assert.equal("accessKey" in request, false, "accessKey chỉ tham gia chuỗi ký, không nằm trong body");
    assert.equal(h.completed(), true);
  } finally { h.restore(); }
});

test("MoMo refuses a refund outside its limits or already covered by the captured balance", async () => {
  const tooSmall = harness({ provider: "momo", refundedAmount: 149500 });
  try {
    assert.equal((await refundLocalGatewayOrder(ORDER_ID, { amount: 500 })).status, "failed");
    assert.equal(Object.keys(tooSmall.providerCall()).length, 0, "không gọi cổng khi số tiền ngoài phạm vi MoMo");
  } finally { tooSmall.restore(); }

  const refused = harness({ provider: "momo", response: { resultCode: 1081, message: "already refunded" } });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "failed");
    assert.match(String(result.message), /đã được hoàn/);
  } finally { refused.restore(); }
});

test("a captured payment without a gateway transaction number cannot be refunded automatically", async () => {
  const h = harness({ transactionRef: null });
  try {
    const result = await refundLocalGatewayOrder(ORDER_ID, returnOptions);
    assert.equal(result.status, "failed");
    assert.match(String(result.message), /số giao dịch/);
    assert.equal(Object.keys(h.providerCall()).length, 0, "không gửi lệnh hoàn khi chưa có số giao dịch");
  } finally { h.restore(); }
});

test("the refund dispatcher follows the provider of the captured payment instead of a hardcoded Stripe", async () => {
  const vnpay = harness({
    provider: "vnpay", response: vnpayRefundResponse({
      vnp_ResponseId: "R1", vnp_Command: "refund", vnp_ResponseCode: "00", vnp_Message: "", vnp_TmnCode: TMN,
      vnp_TxnRef: REFERENCE, vnp_Amount: "15000000", vnp_BankCode: "NCB", vnp_PayDate: "", vnp_TransactionNo: "90002",
      vnp_TransactionType: "02", vnp_TransactionStatus: "00", vnp_OrderInfo: ""
    })
  });
  try {
    assert.equal((await refundOrderPayment(ORDER_ID, returnOptions)).status, "refunded");
    assert.equal(vnpay.providerCall().vnp_Command, "refund", "đơn VNPay phải đi qua API hoàn tiền VNPay");
  } finally { vnpay.restore(); }

  const stripe = harness({ provider: "stripe" });
  try {
    const result = await refundOrderPayment(ORDER_ID, returnOptions);
    assert.equal(stripe.providerCall().vnp_Command ?? "none", "none", "đơn Stripe không được đụng tới cổng VNPay");
    assert.ok(["failed", "skipped", "requested", "refunded"].includes(result.status));
  } finally { stripe.restore(); }
});

test("a lost connection during a gateway refund keeps the reservation for reconciliation", async () => {
  const h = harness({ throwOnProvider: true });
  try {
    assert.equal((await refundLocalGatewayOrder(ORDER_ID, returnOptions)).status, "requested", "mất kết nối không chứng minh là chưa hoàn tiền");
    assert.equal(h.completed(), false);
  } finally { h.restore(); }
});

test("a refund of an order with no captured gateway payment is skipped, not failed", async () => {
  const h = harness({ transactionRef: "90001", patchedRows: [] });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/velura_prepare_return_refund") return json({ refund_id: REFUND_ID, return_id: "ret-1", return_item_id: "item-1", payment_id: "pay-9", amount: 100000, status: "requested" });
    return json([]);
  }) as typeof fetch;
  try {
    assert.equal((await refundLocalGatewayOrder(ORDER_ID, returnOptions)).status, "skipped");
  } finally { globalThis.fetch = original; h.restore(); }
});
