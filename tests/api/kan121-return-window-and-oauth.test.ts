import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUtcDateOrNull,
  returnWindowDeadline,
  returnWindowOpen,
  toUtcIsoString
} from "../../apps/api/src/user/return-window.js";
import { validatedOAuthRedirect } from "../../apps/api/src/user/oauth-redirect.js";
import {
  attachReturnEligibility,
  failClosedReturnItems,
  presentOrderForCustomer
} from "../../apps/api/src/user/order-router.js";
import { createUserReturnsService } from "../../apps/api/src/user/returns-service.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import { HttpError } from "../../apps/api/src/http.js";
import type { JsonObject, UserProfile } from "../../apps/api/src/types.js";

function toNaivePostgresUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

test("parseUtcDateOrNull, toUtcIsoString, and returnWindowOpen fail closed and handle naive Postgres UTC timestamps", () => {
  for (const invalid of [null, undefined, "", "   ", "invalid", 123, {}]) {
    assert.equal(parseUtcDateOrNull(invalid), null);
    assert.equal(toUtcIsoString(invalid), null);
  }
  assert.equal(returnWindowOpen(null, new Date()), false);
  assert.equal(returnWindowDeadline(null), null);

  const expectedIso = "2026-11-25T15:44:28.318Z";
  assert.equal(toUtcIsoString("2026-11-25T15:44:28.318743"), expectedIso);
  assert.equal(toUtcIsoString("  2026-11-25 15:44:28.318743 "), expectedIso);
  assert.equal(toUtcIsoString("2026-11-25T15:44:28.318z"), expectedIso);
  assert.equal(toUtcIsoString("2026-11-25T22:44:28.318+0700"), expectedIso);
  assert.equal(toUtcIsoString("2026-11-25T15:44:28.318+00"), expectedIso);

  const delivered = parseUtcDateOrNull("2026-11-25T15:44:28.318743");
  assert.ok(delivered);
  assert.equal(returnWindowOpen(delivered, new Date("2026-11-25T15:44:28.318Z")), true);
  assert.equal(returnWindowOpen(delivered, new Date("2026-12-02T15:44:28.318Z")), true);
  assert.equal(returnWindowOpen(delivered, new Date("2026-12-02T15:44:28.319Z")), false);
  assert.equal(returnWindowOpen(delivered, new Date("2026-11-25T15:44:28.317Z")), false);
});

test("validatedOAuthRedirect rejects query strings, hashes, credentials, and unknown origins", () => {
  assert.equal(validatedOAuthRedirect("https://velura.royalai.dev/auth/callback"), "https://velura.royalai.dev/auth/callback");
  for (const bad of [
    "https://velura.royalai.dev/auth/callback?returnUrl=/products/1",
    "https://velura.royalai.dev/auth/callback#next=/products/1",
    "https://user:pass@velura.royalai.dev/auth/callback",
    "https://velura.royalai.dev/products/ao-so-mi",
    "https://evil.example/auth/callback",
    "not-a-url"
  ]) {
    assert.throws(() => validatedOAuthRedirect(bad), (err: unknown) => err instanceof HttpError && err.status === 400);
  }
});

