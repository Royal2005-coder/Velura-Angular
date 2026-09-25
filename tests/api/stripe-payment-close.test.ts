import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import {
  classifyStripeEvent,
  closeStripePayment,
  markStripePaymentPaid
} from "../../apps/api/src/payments/stripe.js";

const ORDER = "11111111-1111-1111-1111-111111111111";

function event(type: string, object: Record<string, unknown>) {
  return { type, data: { object } };
}

// ---------------------------------------------------------------------------
// Phân loại sự kiện — thuần, không cần mạng
// ---------------------------------------------------------------------------

test("thẻ bị từ chối không trả lượt mã, vì khách còn thử lại được trên cùng phiên", () => {
  // Đây là quyết định quan trọng nhất của bước này. Trả lượt ở đây rồi khách trả thành
  // công ở lần thử thứ hai thì đơn đã thu tiền mà lượt mã và ngân sách đã bị trả lại.
  const action = classifyStripeEvent(event("payment_intent.payment_failed", {
    id: "pi_1",
    metadata: { order_id: ORDER }
  }));
  assert.deepEqual(action, { kind: "ignore", reason: "retry_allowed" });
});

test("phiên Checkout hết hạn thì đóng đúng phiên đó", () => {
  const action = classifyStripeEvent(event("checkout.session.expired", {
    id: "cs_expired",
    metadata: { order_id: ORDER }
  }));
  assert.deepEqual(action, {
    kind: "closed",
    orderId: ORDER,
    reason: "checkout.session.expired",
    sessionId: "cs_expired"
  });
});

test("PaymentIntent bị huỷ cũng là phiên đã đóng, nhưng không mang mã phiên", () => {
  const action = classifyStripeEvent(event("payment_intent.canceled", {
    id: "pi_canceled",
    metadata: { order_id: ORDER }
  }));
  assert.deepEqual(action, {
    kind: "closed",
    orderId: ORDER,
    reason: "payment_intent.canceled",
    sessionId: null
  });
});

test("thanh toán thành công lấy đúng mã PaymentIntent ở cả hai loại sự kiện", () => {
  assert.deepEqual(
    classifyStripeEvent(event("payment_intent.succeeded", { id: "pi_ok", metadata: { order_id: ORDER } })),
    { kind: "paid", orderId: ORDER, paymentIntentId: "pi_ok" }
  );
  assert.deepEqual(
    classifyStripeEvent(event("checkout.session.completed", {
      id: "cs_ok",
      payment_intent: "pi_from_session",
      metadata: { order_id: ORDER }
    })),
    { kind: "paid", orderId: ORDER, paymentIntentId: "pi_from_session" }
  );
});

test("sự kiện thiếu mã đơn hoặc loại lạ thì bỏ qua", () => {
  assert.deepEqual(
    classifyStripeEvent(event("checkout.session.expired", { id: "cs_x", metadata: {} })),
    { kind: "ignore", reason: "missing_order" }
  );
  assert.deepEqual(
    classifyStripeEvent(event("charge.refunded", { id: "ch_x", metadata: { order_id: ORDER } })),
    { kind: "ignore", reason: "charge.refunded" }
  );
});

// ---------------------------------------------------------------------------
// Chuyển trạng thái payment — chặn fetch để không gọi mạng thật
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/**
 * Thay fetch bằng một PostgREST giả. `routes` quyết định mỗi lời gọi trả gì.
 * Trả về danh sách lời gọi đã ghi và hàm khôi phục.
 */
function fakePostgrest(routes: (call: RecordedCall) => unknown): { calls: RecordedCall[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const originalUrl = config.supabaseUrl;
  const originalKey = config.supabaseServiceRoleKey;
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key-for-tests";

  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init?.method || "GET",
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const payload = routes(call);
    return new Response(JSON.stringify(payload ?? []), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      config.supabaseUrl = originalUrl;
      config.supabaseServiceRoleKey = originalKey;
    }
  };
}

const releaseCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/rest/v1/rpc/velura_release_order_voucher");

