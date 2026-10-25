import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import {
  buildCarrierSignature,
  normalizeCarrierEvent,
  verifyCarrierSignature,
} from "../../apps/api/src/carrier/carrier-contract.js";
import { createCarrierService } from "../../apps/api/src/carrier/carrier-service.js";
import { handleCarrierWebhookRoute } from "../../apps/api/src/carrier/carrier-router.js";

const SECRET = "carrier-test-secret";
const ORDER_ID = "50000000-0000-4000-8000-000000000009";
const EVENT = {
  providerEventId: "GHN-88001",
  orderCode: "VLR-2001",
  trackingCode: "VN2200111",
  status: "delivered",
  occurredAt: new Date().toISOString(),
  detail: "Khách đã nhận đủ 2 sản phẩm",
};

/**
 * Stub repository + stub order actions, đủ để kiểm tra thứ tự nghiệp vụ: ghi bằng chứng trước,
 * chỉ chạy state machine khi sự kiện là mới và khớp vận đơn.
 */
function harness(options: {
  order?: Record<string, unknown> | null;
  duplicate?: boolean;
  actionError?: unknown;
} = {}) {
  const calls: { actions: unknown[]; applied: unknown[]; recorded: unknown[] } = { actions: [], applied: [], recorded: [] };
  const repository = {
    async record(event: unknown) {
      calls.recorded.push(event);
      return !options.duplicate;
    },
    async findOrder() {
      return options.order === null ? null : { order_id: ORDER_ID, order_code: "VLR-2001", status: "shipping", tracking_code: "VN2200111", carrier: "GHN", ...(options.order || {}) };
    },
    async markApplied(event: unknown, orderId: string, action: string) {
      calls.applied.push({ event, orderId, action });
    },
  };
  const orders = {
    async serviceAction(orderId: string, input: unknown) {
      if (options.actionError) throw options.actionError;
      calls.actions.push({ orderId, input });
      return { order_id: orderId };
    },
  };
  return { calls, service: createCarrierService({ repository: repository as never, orders: orders as never }) };
}

interface WebhookOptions {
  signature?: string;
  method?: string;
  provider?: string;
  service?: ReturnType<typeof createCarrierService>;
  limiter?: { consume(key: string): { allowed: boolean; remaining: number; resetAt: number } };
}

async function webhook(body: unknown, options: WebhookOptions = {}) {
  const rawBody = JSON.stringify(body);
  const req = {
    method: options.method || "POST",
    headers: { "x-forwarded-for": "10.0.0.9", ...(options.signature ? { "x-carrier-signature": options.signature } : {}) },
    socket: {},
    [Symbol.asyncIterator]: async function* () {
      yield rawBody;
    },
  };
  let response: Record<string, unknown> = {};
  const res = {
    writeHead(status: number, headers: unknown) { response = { status, headers }; },
    end(value: unknown) { response.body = value; },
    setHeader() { return undefined; },
  };
  const result = await handleCarrierWebhookRoute({
    req: req as never,
    res: res as never,
    url: new URL("http://localhost/api/v1/webhooks/carrier/ghn"),
    parts: ["api", "v1", "webhooks", "carrier", options.provider || "ghn"],
    headers: {},
    service: options.service as never,
    limiter: options.limiter as never,
  });
  return { result, response, rawBody };
}

