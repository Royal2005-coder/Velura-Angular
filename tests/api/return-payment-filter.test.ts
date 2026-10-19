import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { createReturnRepository } from "../../apps/api/src/returns/return-repository.js";

test("payment filtering joins the purchased order, not the ambiguous replacement-order relationship", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  Object.assign(config, { supabaseUrl: "https://returns.test", supabaseAnonKey: "fixture" });
  const queries: URL[] = [];
  globalThis.fetch = async input => { queries.push(new URL(String(input))); return Response.json([]); };
  try {
    const repository = createReturnRepository();
    await repository.listReturns({ paymentKind: "cod", limit: 10, offset: 0 }, "fixture");
    await repository.listReturns({ paymentKind: "online", limit: 10, offset: 0 }, "fixture");
    assert.equal(queries.length, 2);
    for (const url of queries) {
      assert.ok(url.searchParams.get("select")?.includes("pay_order:orders!return_exchange_order_id_fkey!inner(payment_method)"));
    }
    assert.equal(queries[0].searchParams.get("pay_order.payment_method"), "eq.COD");
    assert.equal(queries[1].searchParams.get("pay_order.payment_method"), "eq.ONLINE_PAYMENT");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, saved);
  }
});
