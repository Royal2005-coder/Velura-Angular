import test from "node:test";
import assert from "node:assert/strict";
import { attachReturnEligibility } from "../../apps/api/src/user/order-router.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";

const ORDER_ID = "80000000-0000-4000-8000-000000000001";
const ITEM_ID = "80000000-0000-4000-8000-000000000002";

function fakeRepository(overrides: Partial<UserReturnsRepository> = {}): UserReturnsRepository {
  return {
    findOrderByCode: async () => null,
    findOrderById: async () => null,
    findOrderItem: async () => null,
    findVariant: async () => null,
    findProduct: async () => null,
    findCategory: async () => null,
    listReturnsForOrder: async () => [],
    listReturnItemsForOrderItem: async () => [],
    listReturnItemsForReturn: async () => [],
    insertReturn: async (payload) => payload,
    insertReturnItem: async (payload) => payload,
    findReturnById: async () => null,
    updateReturn: async () => [],
    listReturnsForUser: async () => [],
    ...overrides
  };
}

test("an item with no prior return keeps its full quantity available", async () => {
  const repository = fakeRepository();
  const [item] = await attachReturnEligibility(repository, ORDER_ID, [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(item.return_count, 0);
  assert.equal(item.available_quantity, 3);
});

test("an active in-progress return locks the item (available_quantity=0, is_in_progress=true)", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [{ return_id: "ret-1", status: "pending" }],
    listReturnItemsForOrderItem: async (returnId, orderItemId) =>
      returnId === "ret-1" && orderItemId === ITEM_ID ? [{ order_item_id: ITEM_ID, quantity: 1 }] : []
  });
  const [item] = await attachReturnEligibility(repository, ORDER_ID, [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(item.return_count, 1);
  assert.equal(item.is_in_progress, true);
  assert.equal(item.available_quantity, 0);
});

test("a completed return reduces available_quantity for the second attempt", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [{ return_id: "ret-1", status: "COMPLETED" }],
    listReturnItemsForOrderItem: async (returnId, orderItemId) =>
      returnId === "ret-1" && orderItemId === ITEM_ID ? [{ order_item_id: ITEM_ID, quantity: 1 }] : []
  });
  const [item] = await attachReturnEligibility(repository, ORDER_ID, [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(item.return_count, 1);
  assert.equal(item.is_in_progress, false);
  assert.equal(item.available_quantity, 2);
});

test("a rejected return does not consume an attempt or the quantity", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [{ return_id: "ret-1", status: "rejected" }],
    listReturnItemsForOrderItem: async () => [{ order_item_id: ITEM_ID, quantity: 1 }]
  });
  const [item] = await attachReturnEligibility(repository, ORDER_ID, [{ item_id: ITEM_ID, quantity: 3 }]);
  assert.equal(item.return_count, 0);
  assert.equal(item.available_quantity, 3);
});

test("two returns reach the U2-02 cap and leave the item unavailable", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [
      { return_id: "ret-1", status: "COMPLETED" },
      { return_id: "ret-2", status: "COMPLETED" }
    ],
    listReturnItemsForOrderItem: async (returnId) =>
      returnId === "ret-1" || returnId === "ret-2" ? [{ order_item_id: ITEM_ID, quantity: 1 }] : []
  });
  const [item] = await attachReturnEligibility(repository, ORDER_ID, [{ item_id: ITEM_ID, quantity: 2 }]);
  assert.equal(item.return_count, 2);
  assert.equal(item.available_quantity, 0);
});
