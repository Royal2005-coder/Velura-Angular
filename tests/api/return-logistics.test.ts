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
      listReturnLines: async () => ({ rows: [] }),
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
});

test("creating a return label requires carrier and AWB and forwards the expected version", async () => {
  let received: Record<string, unknown> | null = null;
  const service = createReturnService({
    repository: {
      createReturnShipment: async (returnId, version, input, actorId) => {
        received = { returnId, version, input, actorId };
        return { return: { return_id: RETURN_ID }, shipment: { shipment_id: "s1" } };
      }
    } as unknown as ReturnRepository
  });

  await assert.rejects(
    () => service.createReturnShipment(context(), RETURN_ID, { expectedVersion: 3, carrier: "", trackingCode: "GHN123456" }),
    hasCode("CARRIER_REQUIRED")
  );
  await assert.rejects(
    () => service.createReturnShipment(context(), RETURN_ID, { expectedVersion: 3, carrier: "GHN", trackingCode: "123" }),
    hasCode("TRACKING_REQUIRED")
  );

  await service.createReturnShipment(context(), RETURN_ID, {
    expectedVersion: 3,
    carrier: "GHN",
    trackingCode: "GHN123456789",
    trackingUrl: "https://donhang.ghn.vn/?order_code=GHN123456789"
  });
  assert.equal((received as Record<string, unknown> | null)?.["version"], 3);
  assert.equal((received as Record<string, unknown> | null)?.["actorId"], "auth-1");
});

test("pickup requires at least one stored photo reference", async () => {
  const service = createReturnService({
    repository: {
      confirmReturnPickup: async (_id, _version, input) => input
    } as unknown as ReturnRepository
  });

  await assert.rejects(
    () => service.confirmReturnPickup(context(), RETURN_ID, { expectedVersion: 3, photoUrls: [] }),
    hasCode("PICKUP_PHOTO_REQUIRED")
  );
});

test("receipt requires package match, an intact seal and a per-line disposition", async () => {
  let writes = 0;
  let receivedReceipts: unknown = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, status: "RETURN_IN_TRANSIT", return_type: "refund", version: 2 }),
      listReturnLines: async () => ({ rows: [{ order_item_id: "line-1", quantity: 1 }] }),
      receiveReturn: async (_id, _version, input) => {
        writes += 1;
        receivedReceipts = input.receipts;
        return { return_id: RETURN_ID, status: "RECEIVED" };
      }
    } as unknown as ReturnRepository
  });

  const body = {
    expectedVersion: 2,
    status: "RECEIVED",
    conditionCheckResult: "qa_pass",
    imageProof: "https://cdn.test/qa.jpg",
    items: [{ orderItemId: "line-1", receivedQuantity: 1, matchesProduct: true }]
  };
  await assert.rejects(
    () => service.updateReturnStatus(context(), RETURN_ID, body),
    hasCode("PACKAGE_CHAIN_REQUIRED")
  );
  await assert.rejects(
    () => service.updateReturnStatus(context(), RETURN_ID, { ...body, packageMatch: true, sealIntact: true }),
    hasCode("RETURN_DISPOSITION_REQUIRED")
  );
  assert.equal(writes, 0);

  await service.updateReturnStatus(context(), RETURN_ID, {
    ...body,
    packageMatch: true,
    sealIntact: true,
    items: [{ orderItemId: "line-1", receivedQuantity: 1, matchesProduct: true, disposition: "restock" }]
  });
  assert.equal(writes, 1);
  assert.deepEqual(receivedReceipts, [{ orderItemId: "line-1", receivedQuantity: 1, matchesProduct: true, disposition: "restock" }]);
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
