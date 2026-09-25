import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import {
  classifyStripeEvent,
  closeStripePayment,
  markStripePaymentPaid,
  markStripeRefunded,
  refundStripeOrder
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
    classifyStripeEvent(event("customer.created", { id: "cus_x", metadata: { order_id: ORDER } })),
    { kind: "ignore", reason: "customer.created" }
  );
});

test("hoàn tiền nhận ra theo PaymentIntent của charge, không cần metadata", () => {
  assert.deepEqual(
    classifyStripeEvent(event("charge.refunded", { id: "ch_x", payment_intent: "pi_paid" })),
    { kind: "refunded", paymentIntentId: "pi_paid" }
  );
  assert.deepEqual(
    classifyStripeEvent(event("charge.refunded", { id: "ch_x", payment_intent: { id: "pi_obj" } })),
    { kind: "refunded", paymentIntentId: "pi_obj" }
  );
  assert.deepEqual(
    classifyStripeEvent(event("charge.refunded", { id: "ch_x" })),
    { kind: "ignore", reason: "missing_payment_intent" }
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
const orderActionCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/rest/v1/rpc/velura_order_service_action");
const bodyOf = (call: RecordedCall | undefined) => (call?.body ?? {}) as Record<string, unknown>;

test("phiên hết hạn đổi payment đang chờ sang failed, đơn giữ Chờ thanh toán và chưa trả lượt mã", async () => {
  // OPEN-05: khách còn thanh toán lại trong 24 giờ với đúng mức giảm đã thấy. Lượt mã
  // chỉ được trả khi đơn thật sự bị huỷ.
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", order_id: ORDER, payment_status: "failed" }];
    }
    return [];
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

    assert.equal(releaseCalls(pg.calls).length, 0);
    assert.equal(orderActionCalls(pg.calls).length, 0, "không đổi trạng thái đơn");
  } finally {
    pg.restore();
  }
});

test("webhook gửi lại khi payment đã đóng thì bỏ qua", async () => {
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
  const pg = fakePostgrest((call) => (call.method === "PATCH" ? [{ payment_id: "pay_1" }] : []));
  try {
    await closeStripePayment(ORDER, "payment_intent.canceled", null);
    const patch = pg.calls.find((c) => c.method === "PATCH");
    assert.ok(patch);
    assert.equal(patch.query.get("gateway_transaction_ref"), null);
    assert.equal(patch.query.get("order_id"), `eq.${ORDER}`);
    assert.equal(releaseCalls(pg.calls).length, 0);
  } finally {
    pg.restore();
  }
});

test("webhook thành công gửi lại không chuyển đơn lần hai", async () => {
  // Bản cũ đọc payment rồi mới kiểm `=== "paid"`, nên hai webhook đến cùng lúc đều thấy
  // pending. Nay PATCH có điều kiện không trúng thì dừng.
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
    assert.equal(orderActionCalls(pg.calls).length, 0, "không được gọi action lần hai");
    assert.equal(pg.calls.filter((c) => c.path === "/rest/v1/variant").length, 0);
  } finally {
    pg.restore();
  }
});

test("thanh toán thành công lần đầu: System chuyển đơn qua action payment_succeeded, kho trừ ở CSDL", async () => {
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") return [{ payment_id: "pay_1", amount: 500000 }];
    if (call.method === "GET" && call.path === "/rest/v1/orders") return [{ order_id: ORDER, status: "waiting_payment" }];
    return { order: { order_id: ORDER, status: "confirmed" } };
  });
  try {
    const result = await markStripePaymentPaid(ORDER, "pi_ok");
    assert.equal(result, "paid");
    const actions = orderActionCalls(pg.calls);
    assert.equal(actions.length, 1);
    assert.equal(bodyOf(actions[0]).p_action, "payment_succeeded");
    assert.equal(bodyOf(actions[0]).p_order_id, ORDER);
    // Kho không còn trừ bằng vòng lặp ở API: RPC trừ trong cùng giao dịch với đổi trạng thái.
    assert.equal(pg.calls.filter((c) => c.path === "/rest/v1/variant").length, 0);
  } finally {
    pg.restore();
  }
});

test("tiền về khi đơn đã huỷ: không chuyển đơn, không trừ kho, tự hoàn tiền (OPEN-05)", async () => {
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", amount: 500000, payment_status: "paid" }];
    }
    if (call.method === "GET" && call.path === "/rest/v1/orders") return [{ order_id: ORDER, status: "cancelled" }];
    if (call.method === "GET" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", gateway_transaction_ref: "pi_late", version: 2 }];
    }
    return [];
  });
  // Không có khoá Stripe trong test: yêu cầu hoàn tiền được đánh dấu lỗi để admin thử lại.
  const originalKey = config.stripeSecretKey;
  config.stripeSecretKey = "";
  try {
    const result = await markStripePaymentPaid(ORDER, "pi_late");
    assert.equal(result, "refunding");
    assert.equal(orderActionCalls(pg.calls).length, 0);
    assert.equal(pg.calls.filter((c) => c.path === "/rest/v1/variant").length, 0);
    const refundPending = pg.calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/payment"
      && bodyOf(c).payment_status === "refund_pending");
    assert.ok(refundPending, "payment phải sang Chờ hoàn tiền");
    assert.equal(bodyOf(refundPending).refund_amount, 500000);
  } finally {
    config.stripeSecretKey = originalKey;
    pg.restore();
  }
});

