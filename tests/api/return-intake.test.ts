import test from "node:test";
import assert from "node:assert/strict";
import { presentOrderForCustomer } from "../../apps/api/src/user/order-router.js";

test("customer order eligibility never falls back to updated_at, creation or history", () => {
  const now = new Date().toISOString();
  const base = { order_id: "order", status: "delivered", created_at: now, updated_at: now, payment_method: "COD" };
  const history = [{ status: "delivered", changed_at: now }];
  assert.equal(presentOrderForCustomer(base, [], history).can_request_return, false);
  assert.equal(presentOrderForCustomer({ ...base, delivered_at: "invalid" }, [], history).can_request_return, false);
  assert.equal(presentOrderForCustomer({ ...base, delivered_at: new Date(Date.now() + 60000).toISOString() }, [], history).can_request_return, false);
  assert.equal(presentOrderForCustomer({ ...base, delivered_at: now }, [], history).can_request_return, true);
  assert.equal(presentOrderForCustomer({ ...base, delivered_at: new Date(Date.now() - 8 * 86400000).toISOString() }, [], history).can_request_return, false);
});
