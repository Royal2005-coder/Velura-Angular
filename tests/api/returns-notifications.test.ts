import test from "node:test";
import assert from "node:assert/strict";
import { sendReturnIntakeEmail, sendReturnApprovedEmail } from "../../apps/api/src/returns/return-email.js";
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
