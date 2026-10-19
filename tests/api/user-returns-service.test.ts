import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { createUserReturnsService } from "../../apps/api/src/user/returns-service.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import { asJsonObject, type JsonObject, type UserProfile } from "../../apps/api/src/types.js";

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
    getRefundReceiver: async () => null,
    setRefundReceiver: async () => ({}),
    ...overrides
  };
}

test("a member can request a return within the 7-day window", async () => {
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

test("an exchange replacement order cannot start another return chain", async () => {
  const repository = fakeRepository({
    findReturnByExchangeOrderId: async () => ({ return_id: "ret-source", exchange_order_id: ORDER_ID })
  });

  await assert.rejects(
    () => createUserReturnsService(repository).createForMember(profile, {
      order_id: ORDER_ID,
      return_type: "exchange",
      reason_code: "size",
      evidence_images: ["https://example.com/evidence.png"],
      items: [{ order_item_id: ITEM_ID, quantity: 1 }]
    }),
    (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.code === "EXCHANGE_REPLACEMENT_NOT_RETURNABLE"
  );
});

test("a return request past the 7-day window is rejected (U2-01)", async () => {
  const repository = fakeRepository({
    findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", delivered_at: daysAgo(8) })
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

const CODE_ORDER = { order_id: ORDER_ID, user_id: USER_ID, order_code: "VL-COD", status: "delivered", payment_method: "COD", shipping_phone: "0912345678", delivered_at: daysAgo(2) };

test("the customer sees a CSKH-rejected request as rejected with its reason, never CSKH-internal notes", async () => {
  const repository = fakeRepository({
    findOrderById: async () => CODE_ORDER,
    listReturnsForUser: async () => [{
      return_id: "ret-1", order_id: ORDER_ID, user_id: USER_ID, return_type: "refund", status: "CANCELLED", cancelled_by: "admin",
      rejection_reason: "Hang tra ve khong dung mau", admin_note: "[CSKH] ghi chu noi bo", warehouse_proof: "https://proof.example/w.jpg",
      created_at: daysAgo(1)
    }]
  });
  const [row] = await createUserReturnsService(repository).listForMember(profile, null);
  assert.equal(row.status, "CANCELLED");
  assert.equal(row.cancelled_by, "admin");
  assert.equal(row.rejection_reason, "Hang tra ve khong dung mau");
  assert.equal("admin_note" in row, false);
  assert.equal("warehouse_proof" in row, false);
});

test("a customer cancellation is stored as the customer's own, including CSKH-contacting requests", async () => {
  let payload: JsonObject | null = null;
  const repository = fakeRepository({
    findReturnById: async () => ({ return_id: "ret-1", user_id: USER_ID, status: "CONTACTING", version: 2 }),
    updateReturn: async (_returnId, changes) => { payload = changes; return [{ return_id: "ret-1", ...changes }]; }
  });
  const result = await createUserReturnsService(repository).cancelForMember(profile, "ret-1", 2);
  assert.equal(result.status, "CANCELLED");
  assert.equal(payload?.cancelled_by, "customer");
  assert.equal(payload?.rejection_reason, "Đã hủy bởi khách hàng");
});

test("a request that already shipped can no longer be cancelled by the customer", async () => {
  const repository = fakeRepository({
    findReturnById: async () => ({ return_id: "ret-1", user_id: USER_ID, status: "RETURN_IN_TRANSIT", version: 2 })
  });
  await assert.rejects(() => createUserReturnsService(repository).cancelForMember(profile, "ret-1", 2), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test("COD refund requests expose the receiving account masked to its last four digits; Stripe requests expose none", async () => {
  const ret = { return_id: "ret-1", order_id: ORDER_ID, user_id: USER_ID, return_type: "refund", status: "RECEIVED", created_at: daysAgo(1) };
  const cod = createUserReturnsService(fakeRepository({
    findOrderById: async () => CODE_ORDER,
    listReturnsForUser: async () => [ret],
    getRefundReceiver: async () => ({ bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A", supplement_request: null })
  }));
  const [codRow] = await cod.listForMember(profile, null);
  const receiver = asJsonObject(codRow.refund_receiver);
  assert.equal(codRow.refund_flow, "cod_manual");
  assert.equal(receiver.status, "valid");
  assert.equal(receiver.account_last4, "6789");
  assert.equal(JSON.stringify(codRow).includes("0123456789"), false);

  const pending = createUserReturnsService(fakeRepository({
    findOrderById: async () => CODE_ORDER,
    listReturnsForUser: async () => [ret],
    getRefundReceiver: async () => ({ supplement_request: "Vui long gui lai so tai khoan", supplement_requested_at: "2026-10-19T01:00:00.000Z" })
  }));
  const pendingReceiver = asJsonObject((await pending.listForMember(profile, null))[0].refund_receiver);
  assert.equal(pendingReceiver.status, "supplement_requested");
  assert.equal(pendingReceiver.supplement_request, "Vui long gui lai so tai khoan");

  const stripe = createUserReturnsService(fakeRepository({
    findOrderById: async () => ({ ...CODE_ORDER, payment_method: "ONLINE_PAYMENT" }),
    listReturnsForUser: async () => [ret]
  }));
  const [stripeRow] = await stripe.listForMember(profile, null);
  assert.equal(stripeRow.refund_receiver, null);
  assert.notEqual(stripeRow.refund_flow, "cod_manual");
});

test("a member saves the COD receiving account for their own request only, with field-level validation", async () => {
  let saved: { returnId: string; owner: string | null; bank: string; account: string; holder: string } | null = null;
  const repository = fakeRepository({
    findReturnById: async (id) => (id === "ret-1" ? { return_id: "ret-1", order_id: ORDER_ID, user_id: USER_ID } : { return_id: "ret-x", user_id: "someone-else" }),
    setRefundReceiver: async (returnId, owner, input) => {
      saved = { returnId, owner, bank: input.bankName, account: input.accountNumber, holder: input.accountHolder };
      return { status: "valid", account_last4: input.accountNumber.slice(-4) };
    }
  });
  const service = createUserReturnsService(repository);
  const result = await service.saveRefundReceiverForMember(profile, { return_id: "ret-1", bank_name: " Vietcombank ", account_number: "0123 456-789", account_holder: "Nguyen   Van A" });
  assert.equal(result.success, true);
  assert.deepEqual(saved, { returnId: "ret-1", owner: USER_ID, bank: "Vietcombank", account: "0123456789", holder: "Nguyen Van A" });

  saved = null;
  for (const bad of [
    { bank_name: "", account_number: "0123456789", account_holder: "Nguyen Van A" },
    { bank_name: "Vietcombank", account_number: "12ab", account_holder: "Nguyen Van A" },
    { bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van 9" }
  ]) {
    await assert.rejects(() => service.saveRefundReceiverForMember(profile, { return_id: "ret-1", ...bad }), (error: unknown) => error instanceof HttpError && error.status === 422 && error.code === "REFUND_RECEIVER_INVALID");
  }
  await assert.rejects(() => service.saveRefundReceiverForMember(profile, { return_id: "ret-x", bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A" }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(saved, null, "invalid or foreign requests never reach the database");
});

test("a guest can save the receiving account only with a session that authorizes the order", async () => {
  const repository = fakeRepository({
    findReturnById: async () => ({ return_id: "ret-1", order_id: ORDER_ID, user_id: null }),
    findOrderById: async () => CODE_ORDER,
    setRefundReceiver: async () => { throw new Error("must not be reached"); }
  });
  await assert.rejects(
    () => createUserReturnsService(repository).saveRefundReceiverForGuest({ return_id: "ret-1", guest_access_token: "forged", bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A" }),
    (error: unknown) => error instanceof HttpError && error.status === 404
  );
});
