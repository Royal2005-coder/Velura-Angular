import { HttpError, readJson, sendJson } from "../http.js";
import { FREESHIP_THRESHOLD, shippingFeeFor, shippingMethodFromClaim } from "./order-pricing.js";
import { loadVoucherCart, parseCartItems } from "./cart-catalog.js";
import { buildWallet } from "./vouchers.js";
import type { EvaluatedVoucher } from "./voucher-engine.js";
import { chooseOrderVoucher, readVoucherRequest, type VoucherChange } from "./voucher-choice.js";
import type { AuthContext, HeaderMap, HttpRequest, HttpResponse, JsonObject } from "../types.js";

/**
 * Báo giá phía máy chủ cho màn Tóm tắt đơn — `order_summary` của U1-13.
 *
 * Trình duyệt không tự cộng tổng. Nó gửi dòng hàng, phương thức giao và mã khách
 * chọn; máy chủ trả lại đúng các con số sẽ được ghi khi đặt đơn, vì đặt đơn chạy qua
 * cùng hàm chọn mã `chooseOrderVoucher` (`voucher-choice.ts`).
 */

/** Các con số của một đơn, đúng như sẽ được ghi khi đặt. */
export interface CheckoutQuote {
  subtotal: number;
  shippingFee: number;
  freeShippingThreshold: number;
  freeShippingShortfall: number;
  discountAmount: number;
  totalAmount: number;
  voucher: {
    voucherId: string;
    code: string;
    name: string;
    discountAmount: number;
  } | null;
  voucherChange: VoucherChange | null;
}

/**
 * Tổng hợp báo giá từ giá trị đơn, phí giao và mã đã chọn. Thuần, không I/O.
 */
export function summarizeQuote(
  subtotal: number,
  shippingFee: number,
  applied: EvaluatedVoucher | null,
  change: VoucherChange | null
): CheckoutQuote {
  // Giảm giá không vượt giá trị đơn cộng phí giao (BR-A4-07), để tổng không bao giờ âm.
  const discountAmount = Math.min(applied?.discountAmount || 0, subtotal + shippingFee);
  return {
    subtotal,
    shippingFee,
    freeShippingThreshold: FREESHIP_THRESHOLD,
    freeShippingShortfall: subtotal > 0 ? Math.max(0, FREESHIP_THRESHOLD - subtotal) : FREESHIP_THRESHOLD,
    discountAmount,
    totalAmount: Math.max(0, subtotal + shippingFee - discountAmount),
    voucher: applied
      ? { voucherId: applied.voucherId, code: applied.code, name: applied.name, discountAmount }
      : null,
    voucherChange: change
  };
}

/**
 * `POST /api/user/checkout/quote`
 *
 * Nhận `{ items: [{ variant_id, quantity }], shipping_method, voucher_id | code, decline_voucher }`.
 * Dùng được cho cả khách vãng lai lẫn thành viên.
 */
export async function handleCheckoutRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (action !== "quote" || req.method !== "POST") {
    throw new HttpError(404, "NOT_FOUND", "Checkout route not found");
  }
  const body = await readJson(req) as JsonObject;
  const items = parseCartItems(body.items);
  if (!items.length) throw new HttpError(400, "EMPTY_CART", "Giỏ hàng chưa có sản phẩm nào.");

  const cart = await loadVoucherCart(items);
  if (!cart.lines.length && items.length > 0) {
    throw new HttpError(400, "INVALID_ITEMS", "Một số sản phẩm trong giỏ hàng không tồn tại hoặc đã ngừng kinh doanh.");
  }
  const shippingFee = shippingFeeFor(cart.orderValue, shippingMethodFromClaim(body.shipping_fee, body.shipping_method));
  const wallet = await buildWallet(context, cart.orderValue, shippingFee, {
    lines: cart.lines,
    categoryNameById: cart.categoryNameById
  });
  const { applied, change } = chooseOrderVoucher(wallet, readVoucherRequest(body));
  sendJson(res, 200, { success: true, quote: toWireQuote(summarizeQuote(cart.orderValue, shippingFee, applied, change)) }, corsHeaders);
}

/** Định dạng dây snake_case, cùng lối với các endpoint ví mã. */
export function toWireQuote(quote: CheckoutQuote): JsonObject {
  return {
    subtotal: quote.subtotal,
    shipping_fee: quote.shippingFee,
    free_shipping_threshold: quote.freeShippingThreshold,
    free_shipping_shortfall: quote.freeShippingShortfall,
    discount_amount: quote.discountAmount,
    total_amount: quote.totalAmount,
    voucher: quote.voucher
      ? {
        voucher_id: quote.voucher.voucherId,
        code: quote.voucher.code,
        name: quote.voucher.name,
        discount_amount: quote.voucher.discountAmount
      }
      : null,
    voucher_change: quote.voucherChange
      ? {
        requested_voucher_id: quote.voucherChange.requestedVoucherId,
        requested_code: quote.voucherChange.requestedCode,
        reason_text: quote.voucherChange.reasonText
      }
      : null
  };
}
