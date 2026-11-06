import test from "node:test";
import assert from "node:assert/strict";
import {
  recordPaymentEvent,
  recordRefundEvent,
  recordWebhookEvent,
  recordReconcileEvent,
  renderPaymentMetrics,
  resetPaymentMetricsForTest
} from "../../apps/api/src/payments/payment-metrics.js";
import { runtimeMetrics } from "../../apps/api/src/ops-runtime.js";

test("payment metrics render provider/action/status counters and amount in VND", () => {
  resetPaymentMetricsForTest();

  recordPaymentEvent("stripe", "create_session", "success", 250000);
  recordPaymentEvent("stripe", "paid", "success", 250000);
  recordPaymentEvent("vnpay", "open_attempt", "success", 500000);
  recordPaymentEvent("momo", "ipn_reconcile", "failed", 100000);

  const lines = renderPaymentMetrics();
  assert.ok(lines.includes("# TYPE velura_payment_events_total counter"));
  assert.ok(lines.includes("# TYPE velura_payment_amount_vnd_total counter"));

  assert.ok(lines.some((l) => l.includes('velura_payment_events_total{provider="stripe",action="create_session",status="success"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_events_total{provider="stripe",action="paid",status="success"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_events_total{provider="vnpay",action="open_attempt",status="success"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_events_total{provider="momo",action="ipn_reconcile",status="failed"} 1')));

  assert.ok(lines.some((l) => l.includes('velura_payment_amount_vnd_total{provider="stripe",status="success"} 500000')));
  assert.ok(lines.some((l) => l.includes('velura_payment_amount_vnd_total{provider="vnpay",status="success"} 500000')));
  assert.ok(lines.some((l) => l.includes('velura_payment_amount_vnd_total{provider="momo",status="failed"} 100000')));

  resetPaymentMetricsForTest();
});

test("refund metrics render provider/status and amount in VND", () => {
  resetPaymentMetricsForTest();

  recordRefundEvent("stripe", "succeeded", 150000);
  recordRefundEvent("stripe", "failed", 150000);
  recordRefundEvent("cod", "manual_approved", 300000);

  const lines = renderPaymentMetrics();
  assert.ok(lines.includes("# TYPE velura_refund_events_total counter"));
  assert.ok(lines.includes("# TYPE velura_refund_amount_vnd_total counter"));

  assert.ok(lines.some((l) => l.includes('velura_refund_events_total{provider="stripe",status="succeeded"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_refund_events_total{provider="stripe",status="failed"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_refund_events_total{provider="cod",status="manual_approved"} 1')));

  assert.ok(lines.some((l) => l.includes('velura_refund_amount_vnd_total{provider="stripe",status="succeeded"} 150000')));
  assert.ok(lines.some((l) => l.includes('velura_refund_amount_vnd_total{provider="stripe",status="failed"} 150000')));
  assert.ok(lines.some((l) => l.includes('velura_refund_amount_vnd_total{provider="cod",status="manual_approved"} 300000')));

  resetPaymentMetricsForTest();
});

test("webhook and reconcile metrics record provider events and outcomes", () => {
  resetPaymentMetricsForTest();

  recordWebhookEvent("stripe", "checkout.session.completed", "processed");
  recordWebhookEvent("stripe", "charge.refunded", "processed");
  recordWebhookEvent("stripe", "payment_intent.payment_failed", "ignored");
  recordWebhookEvent("stripe", "signature_check", "rejected");

  recordReconcileEvent("stripe", "checked");
  recordReconcileEvent("stripe", "paid");
  recordReconcileEvent("stripe", "still_pending");

  const lines = renderPaymentMetrics();
  assert.ok(lines.includes("# TYPE velura_payment_webhook_events_total counter"));
  assert.ok(lines.includes("# TYPE velura_payment_reconcile_total counter"));

  assert.ok(lines.some((l) => l.includes('velura_payment_webhook_events_total{provider="stripe",event_type="checkout.session.completed",result="processed"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_webhook_events_total{provider="stripe",event_type="charge.refunded",result="processed"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_webhook_events_total{provider="stripe",event_type="payment_intent.payment_failed",result="ignored"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_webhook_events_total{provider="stripe",event_type="signature_check",result="rejected"} 1')));

  assert.ok(lines.some((l) => l.includes('velura_payment_reconcile_total{provider="stripe",result="checked"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_reconcile_total{provider="stripe",result="paid"} 1')));
  assert.ok(lines.some((l) => l.includes('velura_payment_reconcile_total{provider="stripe",result="still_pending"} 1')));

  resetPaymentMetricsForTest();
});

test("runtimeMetrics includes payment metrics section", () => {
  resetPaymentMetricsForTest();
  recordPaymentEvent("stripe", "paid", "success", 99000);

  const rendered = runtimeMetrics();
  assert.ok(rendered.includes("# TYPE velura_payment_events_total counter"));
  assert.ok(rendered.includes('velura_payment_events_total{provider="stripe",action="paid",status="success"} 1'));
  assert.ok(rendered.includes('velura_payment_amount_vnd_total{provider="stripe",status="success"} 99000'));

  resetPaymentMetricsForTest();
});
