import test from "node:test";
import assert from "node:assert/strict";
import { handleOrderRoute } from "../../apps/api/src/orders/order-router.js";

const ORDER_ID = "50000000-0000-4000-8000-000000000001";
const PAYMENT_ID = "60000000-0000-4000-8000-000000000001";

test("router ignores non-order routes", async () => {
  const handled = await route("GET", ["api", "v1", "admin", "products"], {}, {});
  assert.equal(handled.result, false);
});

test("GET order list and detail delegate to service", async () => {
  const list = await route("GET", ["api", "v1", "admin", "orders"], {}, {
    list: async () => ({ rows: [], count: 0 })
  });
  assert.equal(list.result, true);
  assert.equal(list.response.status, 200);

  const detail = await route("GET", ["api", "v1", "admin", "orders", ORDER_ID], {}, {
    get: async (_context, id) => ({ order_id: id })
  });
  assert.equal(JSON.parse(detail.response.body).order_id, ORDER_ID);
});

test("POST status, cancel and payment resolve parse JSON bodies", async () => {
  let statusBody;
  const status = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, "change-status"], {
    status: "confirmed", reason: "Da xac minh thong tin dat hang", expectedVersion: 1
  }, { changeStatus: async (_context, _id, body) => { statusBody = body; return { status: body.status }; } });
  assert.equal(status.result, true);
  assert.equal(statusBody.status, "confirmed");

  const cancel = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, "cancel"], {
    reason: "Khach hang yeu cau huy don hang", expectedVersion: 2
  }, { cancel: async () => ({ refund_pending: false }) });
  assert.equal(cancel.response.status, 200);

  let paymentId;
  const payment = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, "payments", PAYMENT_ID, "resolve"], {
    decision: "mark_paid", reason: "Da doi soat thanh toan thu cong", expectedOrderVersion: 2, expectedPaymentVersion: 1
  }, { resolvePayment: async (_context, _orderId, id) => { paymentId = id; return { payment_id: id }; } });
  assert.equal(paymentId, PAYMENT_ID);
  assert.equal(payment.response.status, 200);
});

async function route(method, parts, body, service) {
  const path = `/${parts.join("/")}`;
  const req = {
    method,
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: {},
    [Symbol.asyncIterator]: async function* () {
      if (method !== "GET") yield JSON.stringify(body);
    }
  };
  let response = {};
  const res = {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(value) { response.body = value; }
  };
  const result = await handleOrderRoute({
    req,
    res,
    url: new URL(`http://localhost${path}`),
    parts,
    context: {},
    headers: {},
    service
  });
  return { result, response };
}
