import test from "node:test";
import assert from "node:assert/strict";
import { buildReturnQrPayload, formatReturnPickupSlot, sendReturnIntakeEmail, sendReturnApprovedEmail } from "../../apps/api/src/returns/return-email.js";
import { notifyOrderDelivered } from "../../apps/api/src/orders/order-notifications.js";

test("sendReturnIntakeEmail handles missing return gracefully without throwing", async () => {
  const result = await sendReturnIntakeEmail("00000000-0000-0000-0000-000000000000");
  assert.equal(result, false);
});

test("sendReturnApprovedEmail handles missing return/item gracefully without throwing", async () => {
  const result = await sendReturnApprovedEmail("00000000-0000-0000-0000-000000000000", "item-123");
  assert.equal(result, false);
});

test("notifyOrderDelivered handles missing order gracefully without throwing", async () => {
  const result = await notifyOrderDelivered("00000000-0000-0000-0000-000000000000");
  assert.equal(result, false);
});

test("buildReturnQrPayload emits the same velura:return:1 payload the ERP scanner reads", () => {
  assert.equal(buildReturnQrPayload("ret-1", "RMA-9"), "velura:return:1?id=ret-1&code=RMA-9");
  assert.equal(buildReturnQrPayload("ret-1", ""), "velura:return:1?id=ret-1");
});

test("formatReturnPickupSlot renders the stored slot in Vietnam time and hides missing slots", () => {
  assert.equal(formatReturnPickupSlot("2026-11-18T02:00:00.000Z"), "09:00 ngày 18/11/2026");
  assert.equal(formatReturnPickupSlot(null), null);
  assert.equal(formatReturnPickupSlot("not-a-date"), null);
});
