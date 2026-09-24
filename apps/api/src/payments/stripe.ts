import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { insertRow, selectOne, selectRows, updateRows } from "../supabase.js";

/**
 * Card checkout through Stripe test mode. COD stays a separate path.
 * The order stays pending until `payment_intent.succeeded` marks the payment paid.
 */
export function stripeConfigured(): boolean {
  return Boolean(config.stripeSecretKey);
}

/**
 * Checks the Stripe-Signature header. Rejects stamps older than five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !secret) return false;
  const age = Math.abs(nowMs - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
}

/**
 * Opens a PaymentIntent for one pending online order. Amount is VND, a zero-decimal currency.
 */
export async function createStripePaymentIntent(orderId: string, amount: number): Promise<{ id: string; clientSecret: string }> {
  if (!config.stripeSecretKey) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY. COD vẫn đặt được.");
  }
  const body = new URLSearchParams({
    amount: String(Math.max(0, Math.round(amount))),
    currency: "vnd",
    "metadata[order_id]": orderId,
    "automatic_payment_methods[enabled]": "true"
  });
  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.stripeSecretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json() as { id?: string; client_secret?: string; error?: { message?: string } };
  if (!response.ok || !payload.id || !payload.client_secret) {
    throw new HttpError(502, "STRIPE_INTENT_FAILED", payload.error?.message || "Stripe không tạo được phiên thanh toán.");
  }
  await insertRow("payment", {
    order_id: orderId,
    payment_method: "ONLINE_PAYMENT",
    payment_provider: "stripe",
    amount: Math.max(0, Math.round(amount)),
    payment_status: "pending",
    payment_channel: "stripe",
    gateway_transaction_ref: payload.id
  });
  return { id: payload.id, clientSecret: payload.client_secret };
}

/**
 * Marks the Stripe payment paid and decrements stock once.
 * A repeat webhook for the same PaymentIntent does not decrement again.
 */
export async function markStripePaymentPaid(orderId: string, paymentIntentId: string): Promise<"paid" | "ignored"> {
  const { rows } = await selectRows("payment", {
    order_id: `eq.${orderId}`,
    gateway_transaction_ref: `eq.${paymentIntentId}`,
    limit: 1
  });
  const payment = rows[0];
  if (!payment) return "ignored";
  if (payment.payment_status === "paid") return "paid";
  await updateRows("payment", { payment_id: `eq.${payment.payment_id}` }, {
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    gateway_response_code: "succeeded"
  });
  const { rows: items } = await selectRows("order_item", { order_id: `eq.${orderId}`, limit: 100 });
  for (const item of items) {
    const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
    if (!variant) continue;
    const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
    await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
  }
  return "paid";
}
