import test from "node:test";
import assert from "node:assert/strict";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";
import type { ReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { HttpError } from "../../apps/api/src/http.js";

const RETURN_ID = "50000000-0000-4000-8000-000000000011";
const context = (roleCode = "admin_operator_cskh_dt") => ({
  authUser: { id: "auth-1" },
  roleCode,
  accessToken: "jwt-token"
});
const hasCode = (code: string) => (error: unknown): boolean =>
  error instanceof HttpError && error.code === code;

test("return detail carries the inbound shipment, evidence and linked exchange order", async () => {
  const service = createReturnService({
    repository: {
      getReturn: async () => ({
        return_id: RETURN_ID,
        return_code: "RETABC123",
        order_id: "order-1",
        exchange_order_id: "exchange-1",
        return_type: "exchange",
        status: "RETURN_IN_TRANSIT",
        version: 4
      }),
      getRefundableAmount: async () => 0,
      getPaymentByOrderId: async () => null,
      listReturnLines: async () => ({ rows: [{
        return_item_id: "part-exchange", order_item_id: "line-1", quantity: 1,
        item_status: "EXCHANGE_SHIPPING", decision_status: "approved", resolution_type: "exchange",
        version: 7, exchange_order_id: "exchange-1", replacement_variant_id: "variant-2"
      }, {
        return_item_id: "part-pending", order_item_id: "line-2", quantity: 2,
        item_status: "REQUESTED", decision_status: "pending", resolution_type: "exchange", version: 1
      }] }),
      getItemRefundableAmount: async itemId => itemId === "part-exchange" ? 125000 : 250000,
      listReturnShipments: async () => [{
        shipment_id: "shipment-1",
        direction: "inbound",
        carrier: "GHN",
        tracking_code: "GHN123456789",
        tracking_url: "https://donhang.ghn.vn/?order_code=GHN123456789",
        status: "in_transit",
        pickup_photo_urls: ["https://cdn.test/pickup.jpg"]
      }],
      listReturnEvents: async () => [{
        event_type: "pickup",
        new_status: "RETURN_IN_TRANSIT",
        created_at: "2026-10-27T00:00:00Z"
      }],
      getExchangeOrder: async () => ({
        order_id: "exchange-1",
        order_code: "EXC123",
        status: "confirmed",
        order_kind: "exchange"
      })
    } as unknown as ReturnRepository
  });

  const detail = await service.getReturn(context(), RETURN_ID);
  assert.equal(detail.return_code, "RETABC123");
  assert.equal(detail.shipment?.carrier, "GHN");
  assert.equal(detail.shipment?.pickup_photo_urls?.[0], "https://cdn.test/pickup.jpg");
  assert.equal(detail.events?.length, 1);
  assert.deepEqual(detail.evidence, []);
  assert.equal(detail.exchange_order?.order_code, "EXC123");
  const lines = detail.lines as Record<string, unknown>[];
  assert.equal(lines[0].version, 7);
  assert.equal(lines[0].replacement_variant_id, "variant-2");
  assert.equal(lines[0].refundable_amount, 125000);
  assert.equal((lines[0].exchange_order as Record<string, unknown>).order_code, "EXC123");
  assert.equal(lines[1].exchange_order, null);
  assert.equal(lines[1].item_status, "REQUESTED");
});

test("pickup facts belong to the chosen part and retain private photos and optional video", async () => {
  let received: unknown[] = [];
  const service = createReturnService({ repository: {
    actOnItem: async (...args) => { received = args; return { item_status: "RETURN_SHIPPING" }; }
  } as unknown as ReturnRepository });
  const facts = {
    carrier: "GHN", trackingNumber: "GHN123456789", pickedUpBy: "Nhan vien GHN",
    pickedUpAt: new Date(Date.now() - 60000).toISOString(),
    photoUrls: [`storage://order-evidence/returns/${RETURN_ID}/pickup_photo/photo.jpg`],
    videoUrl: `storage://order-evidence/returns/${RETURN_ID}/pickup_video/video.mp4`
  };
  await assert.rejects(() => service.actOnItem(context(), RETURN_ID, "part-1", { action: "pickup", expectedVersion: 3, ...facts, pickedUpBy: "" }), hasCode("PICKUP_FACTS_REQUIRED"));
  await assert.rejects(() => service.actOnItem(context(), RETURN_ID, "part-1", { action: "pickup", expectedVersion: 3, ...facts, pickedUpAt: new Date(Date.now() + 60000).toISOString() }), hasCode("PICKUP_FACTS_REQUIRED"));
  await service.actOnItem(context(), RETURN_ID, "part-1", { action: "pickup", expectedVersion: 3, ...facts });
  assert.deepEqual(received.slice(0, 6), [RETURN_ID, "part-1", "pickup", facts, 3, "auth-1"]);
});

test("receipt requires explicit booleans, private proof and a disposition without rejecting a broken seal", async () => {
  const writes: unknown[][] = [];
  const service = createReturnService({ repository: {
    actOnItem: async (...args) => { writes.push(args); return { item_status: "RECEIVED" }; }
  } as unknown as ReturnRepository });
  const facts = {
    action: "receive", expectedVersion: 2, receivedQuantity: 1,
    matchesProduct: true, tagsIntact: true, conditionAcceptable: true, packageMatch: true, sealIntact: false,
    disposition: "restock", receiptProofRef: `storage://order-evidence/returns/${RETURN_ID}/qa_photo/proof.jpg`
  };
  await assert.rejects(() => service.actOnItem(context(), RETURN_ID, "part-1", { ...facts, tagsIntact: undefined }), hasCode("RECEIPT_FACTS_REQUIRED"));
  await assert.rejects(() => service.actOnItem(context(), RETURN_ID, "part-1", { ...facts, disposition: "" }), hasCode("RETURN_DISPOSITION_REQUIRED"));
  await assert.rejects(() => service.actOnItem(context(), RETURN_ID, "part-1", { ...facts, receiptProofRef: "https://cdn.test/qa.jpg" }), hasCode("PROOF_REQUIRED"));
  assert.equal(writes.length, 0);
  const result = await service.actOnItem(context(), RETURN_ID, "part-1", facts);
  assert.equal(result.item_status, "RECEIVED");
  assert.equal((writes[0][3] as Record<string, unknown>).sealIntact, false);
});

test("order operators cannot create labels or confirm pickup", async () => {
  const service = createReturnService({ repository: {} as unknown as ReturnRepository });
  await assert.rejects(
    () => service.createReturnShipment(context("admin_operator_donhang"), RETURN_ID, { expectedVersion: 1, carrier: "GHN", trackingCode: "GHN123456" }),
    (error) => error instanceof HttpError && error.status === 403
  );
  await assert.rejects(
    () => service.confirmReturnPickup(context("admin_operator_donhang"), RETURN_ID, { expectedVersion: 1, photoUrls: ["storage://bucket/x.jpg"] }),
    (error) => error instanceof HttpError && error.status === 403
  );
});
