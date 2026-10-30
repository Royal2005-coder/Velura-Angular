import test from "node:test";
import assert from "node:assert/strict";
import { createUserReturnsService } from "../../apps/api/src/user/returns-service.js";
import type { UserReturnsRepository } from "../../apps/api/src/user/returns-repository.js";
import { HttpError } from "../../apps/api/src/http.js";

const RETURN_ID = "50000000-0000-4000-8000-000000000021";
const ORDER_ID = "50000000-0000-4000-8000-000000000022";

const baseReturn = {
  return_id: RETURN_ID,
  return_code: "RETABC123",
  order_id: ORDER_ID,
  user_id: "u1",
  return_type: "refund",
  status: "WAITING_RETURN",
  version: 2,
  refund_bank_name: "VCB",
  refund_bank_account: "123456789",
  refund_bank_holder: "Nguyen A",
  tracking_return_code: "GHN123456789"
};

const order = {
  order_id: ORDER_ID,
  order_code: "VLR-001",
  payment_method: "COD",
  shipping_name: "Nguyen A",
  shipping_phone: "0900000001",
  shipping_address: "1 Nguyen Hue"
};

function repository(overrides: Partial<UserReturnsRepository> = {}): UserReturnsRepository {
  return {
    findReturnById: async () => baseReturn,
    findOrderById: async () => order,
    listReturnItemsForReturn: async () => [{ return_item_id: "part-1", order_item_id: "line-1", quantity: 1, item_status: "WAITING_RETURN", decision_status: "approved", resolution_type: "refund", reason: "Size does not fit", version: 3 }],
    findOrderItem: async () => ({ variant_id: "v1", product_name: "Ao lua", product_image: "x.jpg", unit_price: 100000 }),
    listReturnShipments: async () => [{
      direction: "inbound",
      carrier: "GHN",
      tracking_code: "GHN123456789",
      tracking_url: "https://donhang.ghn.vn/?order_code=GHN123456789",
      status: "label_ready",
      pickup_photo_urls: []
    }],
    listReturnEvents: async () => [{
      event_type: "shipment",
      old_status: "WAITING_RETURN",
      new_status: "WAITING_RETURN",
      payload: { direction: "inbound", status: "label_ready", carrier: "GHN", tracking_code: "GHN123456789" },
      created_at: "2026-10-27T00:00:00Z"
    }],
    getExchangeOrder: async () => null,
    getRefundReceiver: async () => ({
      bank_name: "VCB",
      account_number: "123456789",
      account_holder: "Nguyen A",
      supplement_request: null
    }),
    insertReturnEvent: async () => ({}),
    ...overrides
  } as unknown as UserReturnsRepository;
}

test("customer detail exposes tracking, timeline and masks the COD bank account", async () => {
  const service = createUserReturnsService(repository());
  const detail = await service.detailForMember({ user_id: "u1" } as never, RETURN_ID);

  assert.equal(detail.return_code, "RETABC123");
  assert.equal(detail.status_label, "Đã duyệt · chờ ĐVVC lấy hàng");
  assert.equal(detail.customer_name, "Nguyen A");
  assert.equal(detail.can_upload_packing, true);
  assert.equal(detail.refund_bank_account, undefined);
  assert.equal(detail.refund_bank_name, undefined);
  assert.equal(detail.shipment?.carrier, "GHN");
  assert.equal(detail.timeline?.[0]?.label, "Đã tạo vận đơn hoàn");
  assert.equal((detail.items as Array<Record<string, unknown>>)[0]?.["product_name"], "Ao lua");
  assert.equal((detail.items as Array<Record<string, unknown>>)[0]?.["return_item_id"], "part-1");
  assert.equal((detail.items as Array<Record<string, unknown>>)[0]?.["decision_status"], "approved");
  assert.equal((detail.items as Array<Record<string, unknown>>)[0]?.["resolution_type"], "refund");
});

test("a customer cannot read or upload evidence for another customer's return", async () => {
  const service = createUserReturnsService(repository());
  await assert.rejects(
    () => service.detailForMember({ user_id: "u2" } as never, RETURN_ID),
    (error) => error instanceof HttpError && error.status === 404
  );
  await assert.rejects(
    () => service.addPackingEvidenceForMember({ user_id: "u2" } as never, RETURN_ID, "packing_photo", "", {} as never),
    (error) => error instanceof HttpError && error.status === 404
  );
});

test("packing evidence is refused after the carrier has taken the parcel", async () => {
  const service = createUserReturnsService(repository({
    findReturnById: async () => ({ ...baseReturn, status: "RETURN_IN_TRANSIT" }),
    listReturnItemsForReturn: async () => [{ return_item_id: "part-1", order_item_id: "line-1", quantity: 1, item_status: "RETURN_SHIPPING" }]
  }));
  await assert.rejects(
    () => service.addPackingEvidenceForMember({ user_id: "u1" } as never, RETURN_ID, "packing_video", "", {} as never),
    (error) => error instanceof HttpError && error.code === "PACKING_EVIDENCE_CLOSED"
  );
});

test("guest tracking is denied without the order access token", async () => {
  const service = createUserReturnsService(repository());
  await assert.rejects(
    () => service.detailForGuest(RETURN_ID, "wrong-token"),
    (error) => error instanceof HttpError && error.status === 404
  );
});
