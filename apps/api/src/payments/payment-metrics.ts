const paymentEvents = new Map<string, number>();
const paymentAmounts = new Map<string, number>();
const refundEvents = new Map<string, number>();
const refundAmounts = new Map<string, number>();
const webhookEvents = new Map<string, number>();
const reconcileEvents = new Map<string, number>();

interface LedgerAggregation {
  amount: number;
  count: number;
}
const ledgerPayments = new Map<string, LedgerAggregation>();
const ledgerRefunds = new Map<string, LedgerAggregation>();
let lastLedgerSync = 0;
const LEDGER_CACHE_MS = 30_000;

const SAFE_TOKEN = /^[a-z0-9_.-]{1,64}$/;

function cleanToken(value: unknown, fallback = "unknown"): string {
  const str = String(value ?? "").trim().toLowerCase();
  return SAFE_TOKEN.test(str) ? str : fallback;
}

/**
 * Đồng bộ tổng hợp ledger từ DB — một lượt gọi, số dòng trả về không phụ thuộc số đơn
 * (`velura_payment_ledger_metrics`). Cache 30s để scrape không thành quét bảng.
 */
export async function refreshLedgerMetrics(supabaseUrl: string, supabaseKey: string): Promise<void> {
  const now = Date.now();
  if (now - lastLedgerSync < LEDGER_CACHE_MS && (ledgerPayments.size > 0 || ledgerRefunds.size > 0)) {
    return;
  }
  if (!supabaseUrl || !supabaseKey) {
    return;
  }
  lastLedgerSync = now;
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/velura_payment_ledger_metrics`, {
      method: "POST",
      headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const payload = await response.json() as { payments?: unknown; refunds?: unknown };
    // PostgREST trả jsonb thô (không bọc mảng) — cùng hợp đồng đã đo thật ở các RPC khác.
    ledgerPayments.clear();
    ledgerRefunds.clear();
    absorb(ledgerPayments, Array.isArray(payload.payments) ? payload.payments : []);
    absorb(ledgerRefunds, Array.isArray(payload.refunds) ? payload.refunds : []);
  } catch (error) {
    console.warn("[PAYMENT_METRICS] Failed to refresh ledger metrics:", error);
  }
}

function absorb(target: Map<string, LedgerAggregation>, rows: unknown[]): void {
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const key = `${cleanToken(row.provider, "unknown")}|${cleanToken(row.status, "unknown")}`;
    const entry = target.get(key) || { amount: 0, count: 0 };
    entry.amount += Number(row.amount) || 0;
    entry.count += Number(row.count) || 0;
    target.set(key, entry);
  }
}

/**
 * Records a payment lifecycle attempt, completion, or failure.
 *
 * @param provider Payment provider (e.g. stripe, vnpay, momo).
 * @param action Lifecycle step (e.g. checkout_session, payment_intent, paid, closed).
 * @param status Outcome status (e.g. success, failed, pending).
 * @param amountVnd Bounded transaction amount in VND.
 */
export function recordPaymentEvent(
  provider: string,
  action: string,
  status: string,
  amountVnd?: number
): void {
  const p = cleanToken(provider, "other");
  const a = cleanToken(action, "other");
  const s = cleanToken(status, "other");
  const key = `${p}|${a}|${s}`;
  paymentEvents.set(key, (paymentEvents.get(key) ?? 0) + 1);

  if (typeof amountVnd === "number" && Number.isFinite(amountVnd) && amountVnd > 0) {
    const amountKey = `${p}|${s}`;
    paymentAmounts.set(amountKey, (paymentAmounts.get(amountKey) ?? 0) + Math.round(amountVnd));
  }
}

/**
 * Records a refund operation attempt or completion.
 *
 * @param provider Payment provider (e.g. stripe, cod, vnpay).
 * @param status Outcome status (e.g. succeeded, requested, failed).
 * @param amountVnd Bounded refund amount in VND.
 */
export function recordRefundEvent(
  provider: string,
  status: string,
  amountVnd?: number
): void {
  const p = cleanToken(provider, "other");
  const s = cleanToken(status, "other");
  const key = `${p}|${s}`;
  refundEvents.set(key, (refundEvents.get(key) ?? 0) + 1);

  if (typeof amountVnd === "number" && Number.isFinite(amountVnd) && amountVnd > 0) {
    refundAmounts.set(key, (refundAmounts.get(key) ?? 0) + Math.round(amountVnd));
  }
}

/**
 * Records an incoming payment provider webhook delivery and parsing outcome.
 *
 * @param provider Payment provider sending the webhook (e.g. stripe).
 * @param eventType Provider event type (e.g. checkout.session.completed, charge.refunded).
 * @param result Processing outcome (e.g. processed, ignored, rejected, error).
 */
export function recordWebhookEvent(
  provider: string,
  eventType: string,
  result: "processed" | "ignored" | "rejected" | "error"
): void {
  const p = cleanToken(provider, "other");
  const e = cleanToken(eventType, "unknown");
  const r = cleanToken(result, "other");
  const key = `${p}|${e}|${r}`;
  webhookEvents.set(key, (webhookEvents.get(key) ?? 0) + 1);
}

/**
 * Records an automated payment reconciliation attempt outcome.
 *
 * @param provider Payment provider being reconciled (e.g. stripe).
 * @param result Outcome of the reconciliation (e.g. paid, still_pending, failed).
 */
export function recordReconcileEvent(
  provider: string,
  result: "paid" | "still_pending" | "failed" | "checked"
): void {
  const p = cleanToken(provider, "other");
  const r = cleanToken(result, "other");
  const key = `${p}|${r}`;
  reconcileEvents.set(key, (reconcileEvents.get(key) ?? 0) + 1);
}

/**
 * Renders process-local payment, refund, webhook, and reconciliation metrics in Prometheus format.
 */
export function renderPaymentMetrics(): string[] {
  const lines: string[] = [];

  // Ledger totals from database
  lines.push("# TYPE velura_payment_ledger_amount_vnd gauge");
  for (const [key, val] of [...ledgerPayments.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_payment_ledger_amount_vnd{provider="${provider}",status="${status}"} ${val.amount}`);
  }

  lines.push("# TYPE velura_payment_ledger_count gauge");
  for (const [key, val] of [...ledgerPayments.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_payment_ledger_count{provider="${provider}",status="${status}"} ${val.count}`);
  }

  lines.push("# TYPE velura_refund_ledger_amount_vnd gauge");
  for (const [key, val] of [...ledgerRefunds.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_refund_ledger_amount_vnd{provider="${provider}",status="${status}"} ${val.amount}`);
  }

  lines.push("# TYPE velura_refund_ledger_count gauge");
  for (const [key, val] of [...ledgerRefunds.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_refund_ledger_count{provider="${provider}",status="${status}"} ${val.count}`);
  }

  // Live event counters
  lines.push("# TYPE velura_payment_events_total counter");
  for (const [key, count] of [...paymentEvents.entries()].sort()) {
    const [provider, action, status] = key.split("|");
    lines.push(`velura_payment_events_total{provider="${provider}",action="${action}",status="${status}"} ${count}`);
  }

  lines.push("# TYPE velura_payment_amount_vnd_total counter");
  for (const [key, total] of [...paymentAmounts.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_payment_amount_vnd_total{provider="${provider}",status="${status}"} ${total}`);
  }

  lines.push("# TYPE velura_refund_events_total counter");
  for (const [key, count] of [...refundEvents.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_refund_events_total{provider="${provider}",status="${status}"} ${count}`);
  }

  lines.push("# TYPE velura_refund_amount_vnd_total counter");
  for (const [key, total] of [...refundAmounts.entries()].sort()) {
    const [provider, status] = key.split("|");
    lines.push(`velura_refund_amount_vnd_total{provider="${provider}",status="${status}"} ${total}`);
  }

  lines.push("# TYPE velura_payment_webhook_events_total counter");
  for (const [key, count] of [...webhookEvents.entries()].sort()) {
    const [provider, eventType, result] = key.split("|");
    lines.push(`velura_payment_webhook_events_total{provider="${provider}",event_type="${eventType}",result="${result}"} ${count}`);
  }

  lines.push("# TYPE velura_payment_reconcile_total counter");
  for (const [key, count] of [...reconcileEvents.entries()].sort()) {
    const [provider, result] = key.split("|");
    lines.push(`velura_payment_reconcile_total{provider="${provider}",result="${result}"} ${count}`);
  }

  return lines;
}

/**
 * Resets process-local payment metrics for testing isolation.
 */
export function resetPaymentMetricsForTest(): void {
  paymentEvents.clear();
  paymentAmounts.clear();
  refundEvents.clear();
  refundAmounts.clear();
  webhookEvents.clear();
  reconcileEvents.clear();
  ledgerPayments.clear();
  ledgerRefunds.clear();
  lastLedgerSync = 0;
}
