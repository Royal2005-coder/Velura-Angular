import test from "node:test";
import assert from "node:assert/strict";
import { orderAutomationMode, startOrderAutomation } from "../../apps/api/src/orders/order-automation.js";

test("unknown ORDER_AUTOMATION_MODE values fail safe to off", () => {
  assert.equal(orderAutomationMode("true"), "off");
  assert.equal(orderAutomationMode("dry_run"), "dry_run");
  assert.equal(orderAutomationMode("on"), "on");
});

test("off mode never starts a timer", () => {
  assert.equal(startOrderAutomation("off"), null);
});

import { isAutoConfirmDue, isPaymentExpiryDue, automationTouchedCount, type AutomationOrderFacts } from "../../apps/api/src/orders/order-automation.js";

const NOW = new Date("2026-11-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
function order(overrides: Partial<AutomationOrderFacts> = {}): AutomationOrderFacts {
  return { status: "pending", paymentMethod: "COD", totalAmount: 500_000, createdAt: hoursAgo(25), isPaid: false, customerRequestsCancel: false, ...overrides };
}

test("worker defaults to on when unset or blank, off only when explicit", () => {
  assert.equal(orderAutomationMode(""), "on");
  assert.equal(orderAutomationMode("off"), "off");
  assert.equal(orderAutomationMode(" ON "), "on");
});

test("AD_ORDER_03: COD under 1M auto-confirms only after 24h", () => {
  assert.equal(isAutoConfirmDue(order(), NOW), true);
  assert.equal(isAutoConfirmDue(order({ createdAt: hoursAgo(23) }), NOW), false);
  assert.equal(isAutoConfirmDue(order({ createdAt: hoursAgo(24) }), NOW), true);
});

test("AD_ORDER_03: never auto-confirm at or above 1M, online, non-pending or cancel-requested orders", () => {
  assert.equal(isAutoConfirmDue(order({ totalAmount: 1_000_000 }), NOW), false);
  assert.equal(isAutoConfirmDue(order({ totalAmount: 5_000_000 }), NOW), false);
  assert.equal(isAutoConfirmDue(order({ paymentMethod: "ONLINE_PAYMENT" }), NOW), false);
  assert.equal(isAutoConfirmDue(order({ status: "confirmed" }), NOW), false);
  assert.equal(isAutoConfirmDue(order({ customerRequestsCancel: true }), NOW), false);
});

test("AD_ORDER_08: unpaid online order expires after 24h, paid or COD never", () => {
  const online = order({ status: "waiting_payment", paymentMethod: "ONLINE_PAYMENT" });
  assert.equal(isPaymentExpiryDue(online, NOW), true);
  assert.equal(isPaymentExpiryDue({ ...online, createdAt: hoursAgo(2) }, NOW), false);
  assert.equal(isPaymentExpiryDue({ ...online, isPaid: true }, NOW), false);
  assert.equal(isPaymentExpiryDue(order(), NOW), false);
});

test("automationTouchedCount reads dry_run and live result shapes", () => {
  assert.equal(automationTouchedCount("dry_run", { auto_confirm_due: 2, payment_expired_due: 3 }), 5);
  assert.equal(automationTouchedCount("on", { auto_confirmed: 1, payment_expired: 2, failed: 0 }), 3);
  assert.equal(automationTouchedCount("on", { auto_confirmed: 0, payment_expired: 0, failed: 0 }), 0);
});