test("attachReturnEligibility partitions multi-unit lines accurately and failClosedReturnItems fails closed", async () => {
  const repoForUnits = (units: JsonObject[]) => ({ listReturnUnits: async () => units }) as unknown as UserReturnsRepository;

  const [refundedPlusUntouched] = await attachReturnEligibility(
    repoForUnits([
      { unit_number: 1, success_count: 1, refunded: true, active_return_item_id: null, refundable_amount: 500000 },
      { unit_number: 2, success_count: 0, refunded: false, active_return_item_id: null, refundable_amount: 500000 }
    ]),
    "o1",
    [{ item_id: "i1", quantity: 2 }]
  );
  assert.equal(refundedPlusUntouched.refunded_quantity, 1);
  assert.equal(refundedPlusUntouched.available_quantity, 1);
  assert.equal(refundedPlusUntouched.held_quantity, 0);
  assert.equal(refundedPlusUntouched.exhausted_quantity, 0);
  assert.equal(refundedPlusUntouched.exchanged_once_quantity, 0);

  const [refundedPlusExhausted] = await attachReturnEligibility(
    repoForUnits([
      { unit_number: 1, success_count: 1, refunded: true, active_return_item_id: null, refundable_amount: 500000 },
      { unit_number: 2, success_count: 2, refunded: false, active_return_item_id: null, refundable_amount: 500000 }
    ]),
    "o1",
    [{ item_id: "i1", quantity: 2 }]
  );
  assert.equal(refundedPlusExhausted.refunded_quantity, 1);
  assert.equal(refundedPlusExhausted.exhausted_quantity, 1);
  assert.equal(refundedPlusExhausted.available_quantity, 0);

  const [heldPlusExchangedOnce] = await attachReturnEligibility(
    repoForUnits([
      { unit_number: 1, success_count: 0, refunded: false, active_return_item_id: "part-1", refundable_amount: 500000 },
      { unit_number: 2, success_count: 1, refunded: false, active_return_item_id: null, refundable_amount: 500000 }
    ]),
    "o1",
    [{ item_id: "i1", quantity: 2 }]
  );
  assert.equal(heldPlusExchangedOnce.held_quantity, 1);
  assert.equal(heldPlusExchangedOnce.exchanged_once_quantity, 1);
  assert.equal(heldPlusExchangedOnce.available_quantity, 1);
  assert.equal(heldPlusExchangedOnce.is_in_progress, true);

  const [closed] = failClosedReturnItems([{ item_id: "i1", quantity: 2 }]);
  assert.equal(closed.available_quantity, 0);
  assert.equal(closed.eligibility_unavailable, true);
});

test("presentOrderForCustomer separates 7-day return_window_open from can_request_return, normalizes naive UTC timestamps, and preserves exchange lineage", () => {
  const twoHoursAgoNaive = toNaivePostgresUtc(Date.now() - 2 * 3600 * 1000);
  const eightDaysAgoNaive = toNaivePostgresUtc(Date.now() - 8 * 86400 * 1000);

  const refundedDay0 = presentOrderForCustomer(
    {
      order_id: "e9eda599-5f99-4f6e-83ff-1f9a6dafdd96",
      order_code: "VLR481C2978B",
      status: "delivered",
      created_at: twoHoursAgoNaive,
      delivered_at: twoHoursAgoNaive,
      order_kind: "sale"
    },
    [{ item_id: "i1", quantity: 1, available_quantity: 0, refunded_quantity: 1, return_count: 1 }],
    [{ new_status: "delivered", changed_at: twoHoursAgoNaive }]
  );
  assert.equal(refundedDay0.return_window_open, true);
  assert.equal(refundedDay0.can_request_return, false);
  assert.ok(String(refundedDay0.delivered_at).endsWith("Z"));
  assert.ok(String(refundedDay0.return_window_ends_at).endsWith("Z"));
  assert.ok(String((refundedDay0.timeline as JsonObject[])[0].at).endsWith("Z"));
  assert.equal(refundedDay0.is_exchange_replacement, false);

  const exchangedOnce = presentOrderForCustomer(
    { order_id: "o2", status: "delivered", delivered_at: twoHoursAgoNaive },
    [{ item_id: "i2", quantity: 1, available_quantity: 1, refunded_quantity: 0, exchanged_once_quantity: 1, return_count: 1 }],
    []
  );
  assert.equal(exchangedOnce.return_window_open, true);
  assert.equal(exchangedOnce.can_request_return, true);

  const expired = presentOrderForCustomer(
    { order_id: "o3", status: "delivered", delivered_at: eightDaysAgoNaive },
    [{ item_id: "i3", quantity: 1, available_quantity: 1, return_count: 0 }],
    []
  );
  assert.equal(expired.return_window_open, false);
  assert.equal(expired.can_request_return, false);

  const exchangeOrder = presentOrderForCustomer(
    {
      order_id: "o4",
      order_code: "EXC123456",
      status: "delivered",
      delivered_at: twoHoursAgoNaive,
      order_kind: "exchange",
      parent_order_id: "orig-1",
      source_return_id: "ret-1"
    },
    [{ item_id: "i4", quantity: 1, available_quantity: 1 }],
    [],
    [],
    { isExchangeReplacement: true, sourceReturnId: "ret-1", sourceOrderId: "orig-1", sourceOrderCode: "VLR481C2978B" }
  );
  assert.equal(exchangeOrder.is_exchange_replacement, true);
  assert.equal(exchangeOrder.order_kind, "exchange");
  assert.equal(exchangeOrder.source_order_id, "orig-1");
  assert.equal(exchangeOrder.source_order_code, "VLR481C2978B");
  assert.equal(exchangeOrder.return_window_open, false);
  assert.equal(exchangeOrder.can_request_return, false);
});

