import { asNumber, asString, type JsonObject } from "../types.js";

/** Customer-safe payment facts; fulfillment status never proves money was captured. */
export function customerPaymentFacts(payments: readonly JsonObject[]): JsonObject {
  const sorted = [...payments].sort((a, b) => asString(b.created_at).localeCompare(asString(a.created_at)));
  const captured = sorted.find((payment) => ["paid", "refund_pending", "refunded"].includes(asString(payment.payment_status)));
  const latest = captured ?? sorted[0];
  const refunded = sorted.reduce((amount, payment) => amount + asNumber(payment.refunded_amount ??
    (payment.payment_status === "refunded" ? payment.refund_amount : 0)), 0);
  return {
    payment_status: latest?.payment_status ?? "pending",
    refund_status: sorted.some((payment) => payment.payment_status === "refund_pending") ? "pending" : refunded > 0 ? "completed" : null,
    refunded_amount: refunded
  };
}
