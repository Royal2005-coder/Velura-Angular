import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { config } from "../../apps/api/src/config.js";
import { createReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { handleReturnRoute } from "../../apps/api/src/returns/return-router.js";
import type { ReturnService } from "../../apps/api/src/returns/return-service.js";
import type { AuthContext, HttpRequest, HttpResponse, JsonObject } from "../../apps/api/src/types.js";

const RETURN_ID = "50000000-0000-4000-8000-000000000021";
const ITEM_ID = "50000000-0000-4000-8000-000000000022";

test("item action route forwards the line id, flat partial facts and request IP", async () => {
  const body = { action: "approve", expectedVersion: 4, quantity: 1, reason: "Da xac minh voi khach hang" };
  const req = Readable.from([JSON.stringify(body)]) as unknown as HttpRequest;
  req.method = "POST";
  req.headers = {};
  req.socket = { remoteAddress: "192.0.2.20" };
  let received: unknown[] = [];
  let status = 0;
  let response = "";
  const res = {
    writeHead(value: number) { status = value; },
    end(value: string) { response = value; }
  } as unknown as HttpResponse;
  const path = `/api/v1/admin/returns/${RETURN_ID}/items/${ITEM_ID}/action`;
  const context = { authUser: { id: "actor" }, roleCode: "super_admin", accessToken: "jwt" } as AuthContext;
  const handled = await handleReturnRoute({
    req, res, url: new URL(`http://localhost${path}`), parts: path.slice(1).split("/"), context, headers: {},
    service: { actOnItem: async (...args) => { received = args; return { return_item_id: ITEM_ID }; } } as unknown as ReturnService
  });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.deepEqual(received.slice(1), [RETURN_ID, ITEM_ID, body]);
  assert.equal((received[0] as AuthContext).ipAddress, "192.0.2.20");
  assert.equal(JSON.parse(response).return_item_id, ITEM_ID);
});

test("repository sends flat action facts and mandatory manual refund item id to the new RPCs", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, { supabaseUrl: "https://returns.test", supabaseServiceRoleKey: "fixture", supabaseAnonKey: "fixture" });
  const requests: { url: URL; body: JsonObject; headers: Headers }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body || "{}")), headers: new Headers(init?.headers) });
    return Response.json({ return_item_id: ITEM_ID });
  };
  try {
    const repository = createReturnRepository();
    const facts = { quantity: 1, receivedQuantity: 1, sealIntact: false };
    await repository.actOnItem(RETURN_ID, ITEM_ID, "receive", facts, 4, "actor", "192.0.2.20");
    assert.match(requests[0].url.pathname, /\/rpc\/velura_return_item_action$/);
    assert.deepEqual(requests[0].body, {
      p_return_id: RETURN_ID, p_return_item_id: ITEM_ID, p_action: "receive", p_payload: facts,
      p_expected_version: 4, p_actor_id: "actor"
    });
    assert.equal(requests[0].headers.get("x-velura-client-ip"), "192.0.2.20");
    await repository.recordManualRefund(RETURN_ID, 4, {
      reference: "COD-TRANSFER-1", amount: 120000, transferredAt: "2026-10-29T01:00:00Z",
      proof: `storage://order-evidence/returns/${RETURN_ID}/refund_proof/receipt.png`
    }, "actor", undefined, ITEM_ID);
    assert.match(requests[1].url.pathname, /\/rpc\/velura_record_manual_return_refund$/);
    assert.equal(requests[1].body.p_return_item_id, ITEM_ID);
    assert.equal(requests[1].body.p_expected_version, 4);
    assert.equal(requests.length, 2, "no payment capture write may precede the atomic refund RPC");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, saved);
  }
});

test("repository reads all line facts and asks the SQL helper for the selected line value", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, { supabaseUrl: "https://returns.test", supabaseAnonKey: "fixture-anon", supabaseServiceRoleKey: "fixture-service" });
  const requests: { url: URL; body: JsonObject; headers: Headers }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, body: JSON.parse(String(init?.body || "{}")), headers: new Headers(init?.headers) });
    return url.pathname.endsWith("velura_return_item_refundable_amount") ? Response.json(125000) : Response.json([{ return_item_id: ITEM_ID, version: 4, tags_intact: true }]);
  };
  try {
    const repository = createReturnRepository();
    const result = await repository.listReturnLines(RETURN_ID, "fixture");
    assert.equal(requests[0].url.searchParams.get("select"), "*");
    assert.equal(result.rows[0].tags_intact, true);
    assert.equal(await repository.getItemRefundableAmount(ITEM_ID), 125000);
    assert.deepEqual(requests[1].body, { p_return_item_id: ITEM_ID });
    assert.equal(requests[1].headers.get("apikey"), "fixture-service");
    assert.equal(requests[1].headers.get("authorization"), null, "never forward the order-reader JWT to the service-only helper");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, saved);
  }
});

test("contact history records waiting attention without changing the business stage", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, { supabaseUrl: "https://returns.test", supabaseServiceRoleKey: "fixture", supabaseAnonKey: "fixture" });
  let patch: JsonObject = {};
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/return_exchange") && init?.method === "PATCH") {
      patch = JSON.parse(String(init.body));
      return Response.json([{ return_id: RETURN_ID, status: "REQUESTED", ...patch }]);
    }
    if (url.pathname.endsWith("/return_exchange")) {
      return Response.json([{ return_id: RETURN_ID, status: "REQUESTED", version: 2, contact_history: [{ result: "reached" }] }]);
    }
    return Response.json([]);
  };
  try {
    await createReturnRepository().recordContact(RETURN_ID, { result: "no_answer", note: "Da goi nhung khach chua nghe may", expectedVersion: 2 }, "actor", "admin_operator_cskh_dt", undefined);
    assert.equal(patch.status, undefined);
    assert.equal(patch.attention_status, "waiting_customer");
    assert.equal((patch.contact_history as JsonObject[]).length, 2);
    assert.equal((patch.contact_history as JsonObject[])[1].result, "no_answer");
    assert.equal(patch.version, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, saved);
  }
});