test("returns-service requireDeliveredWithinWindow treats naive Postgres timestamps as UTC across timezones", async () => {
  const twoDaysAgoNaive = toNaivePostgresUtc(Date.now() - 2 * 86400 * 1000);
  const eightDaysAgoNaive = toNaivePostgresUtc(Date.now() - 8 * 86400 * 1000);
  const profile = { user_id: "70000000-0000-4000-8000-000000000003" } as UserProfile;
  const proof = {
    evidence_images: ["storage://return-evidence-private/return-intake/order/request_photo/photo.jpg"],
    evidence_videos: ["storage://return-evidence-private/return-intake/order/request_video/video.mp4"]
  };
  const intake = {
    order_id: "70000000-0000-4000-8000-000000000001",
    return_type: "refund",
    reason_code: "size",
    ...proof,
    items: [{ order_item_id: "70000000-0000-4000-8000-000000000002", quantity: 1 }]
  };

  const makeRepo = (deliveredAt: string): UserReturnsRepository => ({
    createReturnBundle: async (payload) => ({ return_id: "ret-utc", ...payload }),
    listReturnUnits: async () => [],
    findOrderByCode: async () => null,
    findOrderById: async () => ({ order_id: intake.order_id, user_id: profile.user_id, status: "delivered", delivered_at: deliveredAt }),
    findOrderItem: async () => ({ item_id: intake.items[0].order_item_id, order_id: intake.order_id, variant_id: "v1", quantity: 1 }),
    findVariant: async () => null,
    findProduct: async () => null,
    findCategory: async () => null,
    listReturnsForOrder: async () => [],
    listReturnItemsForReturn: async () => [{ return_item_id: "p1", order_item_id: intake.items[0].order_item_id, quantity: 1, resolution_type: "refund" }],
    findReturnById: async () => null,
    cancelReturn: async () => ({}),
    listReturnsForUser: async () => [{ return_id: "ret-utc", order_id: intake.order_id, user_id: profile.user_id, status: "COMPLETED", return_type: "refund", created_at: twoDaysAgoNaive }],
    getRefundReceiver: async () => null,
    setRefundReceiver: async () => ({}),
    recordCustomerResponse: async () => ({})
  });

  const created = await createUserReturnsService(makeRepo(twoDaysAgoNaive)).createForMember(profile, intake);
  assert.equal(created.return_id, "ret-utc");

  const list = await createUserReturnsService(makeRepo(twoDaysAgoNaive)).listForMember(profile, null);
  assert.ok(String(list[0].created_at).endsWith("Z"));

  await assert.rejects(
    () => createUserReturnsService(makeRepo(eightDaysAgoNaive)).createForMember(profile, intake),
    (err: unknown) => err instanceof HttpError && err.code === "RETURN_WINDOW_CLOSED"
  );
});
