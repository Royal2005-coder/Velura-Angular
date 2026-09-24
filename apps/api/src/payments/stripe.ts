import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import { releaseOrderVoucher } from "../user/vouchers.js";
import type { JsonObject } from "../types.js";

/**
 * Hạn của một phiên Stripe Checkout.
 *
 * Stripe chỉ nhận `expires_at` từ 30 phút tới 24 giờ kể từ lúc tạo, nên không đặt được
 * 15 phút như U1-07. Cộng thêm một phút để lệch đồng hồ giữa hai máy không làm Stripe
 * từ chối vì "dưới 30 phút". Hết hạn thì Stripe bắn `checkout.session.expired`, và đó là
 * lúc lượt mã của đơn được trả lại.
 */
export const STRIPE_CHECKOUT_TTL_SECONDS = 31 * 60;

/**
 * Card checkout through Stripe test mode. COD stays a separate path.
 * The order stays pending until `payment_intent.succeeded` marks the payment paid.
 */
export function stripeConfigured(): boolean {
  return Boolean(config.stripeSecretKey);
}

/**
 * Việc cần làm với một sự kiện Stripe, tách khỏi I/O để test được.
 *
 * `closed` là phiên thanh toán đã kết thúc hẳn mà không thu được tiền: lượt mã và ngân
 * sách chiến dịch của đơn phải được trả lại.
 */
export type StripeEventAction =
  | { kind: "paid"; orderId: string; paymentIntentId: string }
  | {
    kind: "closed";
    orderId: string;
    reason: "checkout.session.expired" | "payment_intent.canceled";
    /** Mã phiên Checkout khi sự kiện mang theo, để chỉ đóng đúng phiên đó. */
    sessionId: string | null;
  }
  | { kind: "ignore"; reason: string };

/**
 * Phân loại một sự kiện webhook của Stripe.
 *
 * `payment_intent.payment_failed` cố ý bị bỏ qua. Với Stripe Checkout, thẻ bị từ chối
 * thì khách vẫn thử lại được trên chính trang đó cho tới khi phiên hết hạn (U1-18). Trả
 * lượt mã lúc ấy rồi khách trả thành công sẽ thành đơn đã thu tiền mà lượt mã và ngân
 * sách đã bị trả lại. Chỉ trả khi phiên đã đóng hẳn.
 */
export function classifyStripeEvent(event: JsonObject): StripeEventAction {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const object = (event.data as JsonObject | undefined)?.object as JsonObject | undefined;
  const orderId = (object?.metadata as JsonObject | undefined)?.order_id;
  if (typeof orderId !== "string" || !orderId) {
    return { kind: "ignore", reason: "missing_order" };
  }

  if (type === "payment_intent.succeeded" || type === "checkout.session.completed") {
    const rawIntent = type === "checkout.session.completed" ? object?.payment_intent : object?.id;
    const paymentIntentId = typeof rawIntent === "string" ? rawIntent : (rawIntent as JsonObject | undefined)?.id;
    if (typeof paymentIntentId !== "string" || !paymentIntentId) {
      return { kind: "ignore", reason: "missing_payment_intent" };
    }
    return { kind: "paid", orderId, paymentIntentId };
  }

  if (type === "checkout.session.expired" || type === "payment_intent.canceled") {
    // Với phiên Checkout, `object.id` là mã phiên `cs_…`, cũng chính là
    // `gateway_transaction_ref` đã lưu lúc mở phiên. PaymentIntent thì không.
    const sessionId = type === "checkout.session.expired" && typeof object?.id === "string"
      ? object.id
      : null;
    return { kind: "closed", orderId, reason: type, sessionId };
  }

  if (type === "payment_intent.payment_failed") {
    return { kind: "ignore", reason: "retry_allowed" };
  }

  return { kind: "ignore", reason: type };
}

/**
 * Checks the Stripe-Signature header. Rejects stamps older than five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !secret) return false;
  const age = Math.abs(nowMs - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
}

/**
 * Opens Stripe's hosted test checkout for one pending order.
 * The buyer pays with a sandbox card. The order stays unpaid until the webhook.
 */
