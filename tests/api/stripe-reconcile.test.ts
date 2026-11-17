import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { reconcilePendingStripePayments, reconcilePendingStripeRefunds, startStripeReconciliation } from "../../apps/api/src/payments/stripe-reconcile.js";

test("Stripe reconciliation stays inert when Stripe is not configured", async () => {
  const before = config.stripeSecretKey;
  config.stripeSecretKey = "";
  try {
    assert.deepEqual(await reconcilePendingStripePayments(), { checked: 0, paid: 0, still_pending: 0 });
    assert.equal(startStripeReconciliation(), null);
  } finally {
    config.stripeSecretKey = before;
  }
});

test("refund return pending vì mất webhook được đóng khi Stripe báo succeeded, và chỉ khi đó", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { key: config.stripeSecretKey, url: config.supabaseUrl, srk: config.supabaseServiceRoleKey };
  config.stripeSecretKey = "sk_test_x";
  config.supabaseUrl = "https://postgrest.test";
  config.supabaseServiceRoleKey = "service-key";
  const operation = { refund_id: "r1", payment_id: "p1", provider_ref: "re_1", return_id: "ret1", return_item_id: "it1", amount: 2000, status: "pending" };
  const payment = { payment_id: "p1", order_id: "o1", payment_provider: "stripe", gateway_transaction_ref: "pi_1", amount: 5000 };
  const rpcs: string[] = [];
  let stripeStatus = "pending";
  const router = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.host === "api.stripe.com") return json({ id: "re_1", status: stripeStatus, amount: 2000, payment_intent: "pi_1", metadata: {} });
    if (url.pathname.includes("/rpc/")) { rpcs.push(url.pathname.split("/").pop() || ""); return json({}); }
    if (url.pathname.endsWith("/payment_refund")) return json(init?.method === "PATCH" ? [operation] : [operation]);
    if (url.pathname.endsWith("/payment")) return json([payment]);
    return json([]);
  }) as typeof fetch;
  globalThis.fetch = router;
  try {
    const first = await reconcilePendingStripeRefunds(20, 1_000_000, router);
    assert.deepEqual(first, { checked: 1, settled: 0, still_pending: 1 });
    assert.deepEqual(rpcs.filter((name) => name === "velura_complete_return_refund"), []);
    stripeStatus = "succeeded";
    const second = await reconcilePendingStripeRefunds(20, 1_000_000 + 6 * 60 * 1000, router);
    assert.deepEqual(second, { checked: 1, settled: 1, still_pending: 0 });
    assert.deepEqual(rpcs.filter((name) => name === "velura_complete_return_refund"), ["velura_complete_return_refund"]);
  } finally {
    globalThis.fetch = originalFetch;
    config.stripeSecretKey = saved.key;
    config.supabaseUrl = saved.url;
    config.supabaseServiceRoleKey = saved.srk;
  }
});
