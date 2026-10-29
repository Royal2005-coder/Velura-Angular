import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { createUserReturnsService } from "../../apps/api/src/user/returns-service.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import { asJsonObject, type JsonObject, type UserProfile } from "../../apps/api/src/types.js";
import { issueGuestOrderAccess } from "../../apps/api/src/user/order-access.js";

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const ITEM_ID = "70000000-0000-4000-8000-000000000002";
const USER_ID = "70000000-0000-4000-8000-000000000003";

const profile = { user_id: USER_ID } as UserProfile;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function fakeRepository(overrides: Partial<UserReturnsRepository> = {}): UserReturnsRepository {
  return {
    createReturnBundle: async (payload, items) => ({ return_id: "ret-1", ...payload, items }),
    listReturnUnits: async () => [],
    findOrderByCode: async () => null,
    findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", delivered_at: daysAgo(5) }),
    findOrderItem: async () => ({ item_id: ITEM_ID, order_id: ORDER_ID, variant_id: "v1", quantity: 2 }),
    findVariant: async () => null,
    findProduct: async () => null,
    findCategory: async () => null,
    listReturnsForOrder: async () => [],
    listReturnItemsForReturn: async () => [{ return_item_id: "part-1", order_item_id: ITEM_ID, quantity: 1, item_status: "REQUESTED", decision_status: "pending", resolution_type: "refund" }],
    findReturnById: async () => null,
    cancelReturn: async (returnId, expectedVersion) => ({ return_id: returnId, status: "CANCELLED", version: expectedVersion + 1 } as JsonObject),
    updateReturn: async () => [],
    listReturnsForUser: async () => [],
    getRefundReceiver: async () => null,
    setRefundReceiver: async () => ({}),
    ...overrides
  };
}

const PROOF = {
  evidence_images: ["storage://return-evidence-private/return-intake/order/request_photo/photo.jpg"],
  evidence_videos: ["storage://return-evidence-private/return-intake/order/request_video/video.mp4"]
};
const intake = { order_id: ORDER_ID, return_type: "refund", reason_code: "size", ...PROOF, items: [{ order_item_id: ITEM_ID, quantity: 1 }] };

test("member intake requires reason, image and initial video and uses only the atomic RPC", async () => {
  let saved: JsonObject | undefined;
  const repository = fakeRepository({
    createReturnBundle: async (payload, items) => { saved = { ...payload, items }; return { return_id: "ret-1", ...payload }; }
  });
  const service = createUserReturnsService(repository);
  const result = await service.createForMember(profile, intake);
  assert.equal(result.return_id, "ret-1");
  assert.equal((result.items as JsonObject[])[0].return_item_id, "part-1");
  assert.deepEqual(saved?.evidence_videos, PROOF.evidence_videos);
  for (const changes of [
    { reason_code: "", description: "" }, { evidence_images: [] }, { evidence_videos: [] },
    { evidence_images: ["https://attacker.test/image.jpg"] }, { evidence_videos: ["data:video/mp4;base64,aaa"] }
  ]) {
    await assert.rejects(() => service.createForMember(profile, { ...intake, ...changes }), (error: unknown) => error instanceof HttpError && error.status === 422);
  }
});

