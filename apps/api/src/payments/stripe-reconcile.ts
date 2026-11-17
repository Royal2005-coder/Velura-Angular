import { config } from "../config.js";
import { selectOne, selectRows } from "../supabase.js";
import { asJsonObject, asString } from "../types.js";
import { markStripeRefunded, stripeConfigured } from "./stripe.js";
import { verifyStripeOrder } from "./stripe-verify.js";

/** In-process cooldown so a pending session is not queried on every worker tick. */
const lastAttempt = new Map<string, number>();
const RETRY_AFTER_MS = 5 * 60 * 1000;
const lastRefundAttempt = new Map<string, number>();

/**
 * Confirms captured Stripe sessions that never reached the browser or webhook.
 *
 * Stripe remains the source of truth: this only reads the Checkout Session/PaymentIntent
 * held by the payment row and runs the same guarded transition as a webhook. It never
 * creates a charge and never marks an unpaid session as paid.
 */
export async function reconcilePendingStripePayments(
  limit = 20,
  now = Date.now()
): Promise<{ checked: number; paid: number; still_pending: number }> {
  if (!stripeConfigured()) return { checked: 0, paid: 0, still_pending: 0 };
  const olderThan = new Date(now - 2 * 60 * 1000).toISOString();
  const { rows } = await selectRows("payment", {
    payment_provider: "eq.stripe",
    payment_status: "eq.pending",
    created_at: `lt.${olderThan}`,
    select: "payment_id,order_id,created_at",
    order: "created_at.desc",
    limit
  }, { count: "none" });
  let checked = 0;
  let paid = 0;
  let stillPending = 0;
  for (const row of rows) {
    const orderId = asString(row.order_id);
    if (!orderId) continue;
    const previous = lastAttempt.get(orderId) || 0;
    if (now - previous < RETRY_AFTER_MS) continue;
    lastAttempt.set(orderId, now);
    checked += 1;
    try {
      const result = await verifyStripeOrder({ orderId });
      if (result.paid) paid += 1;
      else stillPending += 1;
    } catch (error) {
      stillPending += 1;
      console.warn("[STRIPE RECONCILE] order check failed", {
        order_id: orderId,
        code: (error as { code?: string })?.code || "UNKNOWN"
      });
    }
  }
  return { checked, paid, still_pending: stillPending };
}

/**
 * Closes Stripe refunds whose webhook never arrived (endpoint disabled or secret unset).
 *
 * Stripe stays the source of truth: each `pending` refund with a `re_…` reference is read
 * back and handed to the same guarded transition the webhook uses, so a refund is only
 * completed when Stripe reports it `succeeded` for the exact recorded amount.
 */
export async function reconcilePendingStripeRefunds(
  limit = 20,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch
): Promise<{ checked: number; settled: number; still_pending: number }> {
  if (!stripeConfigured()) return { checked: 0, settled: 0, still_pending: 0 };
  const { rows } = await selectRows("payment_refund", {
    status: "eq.pending",
    provider_ref: "like.re_*",
    select: "refund_id,payment_id,provider_ref",
    order: "updated_at.asc",
    limit
  }, { count: "none" });
  let checked = 0;
  let settled = 0;
  let stillPending = 0;
  for (const row of rows) {
    const refundId = asString(row.refund_id);
    const previous = lastRefundAttempt.get(refundId) || 0;
    if (!refundId || now - previous < RETRY_AFTER_MS) continue;
    lastRefundAttempt.set(refundId, now);
    checked += 1;
    try {
      const payment = await selectOne("payment", { payment_id: "eq." + asString(row.payment_id), payment_provider: "eq.stripe" });
      const intent = asString(payment?.gateway_transaction_ref);
      if (!intent.startsWith("pi_")) { stillPending += 1; continue; }
      const response = await fetchImpl(`https://api.stripe.com/v1/refunds/${encodeURIComponent(asString(row.provider_ref))}`, {
        headers: { authorization: `Bearer ${config.stripeSecretKey}` },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) { stillPending += 1; continue; }
      const refund = asJsonObject(await response.json());
      if (asString(refund.id) !== asString(row.provider_ref)) { stillPending += 1; continue; }
      const outcome = ["succeeded", "failed", "canceled"].includes(asString(refund.status))
        ? await markStripeRefunded(intent, undefined, [refund]) : "ignored";
      if (outcome === "refunded") settled += 1;
      else stillPending += 1;
    } catch (error) {
      stillPending += 1;
      console.warn("[STRIPE REFUND RECONCILE] check failed", {
        refund_id: refundId, code: (error as { code?: string })?.code || "UNKNOWN"
      });
    }
  }
  return { checked, settled, still_pending: stillPending };
}

/** Starts the reconciliation loop unless Stripe is not configured. */
export function startStripeReconciliation(
  intervalMs = Number(process.env.STRIPE_RECONCILE_INTERVAL_MS) || 5 * 60 * 1000
): ReturnType<typeof setInterval> | null {
  if (!stripeConfigured() || !config.supabaseServiceRoleKey || intervalMs <= 0) return null;
  const run = () => {
    void reconcilePendingStripePayments().then((result) => {
      if (result.paid > 0) console.warn("[STRIPE RECONCILE]", result);
    }).catch((error: unknown) => {
      console.error("[STRIPE RECONCILE] run failed", { code: (error as { code?: string })?.code || "UNKNOWN" });
    });
    void reconcilePendingStripeRefunds().then((result) => {
      if (result.settled > 0 || result.checked > 0) console.warn("[STRIPE REFUND RECONCILE]", result);
    }).catch((error: unknown) => {
      console.error("[STRIPE REFUND RECONCILE] run failed", { code: (error as { code?: string })?.code || "UNKNOWN" });
    });
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
