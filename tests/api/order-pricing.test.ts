import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogUnitPrice,
  priceOrder,
  shippingFeeFor,
  type CatalogPrice
} from "../../apps/api/src/user/order-pricing.js";

function catalog(rows: CatalogPrice[]): Map<string, CatalogPrice> {
  return new Map(rows.map((row) => [row.variantId, row]));
}

test("a claimed price that is not the catalog price is rejected", () => {
  const result = priceOrder(
    [{ variantId: "v1", quantity: 1, claimedUnitPrice: 1 }],
    catalog([{ variantId: "v1", unitPrice: 250000, productName: "Áo" }]),
    "standard"
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PRICE_MISMATCH");
    assert.equal(result.catalogUnitPrice, 250000);
    assert.equal(result.claimedUnitPrice, 1);
  }
});

test("combo lines use each component catalog price", () => {
  const result = priceOrder(
    [
      { variantId: "top", quantity: 1, claimedUnitPrice: 200000 },
      { variantId: "bottom", quantity: 1, claimedUnitPrice: 300000 }
    ],
    catalog([
      { variantId: "top", unitPrice: 200000, productName: "Áo" },
      { variantId: "bottom", unitPrice: 300000, productName: "Quần" }
    ]),
    "standard"
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.subtotal, 500000);
    assert.equal(result.shippingFee, 0);
    assert.equal(result.totalAmount, 500000);
  }
});

test("shipping is free at the threshold and charged below it", () => {
  assert.equal(shippingFeeFor(499999, "standard"), 30000);
  assert.equal(shippingFeeFor(499999, "express"), 50000);
  assert.equal(shippingFeeFor(500000, "express"), 0);
  const priced = priceOrder(
    [{ variantId: "v1", quantity: 1, claimedUnitPrice: 200000 }],
    catalog([{ variantId: "v1", unitPrice: 200000, productName: "Áo" }]),
    "standard",
    10000
  );
  assert.equal(priced.ok, true);
  if (priced.ok) {
    assert.equal(priced.shippingFee, 30000);
    assert.equal(priced.discountAmount, 10000);
    assert.equal(priced.totalAmount, 220000);
  }
});

test("catalog price prefers the positive sale price", () => {
  assert.equal(catalogUnitPrice(180000, 250000), 180000);
  assert.equal(catalogUnitPrice(0, 250000), 250000);
});
