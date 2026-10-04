import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { createUserReturnsService } from "../../apps/api/src/user/returns-service.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import type { JsonObject, UserProfile } from "../../apps/api/src/types.js";

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const ITEM_ID = "70000000-0000-4000-8000-000000000002";
const USER_ID = "70000000-0000-4000-8000-000000000003";

const profile = { user_id: USER_ID } as UserProfile;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function fakeRepository(overrides: Partial<UserReturnsRepository> = {}): UserReturnsRepository {
  return {
    findOrderByCode: async () => null,
    findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", delivered_at: daysAgo(5) }),
    findOrderItem: async () => ({ item_id: ITEM_ID, order_id: ORDER_ID, variant_id: "v1", quantity: 2 }),
    findVariant: async () => null,
    findProduct: async () => null,
    findCategory: async () => null,
    listReturnsForOrder: async () => [],
    listReturnItemsForOrderItem: async () => [],
    listReturnItemsForReturn: async () => [],
    insertReturn: async (payload) => ({ return_id: "ret-1", ...payload }) as JsonObject,
    insertReturnItem: async (payload) => payload as JsonObject,
    findReturnById: async () => null,
    updateReturn: async () => [],
    listReturnsForUser: async () => [],
    ...overrides
  };
}

test("a member can request a return within the 30-day window", async () => {
  const repository = fakeRepository();
  const service = createUserReturnsService(repository);

  const result = await service.createForMember(profile, {
    order_id: ORDER_ID,
    return_type: "refund",reason_code:"size",evidence_images:["https://example.com/evidence.png"],
    items: [{ order_item_id: ITEM_ID, quantity: 1 }]
  });

  assert.equal(result.return_id, "ret-1");
  assert.equal((result.items as JsonObject[]).length, 1);
});

test("a return request past the 30-day window is rejected (U2-01)", async () => {
  const repository = fakeRepository({
    findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", delivered_at: daysAgo(31) })
  });
  const service = createUserReturnsService(repository);

  await assert.rejects(
    () =>
      service.createForMember(profile, {
        order_id: ORDER_ID,
        return_type: "refund",reason_code:"size",evidence_images:["https://example.com/evidence.png"],
        items: [{ order_item_id: ITEM_ID, quantity: 1 }]
      }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "RETURN_WINDOW_CLOSED"
  );
});

test("an in-progress return request on the same order_item is blocked (ITEM_RETURN_IN_PROGRESS)", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [
      { return_id: "ret-a", status: "REQUESTED", tracking_return_code: "RET12345678" }
    ],
    listReturnItemsForOrderItem: async () => [{ order_item_id: ITEM_ID, quantity: 1 }]
  });
  const service = createUserReturnsService(repository);

  await assert.rejects(
    () =>
      service.createForMember(profile, {
        order_id: ORDER_ID,
        return_type: "refund", reason_code: "size", evidence_images: ["https://example.com/evidence.png"],
        items: [{ order_item_id: ITEM_ID, quantity: 1 }]
      }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "ITEM_RETURN_IN_PROGRESS"
  );
});

test("a third return request on the same order_item is rejected (U2-02)", async () => {
  // Hai yêu cầu đã hoàn tất (không `rejected`) đã dùng hết 2 lượt của item này.
  const repository = fakeRepository({
    listReturnsForOrder: async () => [
      { return_id: "ret-a", status: "COMPLETED" },
      { return_id: "ret-b", status: "COMPLETED" }
    ],
    listReturnItemsForOrderItem: async (returnId) =>
      returnId === "ret-a" || returnId === "ret-b" ? [{ order_item_id: ITEM_ID, quantity: 1 }] : []
  });
  const service = createUserReturnsService(repository);

  await assert.rejects(
    () =>
      service.createForMember(profile, {
        order_id: ORDER_ID,
        return_type: "refund",reason_code:"size",evidence_images:["https://example.com/evidence.png"],
        items: [{ order_item_id: ITEM_ID, quantity: 1 }]
      }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "RETURN_LIMIT_REACHED"
  );
});

test("a rejected prior return does not count against the U2-02 limit", async () => {
  const repository = fakeRepository({
    listReturnsForOrder: async () => [
      { return_id: "ret-a", status: "CANCELLED" },
      { return_id: "ret-b", status: "COMPLETED" }
    ],
    listReturnItemsForOrderItem: async (returnId) => (returnId === "ret-b" ? [{ order_item_id: ITEM_ID, quantity: 1 }] : [])
  });
  const service = createUserReturnsService(repository);

  const result = await service.createForMember(profile, {
    order_id: ORDER_ID,
    return_type: "refund",reason_code:"size",evidence_images:["https://example.com/evidence.png"],
    items: [{ order_item_id: ITEM_ID, quantity: 1 }]
  });

  assert.equal(result.return_id, "ret-1");
});

test("a member cancels an unshipped return with the current version", async () => {
  let mutationVersion: number | undefined;
  const repository = fakeRepository({
    findReturnById: async () => ({
      return_id: "ret-1",
      user_id: USER_ID,
      status: "REQUESTED",
      version: 3
    }),
    updateReturn: async (_returnId, payload, expectedVersion) => {
      mutationVersion = expectedVersion;
      return [{ return_id: "ret-1", ...payload }];
    }
  });

  const result = await createUserReturnsService(repository).cancelForMember(profile, "ret-1", 3);

  assert.equal(mutationVersion, 3);
  assert.equal(result.version, 4);
  assert.equal(result.status, "CANCELLED");
});

test("return cancellation requires expectedVersion", async () => {
  const repository = fakeRepository();

  await assert.rejects(
    () => createUserReturnsService(repository).cancelForMember(profile, "ret-1", undefined),
    (error: unknown) =>
      error instanceof HttpError && error.status === 422 && error.code === "EXPECTED_VERSION_REQUIRED"
  );
});

test("a stale return version is rejected before mutation", async () => {
  let mutated = false;
  const repository = fakeRepository({
    findReturnById: async () => ({
      return_id: "ret-1",
      user_id: USER_ID,
      status: "REQUESTED",
      version: 4
    }),
    updateReturn: async () => {
      mutated = true;
      return [];
    }
  });

  await assert.rejects(
    () => createUserReturnsService(repository).cancelForMember(profile, "ret-1", 3),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "VERSION_CONFLICT"
  );
  assert.equal(mutated, false);
});
