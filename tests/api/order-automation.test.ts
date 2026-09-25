import test from "node:test";
import assert from "node:assert/strict";
import { orderAutomationMode, startOrderAutomation } from "../../apps/api/src/orders/order-automation.js";

test("worker is off unless ORDER_AUTOMATION_MODE says dry_run or on", () => {
  assert.equal(orderAutomationMode(undefined), "off");
  assert.equal(orderAutomationMode("true"), "off");
  assert.equal(orderAutomationMode("dry_run"), "dry_run");
  assert.equal(orderAutomationMode("on"), "on");
});

test("off mode never starts a timer", () => {
  assert.equal(startOrderAutomation("off"), null);
});
