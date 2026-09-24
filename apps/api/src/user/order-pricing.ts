/**
 * Server-side order money. The browser may display a total, but the stored
 * line price is the catalog price of the product that owns the variant.
 */

export const FREESHIP_THRESHOLD = 500_000;
export const STANDARD_SHIPPING_FEE = 30_000;
export const EXPRESS_SHIPPING_FEE = 50_000;

export interface ClaimedOrderLine {
  variantId: string;
  quantity: number;
  claimedUnitPrice: number;
}

export interface CatalogPrice {
  variantId: string;
  unitPrice: number;
  productName: string;
}

export interface PricedOrderLine {
  variantId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  productName: string;
}

export interface PricedOrder {
  items: PricedOrderLine[];
  subtotal: number;
  shippingFee: number;
  discountAmount: number;
  totalAmount: number;
}

export type OrderPriceFailure = {
  ok: false;
  code: "UNKNOWN_VARIANT" | "INVALID_QUANTITY" | "PRICE_MISMATCH";
  message: string;
  variantId?: string;
  claimedUnitPrice?: number;
  catalogUnitPrice?: number;
};

/**
 * Catalog selling price. `sale_price` is the price the storefront shows.
 */
export function catalogUnitPrice(salePrice: unknown, basePrice: unknown): number {
  const sale = Number(salePrice);
  if (Number.isFinite(sale) && sale > 0) return Math.round(sale);
  const base = Number(basePrice);
  return Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
}

/**
 * Standard is 30.000đ, express is 50.000đ, and either is free from 500.000đ.
 */
export function shippingFeeFor(subtotal: number, method: "standard" | "express"): number {
  if (subtotal <= 0 || subtotal >= FREESHIP_THRESHOLD) return 0;
  return method === "express" ? EXPRESS_SHIPPING_FEE : STANDARD_SHIPPING_FEE;
}

/**
 * A claimed fee of 50.000đ means express. Every other claim is standard,
 * then the threshold recomputes the fee.
 */
export function shippingMethodFromClaim(claimedFee: unknown, claimedMethod: unknown): "standard" | "express" {
  if (String(claimedMethod || "").toLowerCase() === "express") return "express";
  return Number(claimedFee) === EXPRESS_SHIPPING_FEE ? "express" : "standard";
}

/**
 * Prices every line from the catalog. A claimed price that differs is rejected.
 */
export function priceOrder(
  lines: readonly ClaimedOrderLine[],
  catalog: ReadonlyMap<string, CatalogPrice>,
  shippingMethod: "standard" | "express",
  discountAmount = 0
): { ok: true } & PricedOrder | OrderPriceFailure {
  const items: PricedOrderLine[] = [];
  for (const line of lines) {
    const quantity = Math.round(Number(line.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, code: "INVALID_QUANTITY", message: "Số lượng không hợp lệ.", variantId: line.variantId };
    }
    const known = catalog.get(line.variantId);
    if (!known) {
      return { ok: false, code: "UNKNOWN_VARIANT", message: "Không tìm thấy biến thể sản phẩm.", variantId: line.variantId };
    }
    const claimed = Math.round(Number(line.claimedUnitPrice));
    if (claimed !== known.unitPrice) {
      return {
        ok: false,
        code: "PRICE_MISMATCH",
        message: `Giá dòng hàng không khớp catalog: khách gửi ${claimed}, catalog ${known.unitPrice}.`,
        variantId: line.variantId,
        claimedUnitPrice: claimed,
        catalogUnitPrice: known.unitPrice
      };
    }
    items.push({
      variantId: line.variantId,
      quantity,
      unitPrice: known.unitPrice,
      subtotal: known.unitPrice * quantity,
      productName: known.productName
    });
  }
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const shippingFee = shippingFeeFor(subtotal, shippingMethod);
  const discount = Math.min(Math.max(0, Math.round(discountAmount)), subtotal + shippingFee);
  return {
    ok: true,
    items,
    subtotal,
    shippingFee,
    discountAmount: discount,
    totalAmount: Math.max(0, subtotal + shippingFee - discount)
  };
}