test("missing, invalid, future and older-than-seven-day delivered_at fail closed without updated_at fallback", async () => {
  for (const delivered of [null, "invalid", daysAgo(-1), daysAgo(8)]) {
    const repository = fakeRepository({ findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", delivered_at: delivered, updated_at: daysAgo(0) }) });
    await assert.rejects(() => createUserReturnsService(repository).createForMember(profile, intake),
      (error: unknown) => error instanceof HttpError && error.code === "RETURN_WINDOW_CLOSED");
  }
});

test("an exchange replacement order cannot reset original-unit lineage", async () => {
  const repository = fakeRepository({ findReturnByExchangeOrderId: async () => ({ return_id: "source" }) });
  await assert.rejects(() => createUserReturnsService(repository).createForMember(profile, intake),
    (error: unknown) => error instanceof HttpError && error.code === "EXCHANGE_REPLACEMENT_NOT_RETURNABLE");
});

test("disjoint free quantity remains requestable while one part is active", async () => {
  const repository = fakeRepository({ listReturnUnits: async () => [
    { success_count: 0, refunded: false, active_return_item_id: "part-held" },
    { success_count: 1, refunded: false, active_return_item_id: null }
  ] });
  assert.equal((await createUserReturnsService(repository).createForMember(profile, intake)).return_id, "ret-1");
  await assert.rejects(() => createUserReturnsService(repository).createForMember(profile, { ...intake, items: [{ order_item_id: ITEM_ID, quantity: 2 }] }),
    (error: unknown) => error instanceof HttpError && error.code === "RETURN_QUANTITY_EXCEEDED");
});

test("refunded and twice-exchanged units are unavailable, failed parts consume no success", async () => {
  const repository = fakeRepository({ listReturnUnits: async () => [
    { success_count: 1, refunded: true, active_return_item_id: null },
    { success_count: 2, refunded: false, active_return_item_id: null }
  ] });
  await assert.rejects(() => createUserReturnsService(repository).createForMember(profile, intake),
    (error: unknown) => error instanceof HttpError && error.code === "RETURN_QUANTITY_EXCEEDED");
});

test("replacement identity is preserved and COD account can wait until refund", async () => {
  let payload: JsonObject | undefined;
  let parts: JsonObject[] = [];
  const repository = fakeRepository({
    findOrderById: async () => ({ order_id: ORDER_ID, user_id: USER_ID, status: "delivered", payment_method: "COD", delivered_at: daysAgo(1) }),
    findVariant: async () => ({ product_id: "same-product" }),
    createReturnBundle: async (value, items) => { payload = value; parts = items; return { return_id: "ret-1", ...value }; }
  });
  await createUserReturnsService(repository).createForMember(profile, { ...intake, return_type: "exchange", items: [{ order_item_id: ITEM_ID, quantity: 1, replacement_variant_id: "replacement" }] });
  assert.equal(parts[0].replacement_variant_id, "replacement");
  assert.equal(payload?.return_type, "exchange");
  assert.equal(payload?.refund_bank_account, undefined);
  await createUserReturnsService(repository).createForMember(profile, { ...intake, refund_bank_name: "VCB", refund_bank_account: "0123456789", refund_bank_holder: "Nguyen Van A" });
  assert.equal(payload?.refund_bank_account, "0123456789");
});

test("verified guests preserve replacement variant and use the exact atomic member intake", async () => {
  const writes: JsonObject[] = [];
  const repository = fakeRepository({
    findOrderByCode: async () => ({ order_id: ORDER_ID, user_id: null, status: "delivered", delivered_at: daysAgo(1), payment_method: "COD" }),
    findVariant: async () => ({ product_id: "product" }),
    createReturnBundle: async (payload, items) => { writes.push({ ...payload, items }); return { return_id: "guest-return", ...payload }; }
  });
  const service = createUserReturnsService(repository);
  const body = { ...intake, order_code: "GUEST-1", return_type: "exchange", guest_access_token: issueGuestOrderAccess(ORDER_ID),
    items: [{ order_item_id: ITEM_ID, quantity: 1, replacement_variant_id: "replacement" }] };
  const result = await service.createForGuest(body);
  assert.equal(result.return_id, "guest-return");
  assert.equal(writes.length, 1);
  assert.equal((writes[0].items as JsonObject[])[0].replacement_variant_id, "replacement");
  assert.deepEqual(writes[0].evidence_videos, PROOF.evidence_videos);
  await assert.rejects(() => service.createForGuest({ ...body, guest_access_token: "forged" }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(writes.length, 1);
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
    cancelReturn: async (_returnId, expectedVersion) => {
      mutationVersion = expectedVersion;
      return { return_id: "ret-1", status: "CANCELLED", version: expectedVersion + 1 };
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
    cancelReturn: async () => {
      mutated = true;
      return {};
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
  let calledWith: unknown;
  const repository = fakeRepository({
    findReturnById: async () => ({ return_id: "ret-1", user_id: USER_ID, status: "CONTACTING", version: 2 }),
    cancelReturn: async (id, version, owner) => {
      calledWith = { id, version, owner };
      return { return_id: "ret-1", status: "CANCELLED", cancelled_by: "customer", rejection_reason: "Đã hủy bởi khách hàng" };
    }
  });
  const result = await createUserReturnsService(repository).cancelForMember(profile, "ret-1", 2);
  assert.equal(result.status, "CANCELLED");
  assert.deepEqual(calledWith, { id: "ret-1", version: 2, owner: USER_ID });
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