async function thrownError(operation: () => Promise<unknown>): Promise<HttpError> {
  try {
    await operation();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("Expected the route to fail");
}

test("carrier route ignores everything that is not a carrier webhook", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  try {
    const { service } = harness();
    const foreign = await handleCarrierWebhookRoute({
      req: { method: "POST", headers: {}, socket: {} } as never,
      res: { writeHead() {}, end() {}, setHeader() {} } as never,
      url: new URL("http://localhost/api/v1/admin/orders"),
      parts: ["api", "v1", "admin", "orders"],
      headers: {},
      service,
    });
    assert.equal(foreign, false);
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("unsigned, badly signed and expired pushes never reach the order state machine", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  try {
    const { calls, service } = harness();
    const missing = await thrownError(() => webhook(EVENT, { service }));
    assert.equal(missing.status, 401);
    assert.equal(missing.code, "CARRIER_SIGNATURE_MISSING");

    const forged = await thrownError(() => webhook(EVENT, { signature: "t=1,v1=deadbeef", service }));
    assert.equal(forged.code, "CARRIER_SIGNATURE_INVALID");

    const stale = buildCarrierSignature(JSON.stringify(EVENT), SECRET, Date.now() - 6 * 60 * 1000);
    const expired = await thrownError(() => webhook(EVENT, { signature: stale, service }));
    assert.equal(expired.code, "CARRIER_SIGNATURE_INVALID");
    assert.deepEqual(calls.recorded, []);
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("an empty secret fails closed instead of accepting unauthenticated pushes", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = "";
  try {
    const error = await thrownError(() => webhook(EVENT, { signature: buildCarrierSignature(JSON.stringify(EVENT), "anything") }));
    assert.equal(error.status, 503);
    assert.equal(error.code, "CARRIER_WEBHOOK_NOT_CONFIGURED");
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("only GET is refused; a signed delivery event drives the system action", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  try {
    const notFound = await thrownError(() => webhook(EVENT, { method: "GET" }));
    assert.equal(notFound.code, "METHOD_NOT_ALLOWED");

    const { calls, service } = harness();
    const handled = await webhook(EVENT, { signature: buildCarrierSignature(JSON.stringify(EVENT), SECRET), service });
    assert.equal(handled.result, true);
    assert.equal(handled.response.status, 200);
    assert.equal(calls.actions.length, 1);
    const [action] = calls.actions;
    assert.equal((action as { orderId: string }).orderId, ORDER_ID);
    assert.equal((action as { input: { action: string } }).input.action, "carrier_delivered");
    assert.match((action as { input: { note: string } }).input.note, /ghn báo delivered/);
    assert.equal(calls.applied.length, 1);
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("a push that the state machine rejects leaves the evidence unapplied", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  try {
    const { calls, service } = harness({ actionError: new HttpError(422, "INVALID_ORDER_ACTION", "Thao tác không còn hợp lệ với trạng thái hiện tại của đơn.") });
    const error = await thrownError(() =>
      webhook(EVENT, { signature: buildCarrierSignature(JSON.stringify(EVENT), SECRET), service }),
    );
    assert.equal(error.code, "INVALID_ORDER_ACTION");
    assert.equal(calls.recorded.length, 1);
    assert.deepEqual(calls.applied, []);
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("a provider retry is acknowledged once and never applied twice", async () => {
  const { calls, service } = harness({ duplicate: true });
  const outcome = await service.handleEvent((normalizeCarrierEvent("ghn", EVENT) as { ok: true; event: never }).event);
  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.action, "");
  assert.deepEqual(calls.actions, []);
});

test("an event for another order's tracking code is rejected before the order moves", async () => {
  const { calls, service } = harness({ order: { tracking_code: "VN9999999" } });
  const event = (normalizeCarrierEvent("ghn", EVENT) as { ok: true; event: never }).event;
  const error = await thrownError(() => service.handleEvent(event));
  assert.equal(error.status, 422);
  assert.equal(error.code, "CARRIER_TRACKING_MISMATCH");
  assert.deepEqual(calls.actions, []);
});

test("an unknown order code keeps the evidence but answers 404", async () => {
  const { calls, service } = harness({ order: null });
  const event = (normalizeCarrierEvent("ghn", EVENT) as { ok: true; event: never }).event;
  const error = await thrownError(() => service.handleEvent(event));
  assert.equal(error.status, 404);
  assert.equal(calls.recorded.length, 1);
  assert.deepEqual(calls.actions, []);
});

test("statuses outside the three system actions are refused, not guessed", () => {
  for (const status of ["shipping", "Giao hàng thành công", "", "cancelled", "delivered_ok"]) {
    const result = normalizeCarrierEvent("ghn", { ...EVENT, status });
    assert.equal(result.ok, false, status);
    if (!result.ok) assert.equal(result.code, "CARRIER_STATUS_UNSUPPORTED");
  }
  // Khoảng trắng thừa là lỗi định dạng của nguồn gửi, không phải một trạng thái mới.
  for (const status of ["delivered", "failed_retrying", "failed_returned", " delivered "]) {
    assert.equal(normalizeCarrierEvent("ghn", { ...EVENT, status }).ok, true, status);
  }
});

test("malformed events are rejected on their own field", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["CARRIER_EVENT_ID_REQUIRED", { ...EVENT, providerEventId: "x" }],
    ["CARRIER_ORDER_CODE_REQUIRED", { ...EVENT, orderCode: "" }],
    ["CARRIER_TRACKING_REQUIRED", { ...EVENT, trackingCode: "ab" }],
    ["CARRIER_OCCURRED_AT_REQUIRED", { ...EVENT, occurredAt: "không phải ngày" }],
    ["CARRIER_EVENT_FROM_FUTURE", { ...EVENT, occurredAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }],
    ["CARRIER_EVENT_TOO_OLD", { ...EVENT, occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }],
  ];
  for (const [code, body] of cases) {
    const result = normalizeCarrierEvent("ghn", body);
    assert.equal(result.ok, false, code);
    if (!result.ok) assert.equal(result.code, code);
  }
  assert.equal(normalizeCarrierEvent("GHN!", EVENT).ok, false);
  assert.equal(normalizeCarrierEvent("ghn", []).ok, false);
});

test("a flooded provider is limited before any signature work", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  const keys: string[] = [];
  const limiter = {
    consume(key: string) {
      keys.push(key);
      return { allowed: false, remaining: 0, resetAt: Date.now() + 60_000 };
    },
  };
  try {
    const { service } = harness();
    const error = await thrownError(() =>
      webhook(EVENT, { signature: buildCarrierSignature(JSON.stringify(EVENT), SECRET), service, limiter }),
    );
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.match(keys[0], /^ghn:10\.0\.0\.9$/);
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("a provider segment that is not a name never reaches the ledger", async () => {
  const before = config.carrierWebhookSecret;
  config.carrierWebhookSecret = SECRET;
  try {
    const { service } = harness();
    const error = await thrownError(() =>
      webhook(EVENT, { provider: "GHN%20", signature: buildCarrierSignature(JSON.stringify(EVENT), SECRET), service }),
    );
    assert.equal(error.code, "CARRIER_PROVIDER_UNSUPPORTED");
    const untouched = await thrownError(() =>
      webhook(EVENT, { provider: "../etc", signature: buildCarrierSignature(JSON.stringify(EVENT), SECRET), service }),
    );
    assert.equal(untouched.code, "CARRIER_PROVIDER_UNSUPPORTED");
  } finally {
    config.carrierWebhookSecret = before;
  }
});

test("signature verification is timing-safe-shaped and rejects non-hex payloads", () => {  const raw = JSON.stringify(EVENT);
  const fresh = buildCarrierSignature(raw, SECRET);
  assert.equal(verifyCarrierSignature(raw, fresh, SECRET), true);
  assert.equal(verifyCarrierSignature(`${raw} `, fresh, SECRET), false);
  assert.equal(verifyCarrierSignature(raw, fresh, ""), false);
  assert.equal(verifyCarrierSignature(raw, "t=abc,v1=zz", SECRET), false);
  assert.equal(verifyCarrierSignature(raw, `t=${Math.floor(Date.now() / 1000)},v1=`, SECRET), false);
});
