import test from "node:test";
import assert from "node:assert/strict";
import { createWaybill } from "../../apps/api/src/carrier/carrier-gateway-simulator.js";
import { CARRIER_TRACKING_PATTERN } from "../../apps/api/src/carrier/carrier-contract.js";

test("waybill is deterministic, passes the carrier tracking pattern and carries a shipment QR", () => {
  const first = createWaybill({ order_id: "50000000-0000-4000-8000-000000000001", order_code: "VLR-7001" });
  const again = createWaybill({ order_id: "50000000-0000-4000-8000-000000000001", order_code: "VLR-7001" });
  assert.deepEqual(first, again);
  assert.equal(first.carrier, "GHN");
  assert.equal(first.trackingCode, "GHNVLR7001");
  assert.match(first.trackingCode, CARRIER_TRACKING_PATTERN);
  assert.ok(first.trackingUrl.startsWith("https://"));
  assert.ok(first.labelQr.startsWith("velura:shipment:1?"));
  const params = new URLSearchParams(first.labelQr.split("?")[1]);
  assert.equal(params.get("order"), "VLR-7001");
  assert.equal(params.get("carrier"), "GHN");
  assert.equal(params.get("tracking"), first.trackingCode);
  assert.equal(params.get("url"), first.trackingUrl);
});

test("an order without a usable code falls back to its id and still yields a valid tracking code", () => {
  const byId = createWaybill({ order_id: "50000000-0000-4000-8000-000000000001", order_code: "" });
  assert.match(byId.trackingCode, CARRIER_TRACKING_PATTERN);
  const bare = createWaybill({ order_code: "A" });
  assert.match(bare.trackingCode, CARRIER_TRACKING_PATTERN);
});