export async function createStripePaymentIntent(orderId: string, amount: number): Promise<{ id: string; url: string }> {
  if (!config.stripeSecretKey) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY. COD vẫn đặt được.");
  }
  const charge = Math.round(amount);
  if (charge < 10000) {
    throw new HttpError(400, "STRIPE_AMOUNT_TOO_SMALL", "Stripe sandbox yêu cầu đơn từ 10.000 đồng.");
  }
  const origin = config.storefrontOrigin;
  const body = new URLSearchParams({
    mode: "payment",
    success_url: `${origin}/checkout/confirm?stripe=success`,
    cancel_url: `${origin}/checkout/shipping?stripe=cancel`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "vnd",
    "line_items[0][price_data][unit_amount]": String(charge),
    "line_items[0][price_data][product_data][name]": "Don hang Velura",
    "metadata[order_id]": orderId,
    "payment_intent_data[metadata][order_id]": orderId,
    expires_at: String(Math.floor(Date.now() / 1000) + STRIPE_CHECKOUT_TTL_SECONDS)
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.stripeSecretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !payload.id || !payload.url) {
    throw new HttpError(502, "STRIPE_INTENT_FAILED", payload.error?.message || "Stripe không tạo được trang thanh toán.");
  }
  await insertRow("payment", {
    order_id: orderId,
    payment_method: "ONLINE_PAYMENT",
    payment_provider: "stripe",
    amount: charge,
    payment_status: "pending",
    payment_channel: "stripe",
    gateway_transaction_ref: payload.id
  });
  return { id: payload.id, url: payload.url };
}

/**
 * Chuyển payment Stripe đang `pending` của một đơn sang trạng thái mới, đúng một lần.
 *
 * Điều kiện `payment_status=eq.pending` nằm ngay trong câu UPDATE chứ không ở bước đọc
 * trước đó, nên hai webhook đến cùng lúc chỉ một cái cập nhật trúng dòng. Trả về dòng đã
 * đổi, hoặc null nếu không còn payment nào đang chờ — tức việc này đã có người làm rồi.
 */
async function transitionPendingStripePayment(
  orderId: string,
  patch: JsonObject,
  sessionId: string | null = null
): Promise<JsonObject | null> {
  const filter: Record<string, string> = {
    order_id: `eq.${orderId}`,
    payment_provider: "eq.stripe",
    payment_status: "eq.pending"
  };
  if (sessionId) filter.gateway_transaction_ref = `eq.${sessionId}`;
  const changed = await updateRows("payment", filter, patch);
  return (changed[0] as JsonObject | undefined) ?? null;
}

/**
 * Đóng payment Stripe của một đơn khi phiên thanh toán kết thúc mà không thu được tiền,
 * rồi trả lượt mã và ngân sách chiến dịch của đơn đó.
 *
 * Enum `payment_status` không có `expired` hay `cancelled`, nên ghi `failed` và để lý
 * do thật ở `gateway_response_code`. Chỉ trả lượt khi chính lần gọi này đổi được payment
 * khỏi `pending`, nên webhook gửi lại hai lần cũng chỉ trả một lần (U1-20). Hàm trả lượt
 * phía CSDL cũng tự chặn lần thứ hai, nên đây là hai lớp chứ không phải một.
 *
 * Không đổi trạng thái đơn: bộ trạng thái mới của KAN-59 chưa chốt và màn "Hết hạn thanh
 * toán" thuộc U1.
 */
export async function closeStripePayment(
  orderId: string,
  reason: "checkout.session.expired" | "payment_intent.canceled",
  sessionId: string | null
): Promise<"closed" | "ignored"> {
  const closed = await transitionPendingStripePayment(orderId, {
    payment_status: "failed",
    gateway_response_code: reason
  }, sessionId);
  if (!closed) return "ignored";
  await releaseOrderVoucher(orderId, reason);
  return "closed";
}

/**
 * Marks the Stripe payment paid and decrements stock once.
 * A repeat webhook for the same PaymentIntent does not decrement again.
 */
export async function markStripePaymentPaid(orderId: string, paymentIntentId: string): Promise<"paid" | "ignored"> {
  const paid = await transitionPendingStripePayment(orderId, {
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    gateway_response_code: "succeeded",
    gateway_transaction_ref: paymentIntentId
  });
  if (!paid) {
    // Không còn payment đang chờ: hoặc webhook này là bản gửi lại, hoặc phiên đã hết hạn.
    // Bản cũ đọc rồi mới kiểm `=== "paid"`, nên hai webhook đến cùng lúc đều thấy
    // pending và đều trừ kho. Nay chỉ lần cập nhật trúng dòng mới đi tiếp.
    const existing = await selectRows("payment", {
      order_id: `eq.${orderId}`,
      payment_provider: "eq.stripe",
      payment_status: "eq.paid",
      limit: 1
    });
    return existing.rows[0] ? "paid" : "ignored";
  }
  const { rows: items } = await selectRows("order_item", { order_id: `eq.${orderId}`, limit: 100 });
  for (const item of items) {
    const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
    if (!variant) continue;
    const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
    await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
  }
  return "paid";
}
