import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../../apps/api/src/payments/stripe.js";

test("a fresh Stripe signature matches and a stale one does not", () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ type: "payment_intent.succeeded" });
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, secret, now), true);
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=deadbeef`, secret, now), false);
  assert.equal(verifyStripeSignature(raw, `t=${Number(timestamp) - 600},v1=${signature}`, secret, now), false);
});
