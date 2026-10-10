import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError, sendError } from "../../apps/api/src/http.js";
import { handleStripeVerify } from "../../apps/api/src/payments/stripe-verify.js";
import type { HttpRequest, HttpResponse } from "../../apps/api/src/types.js";

function mockResponse(): HttpResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(data?: string) {
      if (data) this.body += data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    }
  };
  return res as HttpResponse & { statusCode: number; headers: Record<string, string>; body: string };
}

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

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

test("sendError preserves domain HttpError message and details for 5xx errors", () => {
  const res = mockResponse();
  const domainErr = new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY.");
  sendError(res, domainErr);
  assert.equal(res.statusCode, 503);
  const json = JSON.parse(res.body);
  assert.equal(json.error.code, "STRIPE_NOT_CONFIGURED");
  assert.equal(json.error.message, "Chưa cấu hình STRIPE_SECRET_KEY.");
});

test("sendError masks unhandled internal errors safely", () => {
  const res = mockResponse();
  const unhandledErr = new Error("DB connection pool exhausted");
  sendError(res, unhandledErr);
  assert.equal(res.statusCode, 500);
  const json = JSON.parse(res.body);
  assert.equal(json.error.code, "INTERNAL_ERROR");
  assert.equal(json.error.message, "Internal server error");
});

test("handleStripeVerify throws 404 when order cannot be found", async () => {
  const pg = fakePostgrest(() => []);
  try {
    const req = {
      method: "GET",
      url: "/api/user/payments/stripe/verify?order_id=non-existent-order-id",
      headers: { host: "localhost" }
    } as unknown as HttpRequest;
    const res = mockResponse();
    
    await assert.rejects(
      async () => {
        await handleStripeVerify(req, res, {});
      },
      (err: unknown) => {
        return err instanceof HttpError && err.status === 404 && err.code === "ORDER_NOT_FOUND";
      }
    );
  } finally {
    pg.restore();
  }
});

test("handleStripeVerify does not treat confirmed COD as evidence of a Stripe capture", async () => {
  const ORDER_ID = "ord_test_123";
  const pg = fakePostgrest((call) => {
    if (call.path === "/rest/v1/orders") {
      return [{ order_id: ORDER_ID, order_code: "VLR123", status: "confirmed" }];
    }
    return [];
  });
  try {
    const req = {
      method: "GET",
      url: `/api/user/payments/stripe/verify?order_id=${ORDER_ID}`,
      headers: { host: "localhost" }
    } as unknown as HttpRequest;
    const res = mockResponse();
    await handleStripeVerify(req, res, {});
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.success, true);
    assert.equal(json.paid, false);
    assert.equal(json.status, "pending");
  } finally {
    pg.restore();
  }
});

test("handleStripeVerify finds order by order_code and verifies payment", async () => {
  const ORDER_ID = "ord_test_456";
  const ORDER_CODE = "VLR456";
  const pg = fakePostgrest((call) => {
    if (call.path === "/rest/v1/orders") {
      assert.equal(call.query.get("order_code"), `eq.${ORDER_CODE}`);
      return [{ order_id: ORDER_ID, order_code: ORDER_CODE, status: "waiting_payment" }];
    }
    if (call.path === "/rest/v1/payment") {
      return [{ payment_id: "pay_1", payment_status: "paid", gateway_transaction_ref: "cs_test_1" }];
    }
    return [];
  });
  try {
    const req = {
      method: "POST",
      url: "/api/user/payments/stripe/verify",
      headers: { host: "localhost" },
      body: { order_code: ORDER_CODE }
    } as unknown as HttpRequest;
    const res = mockResponse();
    await handleStripeVerify(req, res, {});
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.success, true);
    assert.equal(json.paid, true);
    assert.equal(json.order_code, ORDER_CODE);
  } finally {
    pg.restore();
  }
});
