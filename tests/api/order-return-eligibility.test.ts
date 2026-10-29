import test from "node:test";
import assert from "node:assert/strict";
import { attachReturnEligibility } from "../../apps/api/src/user/order-router.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import type { JsonObject } from "../../apps/api/src/types.js";

const ITEM_ID = "80000000-0000-4000-8000-000000000002";

function repository(units: JsonObject[]): UserReturnsRepository {
  return { listReturnUnits: async () => units } as UserReturnsRepository;
}

test("a never-requested line keeps all purchased units available", async () => {
  const [line] = await attachReturnEligibility(repository([]), "order", [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(line.available_quantity, 3);
  assert.equal(line.return_count, 0);
});

test("an active part reserves only its quantity, not disjoint units", async () => {
  const [line] = await attachReturnEligibility(repository([
    { success_count: 0, refunded: false, active_return_item_id: "part-a" },
    { success_count: 0, refunded: false, active_return_item_id: null },
    { success_count: 1, refunded: false, active_return_item_id: null }
  ]), "order", [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(line.available_quantity, 2);
  assert.equal(line.held_quantity, 1);
  assert.equal(line.is_in_progress, true);
});

test("one exchange leaves a second attempt, a refund retires its unit, and two successes exhaust only that unit", async () => {
  const [line] = await attachReturnEligibility(repository([
    { success_count: 1, refunded: false, active_return_item_id: null },
    { success_count: 1, refunded: true, active_return_item_id: null },
    { success_count: 2, refunded: false, active_return_item_id: null }
  ]), "order", [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(line.available_quantity, 1);
  assert.equal(line.refunded_quantity, 1);
  assert.equal(line.return_count, 2);
  assert.equal(line.is_in_progress, false);
});

test("rejected or stopped parts release the unit without consuming a success", async () => {
  const [line] = await attachReturnEligibility(repository([
    { success_count: 0, refunded: false, active_return_item_id: null }
  ]), "order", [{ item_id: ITEM_ID, quantity: 1 }]);
  assert.equal(line.available_quantity, 1);
  assert.equal(line.return_count, 0);
});
