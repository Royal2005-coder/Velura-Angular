import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { createCustomerOrderCancelRepository } from "../../apps/api/src/user/order-cancel-service.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

test("customer cancel delegates stock release/restock to the order RPC without pre-writing committed stock", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = config.supabaseUrl;
  const originalKey = config.supabaseServiceRoleKey;
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key-for-tests";

  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method || "GET",
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return new Response(JSON.stringify({ refund_required: false, order: { order_id: "order-1", status: "cancelled" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const repository = createCustomerOrderCancelRepository();
    const result = await repository.cancel("order-1", {
      actorId: "member-1",
      note: "Khách đổi ý",
      expectedVersion: 3
    });
    assert.equal((result as { order?: { status?: string } }).order?.status, "cancelled");
    assert.equal(calls.length, 1, "cancel must not issue a separate orders update");
    assert.equal(calls[0].path, "/rest/v1/rpc/velura_order_service_action");
    assert.equal(calls[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
    config.supabaseUrl = originalUrl;
    config.supabaseServiceRoleKey = originalKey;
  }
});