// ---------------------------------------------------------------------------
// Hoàn tiền Stripe — fetch của Stripe tách khỏi PostgREST giả
// ---------------------------------------------------------------------------

interface StripeCall {
  url: string;
  headers: Record<string, string>;
}

function stripeReply(status: number, body: unknown): { impl: typeof fetch; calls: StripeCall[] } {
  const calls: StripeCall[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

function refundPostgrest() {
  return fakePostgrest((call) => {
    if (call.method === "GET" && call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", gateway_transaction_ref: "pi_paid", version: 3 }];
    }
    if (call.method === "PATCH") return [{ payment_id: "pay_1" }];
    return [];
  });
}

async function withStripeKey(run: () => Promise<void>): Promise<void> {
  const originalKey = config.stripeSecretKey;
  config.stripeSecretKey = "sk_test_for_tests";
  try {
    await run();
  } finally {
    config.stripeSecretKey = originalKey;
  }
}

test("Stripe hoàn xong ngay thì payment sang Đã hoàn tiền; idempotency key theo payment và phiên bản", async () => {
  const pg = refundPostgrest();
  const stripe = stripeReply(200, { id: "re_1", status: "succeeded" });
  try {
    await withStripeKey(async () => {
      const result = await refundStripeOrder(ORDER, stripe.impl);
      assert.deepEqual(result, { status: "refunded" });
    });
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0].url, "https://api.stripe.com/v1/refunds");
    assert.equal(stripe.calls[0].headers["idempotency-key"], "refund-pay_1-3");
    const done = pg.calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/payment");
    assert.equal(bodyOf(done).payment_status, "refunded");
    assert.equal(done?.query.get("payment_status"), "eq.refund_pending");
  } finally {
    pg.restore();
  }
});

test("Stripe nhận yêu cầu nhưng xử lý sau thì giữ Chờ hoàn tiền, chờ webhook", async () => {
  const pg = refundPostgrest();
  try {
    await withStripeKey(async () => {
      const result = await refundStripeOrder(ORDER, stripeReply(200, { id: "re_1", status: "pending" }).impl);
      assert.deepEqual(result, { status: "requested" });
    });
    assert.equal(pg.calls.filter((c) => c.method === "PATCH").length, 0);
  } finally {
    pg.restore();
  }
});

test("Stripe từ chối thì gắn REFUND_FAILED và ghi một dòng lịch sử xử lý (OPEN-02)", async () => {
  const pg = refundPostgrest();
  try {
    await withStripeKey(async () => {
      const result = await refundStripeOrder(ORDER, stripeReply(400, { error: { message: "charge_already_refunded" } }).impl);
      assert.equal(result.status, "failed");
    });
    const flagged = pg.calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/payment");
    assert.deepEqual(flagged?.body, { gateway_response_code: "REFUND_FAILED" });
    const logged = pg.calls.find((c) => c.method === "POST" && c.path === "/rest/v1/order_event");
    assert.ok(logged, "phải ghi order_event");
    assert.equal(bodyOf(logged).action, "refund_failed");
  } finally {
    pg.restore();
  }
});

test("không có payment nào chờ hoàn thì không gọi Stripe", async () => {
  const pg = fakePostgrest(() => []);
  const stripe = stripeReply(200, { id: "re_1", status: "succeeded" });
  try {
    await withStripeKey(async () => {
      const result = await refundStripeOrder(ORDER, stripe.impl);
      assert.equal(result.status, "skipped");
    });
    assert.equal(stripe.calls.length, 0);
  } finally {
    pg.restore();
  }
});

test("webhook charge.refunded chốt Đã hoàn tiền một lần; gửi lại thì bỏ qua", async () => {
  let hits = 0;
  const pg = fakePostgrest((call) => {
    if (call.method === "PATCH" && call.path === "/rest/v1/payment") {
      hits += 1;
      return hits === 1 ? [{ payment_id: "pay_1" }] : [];
    }
    return [];
  });
  try {
    assert.equal(await markStripeRefunded("pi_paid"), "refunded");
    assert.equal(await markStripeRefunded("pi_paid"), "ignored");
    const patch = pg.calls.find((c) => c.method === "PATCH");
    assert.equal(patch?.query.get("gateway_transaction_ref"), "eq.pi_paid");
    assert.equal(patch?.query.get("payment_status"), "eq.refund_pending");
  } finally {
    pg.restore();
  }
});
