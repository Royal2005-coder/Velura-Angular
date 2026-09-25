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

test("the old change-status and cancel routes are gone", async () => {
  for (const segment of ["change-status", "cancel"]) {
    const handled = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, segment], {}, {});
    assert.equal(handled.result, false);
  }
});

test("GET summary is not mistaken for an order id", async () => {
  const summary = await route("GET", ["api", "v1", "admin", "orders", "summary"], {}, {
    summary: async () => ({ by_status: [], attention: 0 }),
    get: async () => { throw new Error("summary must not hit get"); }
  });
  assert.equal(JSON.parse(summary.response.body).attention, 0);
});

test("POST action, carrier simulation and payment resolve parse JSON bodies", async () => {
  let action;
  let actionBody;
  const performed = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, "actions", "confirm_cod"], {
    note: "Da goi xac nhan voi khach", expectedVersion: 1
  }, { performAction: async (_context, _id, code, body) => { action = code; actionBody = body; return { order: {} }; } });
  assert.equal(performed.result, true);
  assert.equal(action, "confirm_cod");
  assert.equal(actionBody.expectedVersion, 1);

  let outcome;
  const simulated = await route("POST", ["api", "v1", "admin", "orders", ORDER_ID, "simulate-carrier"], {
    outcome: "delivered"
  }, { simulateCarrier: async (_context, _id, body) => { outcome = body.outcome; return { order: {} }; } });
  assert.equal(simulated.response.status, 200);
  assert.equal(outcome, "delivered");

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
