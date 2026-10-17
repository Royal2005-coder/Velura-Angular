import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { cancelOrderForCustomer, type CustomerOrderCancelRepository } from "../../apps/api/src/user/order-cancel-service.js";

const ORDER_ID = "60000000-0000-4000-8000-000000000001";
const USER_ID = "60000000-0000-4000-8000-000000000002";

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    user_id: USER_ID,
    status: "pending",
    handed_over_at: null,
    version: 3,
    order_code: "VLR00000001",
    ...overrides
  };
}

test("a pending order cancels with the correct version", async () => {
  let cancelCalls = 0;
  const repository: CustomerOrderCancelRepository = {
    findOrder: async () => baseOrder(),
    cancel: async (orderId, input) => {
      cancelCalls++;
      assert.equal(orderId, ORDER_ID);
      assert.equal(input.expectedVersion, 3);
      return { order: baseOrder({ status: "cancelled", version: 4 }), refund_required: false };
    }
  };

  const result = await cancelOrderForCustomer(repository, {
    orderId: ORDER_ID,
    userId: USER_ID,
    reason: "Đổi ý",
    expectedVersion: 3
  });

  assert.equal(cancelCalls, 1);
  assert.equal(result.order.status, "cancelled");
  assert.equal(result.refundRequired, false);
});

test("an order already in processing cannot be self-cancelled, and the repository is never asked to mutate", async () => {
  let cancelCalls = 0;
  const repository: CustomerOrderCancelRepository = {
    findOrder: async () => baseOrder({ status: "processing" }),
    cancel: async () => {
      cancelCalls++;
      return {};
    }
  };

  await assert.rejects(
    () =>
      cancelOrderForCustomer(repository, {
        orderId: ORDER_ID,
        userId: USER_ID,
        reason: "Đổi ý",
        expectedVersion: 3
      }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "INVALID_ORDER_ACTION"
  );
  assert.equal(cancelCalls, 0);
});

test("a missing expectedVersion is rejected before the repository is touched", async () => {
  let findOrderCalls = 0;
  const repository: CustomerOrderCancelRepository = {
    findOrder: async () => {
      findOrderCalls++;
      return baseOrder();
    },
    cancel: async () => ({})
  };

  await assert.rejects(
    () =>
      cancelOrderForCustomer(repository, {
        orderId: ORDER_ID,
        userId: USER_ID,
        reason: "Đổi ý",
        expectedVersion: undefined
      }),
    (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === "EXPECTED_VERSION_REQUIRED"
  );
  assert.equal(findOrderCalls, 0);
});

test("a stale expectedVersion surfaces as a 409 the customer can act on", async () => {
  const repository: CustomerOrderCancelRepository = {
    findOrder: async () => baseOrder(),
    cancel: async () => {
      // Hình dạng lỗi thật mà `callRpc` ném khi RPC raise `sqlstate 'PT409'` cho
      // VERSION_CONFLICT (migration 038): status 409, code chung "SUPABASE_ERROR",
      // mã lỗi thật nằm trong `details.message`.
      throw new HttpError(409, "SUPABASE_ERROR", "VERSION_CONFLICT [status:409]", { message: "VERSION_CONFLICT" });
    }
  };

  await assert.rejects(
    () =>
      cancelOrderForCustomer(repository, {
        orderId: ORDER_ID,
        userId: USER_ID,
        reason: "Đổi ý",
        expectedVersion: 1
      }),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "VERSION_CONFLICT"
  );
});
