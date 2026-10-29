import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { reconcilePendingStripePayments, startStripeReconciliation } from "../../apps/api/src/payments/stripe-reconcile.js";

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