test("phiên hết hạn đổi payment đang chờ sang failed rồi trả lượt mã đúng một lần", async () => {
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", order_id: ORDER, payment_status: "failed" }];
    }
    return { released: true };
  });
  try {
    const result = await closeStripePayment(ORDER, "checkout.session.expired", "cs_expired");
    assert.equal(result, "closed");

    const patch = pg.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "phải có lệnh cập nhật payment");
    // Điều kiện pending nằm trong câu UPDATE, không ở bước đọc trước — chống hai webhook
    // đến cùng lúc.
    assert.equal(patch.query.get("payment_status"), "eq.pending");
    // Chỉ đóng đúng phiên đã hết hạn, không đóng nhầm phiên khác của cùng đơn.
    assert.equal(patch.query.get("gateway_transaction_ref"), "eq.cs_expired");
    assert.deepEqual(patch.body, {
      payment_status: "failed",
      gateway_response_code: "checkout.session.expired"
    });

    const released = releaseCalls(pg.calls);
    assert.equal(released.length, 1);
    assert.deepEqual(released[0].body, { p_order_id: ORDER, p_reason: "checkout.session.expired" });
  } finally {
    pg.restore();
  }
});

test("webhook gửi lại khi payment đã đóng thì không trả lượt lần hai", async () => {
  // PATCH có điều kiện pending không trúng dòng nào: lần trước đã đóng rồi.
  const pg = fakePostgrest(() => []);
  try {
    const result = await closeStripePayment(ORDER, "checkout.session.expired", "cs_expired");
    assert.equal(result, "ignored");
    assert.equal(releaseCalls(pg.calls).length, 0);
  } finally {
    pg.restore();
  }
});

test("PaymentIntent bị huỷ đóng theo đơn khi không có mã phiên", async () => {
  const pg = fakePostgrest((call) => (call.method === "PATCH" ? [{ payment_id: "pay_1" }] : {}));
  try {
    await closeStripePayment(ORDER, "payment_intent.canceled", null);
    const patch = pg.calls.find((c) => c.method === "PATCH");
    assert.ok(patch);
    assert.equal(patch.query.get("gateway_transaction_ref"), null);
    assert.equal(patch.query.get("order_id"), `eq.${ORDER}`);
    assert.equal(releaseCalls(pg.calls).length, 1);
  } finally {
    pg.restore();
  }
});

test("webhook thành công gửi lại không trừ kho lần hai", async () => {
  // Bản cũ đọc payment rồi mới kiểm `=== "paid"`, nên hai webhook đến cùng lúc đều thấy
  // pending và đều trừ kho. Nay PATCH có điều kiện không trúng thì dừng.
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") return [];
    if (call.method === "GET" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", payment_status: "paid" }];
    }
    return [];
  });
  try {
    const result = await markStripePaymentPaid(ORDER, "pi_ok");
    assert.equal(result, "paid");
    assert.equal(
      pg.calls.filter((c) => c.path === "/rest/v1/variant" && c.method === "PATCH").length,
      0,
      "không được trừ kho khi không phải lần đầu"
    );
  } finally {
    pg.restore();
  }
});

test("thanh toán thành công lần đầu trừ kho đúng số lượng từng dòng", async () => {
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") return [{ payment_id: "pay_1" }];
    if (call.method === "GET" && call.path === "/rest/v1/order_item") {
      return [{ variant_id: "var_a", quantity: 2 }];
    }
    if (call.method === "GET" && call.path === "/rest/v1/variant") {
      return [{ variant_id: "var_a", stock_quantity: 5 }];
    }
    return [];
  });
  try {
    const result = await markStripePaymentPaid(ORDER, "pi_ok");
    assert.equal(result, "paid");
    const stockPatch = pg.calls.find((c) => c.path === "/rest/v1/variant" && c.method === "PATCH");
    assert.ok(stockPatch, "phải trừ kho");
    assert.deepEqual(stockPatch.body, { stock_quantity: 3 });
  } finally {
    pg.restore();
  }
});
