import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc, insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, errorMessage, type JsonObject } from "../types.js";
import { createNotification } from "../user/notifications.js";
import { refundChannelName, refundChannelText, sendRefundSuccessEmail, type RefundGatewayLabel } from "../returns/return-email.js";

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
 * Đơn online nằm ở Chờ thanh toán cho tới khi webhook báo tiền về (OPEN-05).
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
  | {
    kind: "paid";
    orderId: string;
    paymentIntentId: string;
    /** Mã phiên Checkout khi sự kiện là `checkout.session.completed`. */
    sessionId: string | null;
  }
  | {
    kind: "closed";
    orderId: string;
    reason: "checkout.session.expired" | "checkout.session.async_payment_failed" | "payment_intent.canceled";
    /** Mã phiên Checkout khi sự kiện mang theo, để chỉ đóng đúng phiên đó. */
    sessionId: string | null;
  }
  | { kind: "refunded"; paymentIntentId: string; amount?:number; refunds?:JsonObject[] }
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

  // Hoàn tiền nhận ra bằng PaymentIntent của charge, không bằng metadata: payment lưu
  // mã PaymentIntent ở `gateway_transaction_ref` từ lúc tiền về.
  if (type === "charge.refunded" || type === "refund.created" || type === "refund.updated" || type === "refund.failed") {
    const intent = object?.payment_intent;
    const paymentIntentId = typeof intent === "string" ? intent : (intent as JsonObject | undefined)?.id;
    return typeof paymentIntentId === "string" && paymentIntentId
      ? { kind: "refunded", paymentIntentId,
        ...(type === "charge.refunded"
          ? { ...(typeof object?.amount_refunded === "number" ? { amount: object.amount_refunded } : {}),
            ...(Array.isArray(asJsonObject(object?.refunds).data) ? { refunds: asJsonObject(object?.refunds).data as JsonObject[] } : {}) }
          : { refunds: [asJsonObject(object)] }) }
      : { kind: "ignore", reason: "missing_payment_intent" };
  }

  const orderId = (object?.metadata as JsonObject | undefined)?.order_id;
  if (typeof orderId !== "string" || !orderId) {
    return { kind: "ignore", reason: "missing_order" };
  }

  if (type === "payment_intent.succeeded" || type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (type === "checkout.session.completed" && object?.payment_status && object.payment_status !== "paid") return {kind:"ignore",reason:"capture_pending"};
    const rawIntent = type.startsWith("checkout.session.") ? object?.payment_intent : object?.id;
    const paymentIntentId = typeof rawIntent === "string" ? rawIntent : (rawIntent as JsonObject | undefined)?.id;
    if (typeof paymentIntentId !== "string" || !paymentIntentId) {
      return { kind: "ignore", reason: "missing_payment_intent" };
    }
    const sessionId = type.startsWith("checkout.session.") && typeof object?.id === "string" ? object.id : null;
    return { kind: "paid", orderId, paymentIntentId, sessionId };
  }

  if (type === "checkout.session.expired" || type === "checkout.session.async_payment_failed" || type === "payment_intent.canceled") {
    // Với phiên Checkout, `object.id` là mã phiên `cs_…`, cũng chính là
    // `gateway_transaction_ref` đã lưu lúc mở phiên. PaymentIntent thì không.
    const sessionId = type.startsWith("checkout.session.") && typeof object?.id === "string"
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
export async function createStripePaymentIntent(
  orderId: string,
  amount: number,
  returnPath: string | null = null
): Promise<{ id: string; url: string }> {
  if (!config.stripeSecretKey) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY. COD vẫn đặt được.");
  }
  const charge = Math.round(amount);
  if (charge < 10000) {
    throw new HttpError(400, "STRIPE_AMOUNT_TOO_SMALL", "Stripe sandbox yêu cầu đơn từ 10.000 đồng.");
  }
  const origin = config.storefrontOrigin;
  const returnBase = returnPath ?? "/checkout/confirm";
  const sep = returnBase.includes("?") ? "&" : "?";
  const successUrl = `${origin}${returnBase}${sep}stripe=success&session_id={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`;
  const order = await selectOne("orders",{order_id:"eq."+orderId,select:"order_code,is_guest"});
  const cancelBase = order?.is_guest ? "/checkout/guest?order="+encodeURIComponent(asString(order.order_code)) : "/account/orders/"+orderId;
  const cancelUrl = origin + cancelBase + (cancelBase.includes("?") ? "&" : "?") + "stripe=cancel";
  const body = new URLSearchParams({
    mode: "payment",
    // Thanh toán lại từ trang đơn thì quay về chính trang đơn, không về luồng checkout
    // (trang xác nhận checkout không có dữ liệu của đơn cũ).
    success_url: successUrl,
    cancel_url: cancelUrl,
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
    throw new HttpError(502, "STRIPE_INTENT_FAILED", "Stripe không tạo được trang thanh toán.", undefined, { http_status: response.status, provider_message: payload.error?.message });
  }
  try {
    await insertRow("payment", {
      order_id: orderId,
      payment_method: "ONLINE_PAYMENT",
      payment_provider: "stripe",
      amount: charge,
      payment_status: "pending",
      payment_channel: "stripe",
      gateway_session_id: payload.id,
      gateway_transaction_ref: payload.id
    });
  } catch (error: unknown) {
    // Chỉ mục `payment_one_open_stripe_session`: đơn đã có một phiên đang mở. Không trả
    // đường dẫn của phiên vừa tạo, để khách không thể trả tiền hai lần.
    if (error instanceof HttpError && asString(asJsonObject(error.details).code) === "23505") {
      throw new HttpError(409, "PAYMENT_SESSION_OPEN", "Phiên thanh toán trước vẫn còn mở. Hoàn tất ở tab đó hoặc thử lại sau ít phút.");
    }
    throw error;
  }
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
 * Ghi tiền về cho đúng một payment.
 *
 * - Có mã phiên (`checkout.session.completed`): chỉ đổi payment của phiên đó. Nhận cả
 *   payment đã bị đóng `failed`, vì tiền đã về thật thì phải ghi nhận.
 * - Chỉ có PaymentIntent: chỉ đổi khi đơn có đúng một payment `pending`; nhiều hơn thì chờ
 *   sự kiện có mã phiên, không đoán.
 */
async function markOneStripePaymentPaid(orderId: string, patch: JsonObject, sessionId: string | null): Promise<JsonObject | null> {
  if (sessionId) {
    const changed = await updateRows("payment", {
      order_id: `eq.${orderId}`,
      payment_provider: "eq.stripe",
      gateway_transaction_ref: `eq.${sessionId}`,
      payment_status: "in.(pending,failed)"
    }, patch);
    return (changed[0] as JsonObject | undefined) ?? null;
  }
  const { rows } = await selectRows("payment", {
    order_id: `eq.${orderId}`,
    payment_provider: "eq.stripe",
    payment_status: "eq.pending",
    gateway_transaction_ref: `eq.${asString(patch.gateway_transaction_ref)}`,
    select: "payment_id"
  });
  if (rows.length !== 1) return null;
  const changed = await updateRows("payment", {
    payment_id: `eq.${asString(rows[0].payment_id)}`,
    payment_status: "eq.pending"
  }, patch);
  return (changed[0] as JsonObject | undefined) ?? null;
}

/**
 * Đóng payment Stripe của một phiên thanh toán đã kết thúc mà không thu được tiền.
 *
 * Enum `payment_status` không có `expired` hay `cancelled`, nên ghi `failed` và để lý
 * do thật ở `gateway_response_code`. Chỉ đổi khi chính lần gọi này đổi được payment khỏi
 * `pending`, nên webhook gửi lại hai lần cũng chỉ ghi một lần (U1-20).
 *
 * Không đổi trạng thái đơn và không trả lượt mã: theo OPEN-05 đơn vẫn Chờ thanh toán,
 * khách còn thanh toán lại được trong 24 giờ với đúng mức giảm đã thấy. Lượt mã được trả
 * khi đơn thật sự bị huỷ (trigger của migration 034), kể cả khi hệ thống tự huỷ lúc hết
 * 24 giờ.
 */
export async function closeStripePayment(
  orderId: string,
  reason: "checkout.session.expired" | "checkout.session.async_payment_failed" | "payment_intent.canceled",
  sessionId: string | null
): Promise<"closed" | "ignored"> {
  if (!sessionId) return "ignored"; // An unbound PaymentIntent cannot close another checkout attempt.
  const closed = await transitionPendingStripePayment(orderId, {
    payment_status: "failed",
    gateway_response_code: reason
  }, sessionId);
  return closed ? "closed" : "ignored";
}

/**
 * Ghi nhận tiền về cho một đơn, đúng một lần.
 *
 * - Đơn còn Chờ thanh toán: System chuyển sang Đã xác nhận và trừ kho trong cùng một
 *   giao dịch ở cơ sở dữ liệu (action `payment_succeeded`, AC-07).
 * - Đơn đã bị huỷ trước khi tiền về (OPEN-05): không trừ kho, hoàn lại tiền ngay.
 *
 * Webhook gửi lại không làm gì thêm: chỉ lần cập nhật đổi được payment khỏi `pending` mới
 * đi tiếp.
 */
export async function markStripePaymentPaid(
  orderId: string,
  paymentIntentId: string,
  sessionId: string | null = null
): Promise<"paid" | "refunding" | "ignored"> {
  let paid = await markOneStripePaymentPaid(orderId, {
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    gateway_response_code: "succeeded",
    gateway_session_id: sessionId || undefined,
    gateway_transaction_ref: paymentIntentId
  }, sessionId);
  if (!paid) {
    const existing = await selectRows("payment", {
      order_id: `eq.${orderId}`,
      payment_provider: "eq.stripe",
      payment_status: "eq.paid",
      gateway_transaction_ref: "eq."+paymentIntentId,
      limit: 1
    });
    paid = existing.rows[0] || null;
    if (!paid) return "ignored";
  }

  const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,status" });
  const { rows: otherPaid } = await selectRows("payment", {
    order_id: `eq.${orderId}`,
    payment_provider: "eq.stripe",
    payment_status: "eq.paid",
    payment_id: `neq.${asString(paid.payment_id)}`,
    select: "payment_id",
    limit: 1
  });
  // Đơn đã huỷ, hoặc đơn đã được trả tiền bằng một payment khác: khoản này là thừa, hoàn lại.
  if (asString(order?.status) === "cancelled" || otherPaid.length > 0) {
    await updateRows("payment", { payment_id: `eq.${paid.payment_id}` }, {
      payment_status: "refund_pending",
      refund_amount: paid.amount,
      refund_reason: otherPaid.length > 0 ? "Khoản thanh toán trùng cho cùng một đơn" : "Tiền về sau khi đơn đã huỷ",
      gateway_response_code: "REFUND_REQUESTED"
    });
    await refundStripeOrder(orderId, {paymentId:asString(paid.payment_id)});
    return "refunding";
  }
  let orderStatus = asString(order?.status);
  if (orderStatus === "pending") {
    await updateRows("orders", { order_id: `eq.${orderId}`, status: "eq.pending" }, {
      status: "waiting_payment",
      updated_at: new Date().toISOString()
    });
    orderStatus = "waiting_payment";
  }
  if (orderStatus === "waiting_payment") {
    await callRpc("velura_order_service_action", {
      p_order_id: orderId,
      p_action: "payment_succeeded",
      p_actor_id: null,
      p_note: "Stripe xác nhận thanh toán thành công",
      p_payload: { payment_intent: paymentIntentId },
      p_expected_version: null
    });
  }
  return "paid";
}

/** Tuỳ chọn bổ sung cho yêu cầu hoàn tiền Stripe (số tiền hoàn một phần, lý do, fetch mock). */
export interface RefundStripeOptions {
  fetchImpl?: typeof fetch;
  amount?: number;
  reason?: string;
  /** Reserves one item's net paid amount after warehouse QA; requires returnItemId. */
  returnId?: string;
  /** Immutable item identity of the financial operation, independent of request version. */
  returnItemId?: string;
  expectedVersion?: number;
  /** Binds late or duplicate capture refunds to the exact ledger payment. */
  paymentId?:string;
}

/** Kết quả một lần yêu cầu hoàn tiền. `code` chỉ có khi lỗi có mã máy đọc được (vd. GATEWAY_REFUND_TIMEOUT). */
export interface RefundResult {
  status: "refunded" | "requested" | "failed" | "skipped";
  message?: string;
  code?: string;
}

/** Mã lỗi khi Stripe không phản hồi trong thời hạn; kết quả hoàn tiền chưa xác định. */
export const GATEWAY_REFUND_TIMEOUT = "GATEWAY_REFUND_TIMEOUT";
/**
 * Mã lỗi khi bước tra cứu trước khi hoàn (phiên Checkout `cs_…` hoặc danh sách hoàn tiền của
 * PaymentIntent) bị timeout, 429 hoặc 5xx. Chưa có lệnh hoàn nào được gửi tới Stripe nên thử lại
 * an toàn; khác hẳn {@link GATEWAY_REFUND_TIMEOUT}, nơi lệnh hoàn đã gửi mà chưa rõ kết quả.
 */
export const GATEWAY_REFUND_LOOKUP_UNAVAILABLE = "GATEWAY_REFUND_LOOKUP_UNAVAILABLE";
/** Mỗi lệnh gọi Stripe trong luồng hoàn tiền không được treo quá thời hạn này. */
const STRIPE_REFUND_TIMEOUT_MS = 15000;
const LOOKUP_UNAVAILABLE_MESSAGE = "Chưa tra cứu được giao dịch trên Stripe. Chưa có lệnh hoàn tiền nào được gửi, hãy thử lại sau ít phút.";

/** Kết quả tra cứu Stripe trước khi hoàn: có dữ liệu, tạm thời không tra được (thử lại), hoặc dữ liệu không hợp lệ. */
type StripeLookup<T> = { kind: "ok"; value: T } | { kind: "unavailable" } | { kind: "invalid"; message: string };

/** GET chỉ đọc nên mọi lỗi mạng, timeout, 429 và 5xx đều là "tạm thời không tra được"; 4xx khác là cố định. */
async function stripeGet(url: string, fetchImpl: typeof fetch): Promise<StripeLookup<JsonObject>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${config.stripeSecretKey}` },
      signal: AbortSignal.timeout(STRIPE_REFUND_TIMEOUT_MS)
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 429 || response.status >= 500) return { kind: "unavailable" };
  if (!response.ok) return { kind: "invalid", message: `Stripe trả trạng thái ${response.status}` };
  try {
    return { kind: "ok", value: asJsonObject(await response.json()) };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Payment cũ có thể còn lưu mã phiên Checkout (`cs_…`) thay vì PaymentIntent (`pi_…`), mà Stripe
 * chỉ hoàn tiền theo PaymentIntent. Hỏi Stripe lấy PaymentIntent của phiên rồi lưu lại để các lần
 * sau (webhook hoàn tiền tra theo `pi_`) khớp được. Phiên phải đã `paid` và, khi Stripe trả về,
 * metadata `order_id` phải khớp đơn đang hoàn. Timeout/429/5xx trả `unavailable` (chưa gửi gì
 * tới Stripe, thử lại được), không phải một lệnh hoàn "đang chờ".
 */
async function resolveStripePaymentIntent(orderId: string, payment: JsonObject, fetchImpl: typeof fetch): Promise<StripeLookup<string>> {
  const sessionId = asString(payment.gateway_transaction_ref);
  const lookup = await stripeGet(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, fetchImpl);
  if (lookup.kind !== "ok") return lookup;
  const body = lookup.value;
  if (asString(body.payment_status) !== "paid") {
    return { kind: "invalid", message: "Phiên thanh toán Stripe chưa ở trạng thái đã thanh toán" };
  }
  const sessionOrder = asString(asJsonObject(body.metadata).order_id) || asString(body.client_reference_id);
  if (sessionOrder && sessionOrder !== orderId) {
    return { kind: "invalid", message: "Phiên thanh toán Stripe không thuộc đơn hàng này" };
  }
  const raw = body.payment_intent;
  const intent = typeof raw === "string" ? raw : asString(asJsonObject(raw).id);
  if (!intent.startsWith("pi_")) return { kind: "invalid", message: "Thiếu mã PaymentIntent của giao dịch" };
  await updateRows("payment", {
    payment_id: `eq.${asString(payment.payment_id)}`,
    gateway_transaction_ref: `eq.${sessionId}`
  }, { gateway_transaction_ref: intent, gateway_session_id: asString(payment.gateway_session_id) || sessionId });
  return { kind: "ok", value: intent };
}

/**
 * Tìm lệnh hoàn đã tồn tại trên Stripe cho PaymentIntent trước khi tạo lệnh mới, để một lệnh đã
 * được Stripe nhận (mà phản hồi bị mất, kể cả quá hạn 24 giờ của idempotency key) không bị tạo lại.
 * Khớp theo `metadata.refund_id` (hoàn theo phần hàng) hoặc `metadata.refund_key` + số tiền
 * (hoàn cấp đơn). Lệnh hoàn cấp đơn cũ chưa có `refund_key` chỉ được nhận khi payment chưa ghi
 * khoản hoàn nào và số tiền khớp tuyệt đối.
 */
async function findExistingStripeRefund(
  intent: string, orderId: string, amount: number, refundKey: string, operation: JsonObject | null, payment: JsonObject, fetchImpl: typeof fetch
): Promise<StripeLookup<JsonObject | null>> {
  const lookup = await stripeGet(`https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(intent)}&limit=100`, fetchImpl);
  if (lookup.kind !== "ok") return lookup;
  const refunds = Array.isArray(lookup.value.data) ? lookup.value.data.map(asJsonObject) : [];
  const match = refunds.find((refund) => {
    const metadata = asJsonObject(refund.metadata);
    if (operation) return asString(metadata.refund_id) === asString(operation.refund_id);
    if (Number(refund.amount) !== amount || refund.status === "failed" || refund.status === "canceled") return false;
    if (asString(metadata.refund_key)) return asString(metadata.refund_key) === refundKey;
    return !metadata.refund_id && asString(metadata.order_id) === orderId && Number(payment.refunded_amount || 0) === 0;
  });
  return { kind: "ok", value: match ?? null };
}

/**
 * Hoàn tiền của payment Stripe cho một đơn hàng (hỗ trợ hoàn toàn bộ hoặc một phần).
 *
 * Return refunds reuse the durable refund_id for every retry, including ambiguous network
 * failures. A known provider refund is retrieved, never recreated. Only a matching Stripe
 * `succeeded` result completes the item; pending/unknown results retain the reservation.
 */
export async function refundStripeOrder(
  orderId: string,
  fetchImplOrOptions: typeof fetch | RefundStripeOptions = fetch
): Promise<RefundResult> {
  const fetchImpl = typeof fetchImplOrOptions === "function" ? fetchImplOrOptions : (fetchImplOrOptions?.fetchImpl ?? fetch);
  let refundAmount = typeof fetchImplOrOptions === "object" && typeof fetchImplOrOptions?.amount === "number"
    ? fetchImplOrOptions.amount
    : undefined;
  const reason = typeof fetchImplOrOptions === "object" && typeof fetchImplOrOptions?.reason === "string"
    ? fetchImplOrOptions.reason
    : undefined;

  const options = typeof fetchImplOrOptions === "object" ? fetchImplOrOptions : {};
  let operation: JsonObject | null = null;
  if (options.returnId) {
    if (!options.returnItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "A return item is required for a return refund");
    operation = asJsonObject(await callRpc("velura_prepare_return_refund", {
      p_return_id: options.returnId, p_order_id: orderId,
      p_expected_version: options.expectedVersion, p_return_item_id: options.returnItemId
    }));
    if (!operation.refund_id || operation.return_item_id !== options.returnItemId || operation.return_id !== options.returnId) {
      throw new HttpError(409, "REFUND_OPERATION_MISMATCH", "Refund operation does not match the return item");
    }
    if (operation.status === "succeeded") return { status: "refunded" };
    refundAmount = Number(operation.amount);
  }
  const payment = await selectOne("payment", {
    order_id: `eq.${orderId}`,
    ...(operation ? { payment_id: "eq." + asString(operation.payment_id) } : options.paymentId ? { payment_id: "eq." + options.paymentId } : {}),
    payment_provider: "eq.stripe",
    payment_status: "in.(paid,refund_pending)",
    order: "created_at.desc"
  });
  if (!payment) return { status: "skipped", message: "Không có payment Stripe nào chờ hoàn tiền" };

  // Nếu payment đang ở trạng thái 'paid', chuyển sang 'refund_pending' để ghi nhận tiến trình
  const remaining = Number(payment.amount) - Number(payment.refunded_amount || 0);
  if (refundAmount !== undefined && (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > remaining)) throw new HttpError(422,"INVALID_REFUND_AMOUNT","Refund exceeds the remaining captured balance");
  if (operation && operation.payment_id !== payment.payment_id) throw new HttpError(409,"PAYMENT_CHANGED","Refund payment changed");
  if (payment.payment_status === "paid") {
    await updateRows("payment", { payment_id: `eq.${payment.payment_id}` }, {
      payment_status: "refund_pending",
      refund_amount: refundAmount ?? payment.amount,
      refund_reason: reason || "Yêu cầu hoàn tiền từ quản trị viên / trả hàng",
      gateway_response_code: "REFUND_REQUESTED"
    });
  }

  let intent = asString(payment.gateway_transaction_ref);
  if (!config.stripeSecretKey) {
    await markRefundFailed(orderId, payment, "Chưa cấu hình STRIPE_SECRET_KEY");
    return { status: "failed", message: "Không gửi được yêu cầu hoàn tiền tới Stripe" };
  }
  /** Bước tra cứu chưa gửi gì tới Stripe: không đụng vào operation, thử lại an toàn. */
  const lookupUnavailable = async (): Promise<RefundResult> => {
    if (!operation) await markRefundFailed(orderId, payment, LOOKUP_UNAVAILABLE_MESSAGE);
    return { status: "failed", message: LOOKUP_UNAVAILABLE_MESSAGE, code: GATEWAY_REFUND_LOOKUP_UNAVAILABLE };
  };
  try {
    if (intent.startsWith("cs_")) {
      const resolved = await resolveStripePaymentIntent(orderId, payment, fetchImpl);
      if (resolved.kind === "unavailable") return await lookupUnavailable();
      if (resolved.kind === "invalid") {
        await markRefundFailed(orderId, payment, resolved.message);
        return { status: "failed", message: "Không gửi được yêu cầu hoàn tiền tới Stripe" };
      }
      intent = resolved.value;
    }
    if (!intent.startsWith("pi_")) {
      await markRefundFailed(orderId, payment, "Thiếu mã PaymentIntent của giao dịch");
      return { status: "failed", message: "Không gửi được yêu cầu hoàn tiền tới Stripe" };
    }
    const expectedAmount = refundAmount ?? Number(payment.amount);
    // Stable across retry_refund: it changes only when the captured/refunded ledger moves, never with payment.version.
    const refundKey = `refund-${asString(payment.payment_id)}-${expectedAmount}-${Number(payment.refunded_amount || 0)}`;
    const params = new URLSearchParams({ payment_intent: intent, "metadata[order_id]": orderId });
    if (refundAmount !== undefined) params.append("amount", String(refundAmount));
    if (operation) {
      params.append("metadata[return_id]", asString(operation.return_id));
      params.append("metadata[return_item_id]", asString(operation.return_item_id));
      params.append("metadata[refund_id]", asString(operation.refund_id));
    } else {
      params.append("metadata[refund_key]", refundKey);
    }
    const providerRef = asString(operation?.provider_ref);
    // An unknown earlier POST may already exist at Stripe (even beyond the 24h idempotency window): adopt it.
    let adopted: JsonObject | null = null;
    if (!providerRef) {
      const existing = await findExistingStripeRefund(intent, orderId, expectedAmount, refundKey, operation, payment, fetchImpl);
      if (existing.kind === "unavailable") return await lookupUnavailable();
      if (existing.kind === "invalid") {
        await markRefundFailed(orderId, payment, existing.message);
        return { status: "failed", message: "Không gửi được yêu cầu hoàn tiền tới Stripe" };
      }
      adopted = existing.value;
    }
    let ok = true;
    let httpStatus = 200;
    let body: JsonObject;
    if (adopted) {
      body = adopted;
    } else {
      const response = await fetchImpl(providerRef
        ? `https://api.stripe.com/v1/refunds/${encodeURIComponent(providerRef)}`
        : "https://api.stripe.com/v1/refunds", {
        method: providerRef ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${config.stripeSecretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": operation ? `return-refund-${asString(operation.refund_id)}` : refundKey
        },
        ...(providerRef ? {} : { body: params }),
        signal: AbortSignal.timeout(STRIPE_REFUND_TIMEOUT_MS)
      });
      ok = response.ok;
      httpStatus = response.status;
      body = asJsonObject(await response.json());
    }
    const refundId = asString(body.id);
    if (!ok) {
      const message = asString(asJsonObject(body.error).message) || `Stripe trả trạng thái ${httpStatus}`;
      // A timeout, rate limit or server failure cannot prove Stripe did not move money.
      if (operation && (providerRef || httpStatus >= 500 || httpStatus === 409 || httpStatus === 429)) {
        return { status: "requested", message };
      }
      if (operation) await updateReturnRefundOperation(operation, { status: "failed" });
      await markRefundFailed(orderId, payment, message);
      return { status: "failed", message };
    }
    if (!refundId || (providerRef && providerRef !== refundId) ||
      !Number.isSafeInteger(body.amount) || Number(body.amount) !== (refundAmount ?? Number(payment.amount))) {
      return { status: "requested", message: "Chưa xác minh được kết quả hoàn tiền Stripe" };
    }
    if (operation) {
      const changed = await updateReturnRefundOperation(operation, { status: "pending", provider_ref: refundId });
      if (!changed.length) {
        const current = await selectOne("payment_refund", { refund_id: "eq." + asString(operation.refund_id), return_item_id: "eq." + asString(operation.return_item_id) });
        if (current?.status === "succeeded" && current.provider_ref === refundId) return { status: "refunded" };
        return { status: "requested", message: "Đang đối soát giao dịch hoàn tiền" };
      }
    }
    if (body.status === "failed" || body.status === "canceled") {
      if (operation) await updateReturnRefundOperation(operation, { status: "failed", provider_ref: refundId });
      await markRefundFailed(orderId, payment, `Stripe trả trạng thái ${asString(body.status)}`);
      return { status: "failed", message: "Stripe từ chối hoàn tiền" };
    }
    if (body.status === "succeeded") {
      if (operation) {
        await completeReturnRefund(operation, refundId);
      } else {
        await completeRefund(asString(payment.payment_id), orderId, refundAmount ?? Number(payment.amount), refundId);
      }
      return { status: "refunded" };
    }
    await insertRow("order_event", {
      order_id: orderId, action: "stripe_refund_requested", actor_type: "system", result: "success",
      note: "Yêu cầu hoàn tiền Stripe đã được gửi, đang chờ xử lý từ cổng thanh toán",
      payload: { payment_id: payment.payment_id, payment_intent: intent, stripe_refund_id: refundId,
        amount: refundAmount ?? payment.amount, return_item_id: options.returnItemId }
    });
    return { status: "requested" };
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      // Stripe may still have executed the refund; the idempotency key makes a retry safe.
      const message = "Cổng thanh toán phản hồi quá chậm. Lệnh hoàn tiền chưa được xác nhận, hãy thử lại sau ít phút.";
      if (operation) return { status: "requested", message, code: GATEWAY_REFUND_TIMEOUT };
      await markRefundFailed(orderId, payment, message);
      return { status: "failed", message, code: GATEWAY_REFUND_TIMEOUT };
    }
    // Stripe may have accepted the request before the connection or local completion failed.
    if (operation) return { status: "requested", message: "Đang chờ đối soát kết quả hoàn tiền Stripe" };
    await markRefundFailed(orderId, payment, errorMessage(error));
    return { status: "failed", message: "Không kết nối được Stripe" };
  }
}

/** Reconciles only exact succeeded item operations; charge totals remain for non-return refunds. */
export async function markStripeRefunded(paymentIntentId: string, amount?: number, refunds: JsonObject[] = []): Promise<"refunded" | "ignored"> {
  let payment = await selectOne("payment", { gateway_transaction_ref: "eq." + paymentIntentId, payment_provider: "eq.stripe" });
  if (!payment) return "ignored";
  let completed = false;
  for (const refund of refunds) {
    const providerRef = asString(refund.id);
    if (["failed", "canceled"].includes(asString(refund.status)) && providerRef) {
      const metadata = asJsonObject(refund.metadata);
      const operation = await selectOne("payment_refund", { provider_ref: "eq." + providerRef, payment_id: "eq." + asString(payment.payment_id) })
        || (metadata.refund_id ? await selectOne("payment_refund", {
          refund_id: "eq." + asString(metadata.refund_id), payment_id: "eq." + asString(payment.payment_id)
        }) : null);
      // Item refunds stay REFUND_PENDING for an explicit support retry; request-level refunds
      // return to paid so the admin retry_refund action can run with a fresh provider attempt.
      if (operation?.return_item_id) continue;
      const changed = await updateRows("payment", {
        payment_id: "eq." + asString(payment.payment_id),
        payment_status: "eq.refund_pending"
      }, {
        payment_status: "paid",
        gateway_response_code: "REFUND_FAILED"
      });
      if (changed.length) {
        await insertRow("order_event", {
          order_id: asString(payment.order_id),
          action: "refund_failed",
          actor_type: "system",
          result: "failed",
          note: "Stripe báo hoàn tiền thất bại; đơn trở lại trạng thái đã thanh toán để xử lý lại",
          payload: { payment_id: payment.payment_id, stripe_refund_id: providerRef }
        });
      }
      continue;
    }
    if (refund.status !== "succeeded" || !providerRef || !Number.isSafeInteger(refund.amount) || Number(refund.amount) <= 0) continue;
    const metadata = asJsonObject(refund.metadata);
    let operation = await selectOne("payment_refund", { provider_ref: "eq." + providerRef, payment_id: "eq." + asString(payment.payment_id) });
    // An immediate webhook can precede persistence of the POST response. Stripe's signed
    // metadata binds this race to the original reserved operation, never a request header.
    if (!operation && metadata.refund_id && metadata.return_item_id && metadata.return_id) {
      operation = await selectOne("payment_refund", {
        refund_id: "eq." + asString(metadata.refund_id), payment_id: "eq." + asString(payment.payment_id),
        return_item_id: "eq." + asString(metadata.return_item_id), return_id: "eq." + asString(metadata.return_id)
      });
    }
    if (!operation?.return_item_id || operation.status === "succeeded" ||
      (operation.provider_ref && operation.provider_ref !== providerRef) || Number(operation.amount) !== Number(refund.amount)) continue;
    const changed = await updateReturnRefundOperation(operation, { status: "pending", provider_ref: providerRef });
    if (!changed.length) continue;
    await completeReturnRefund(operation, providerRef);
    completed = true;
  }
  // Item RPCs own their cumulative ledger atomically. Applying a charge total before a
  // delayed item's RPC would count that refund twice.
  const { rows: operations } = await selectRows("payment_refund", { payment_id: "eq." + asString(payment.payment_id) });
  if (operations.length) return completed ? "refunded" : "ignored";
  if (!Number.isSafeInteger(amount) || Number(amount) <= 0 || Number(amount) > Number(payment.amount)) return "ignored";
  payment = await selectOne("payment", { payment_id: "eq." + asString(payment.payment_id) });
  if (!payment || Number(amount) <= Number(payment.refunded_amount || 0)) return "ignored";
  const changed = await updateRows("payment", { payment_id: "eq." + asString(payment.payment_id), refunded_amount: "lt." + amount }, {
    refunded_amount: amount, payment_status: Number(amount) >= Number(payment.amount) ? "refunded" : "paid",
    refund_at: new Date().toISOString(), gateway_response_code: "REFUNDED"
  });
  return changed.length ? "refunded" : "ignored";
}

export async function updateReturnRefundOperation(operation: JsonObject, values: JsonObject): Promise<JsonObject[]> {
  const rows = await updateRows("payment_refund", {
    refund_id: "eq." + asString(operation.refund_id), return_item_id: "eq." + asString(operation.return_item_id),
    status: "in.(requested,pending,failed)",
    ...(values.provider_ref ? { or: `(provider_ref.is.null,provider_ref.eq.${asString(values.provider_ref)})` } : {})
  }, values);
  return rows.map(asJsonObject);
}

export async function completeReturnRefund(operation: JsonObject, providerRef: string, label: RefundGatewayLabel = "stripe"): Promise<void> {
  await callRpc("velura_complete_return_refund", {
    p_return_id: operation.return_id, p_provider_ref: providerRef, p_return_item_id: operation.return_item_id
  });
  void sendRefundSuccessEmail(asString(operation.return_id), { method: label, returnItemId: asString(operation.return_item_id) });
}

export async function completeRefund(paymentId: string, orderId?: string, amount?: number, providerRef?: string, label: RefundGatewayLabel = "stripe"): Promise<void> {
  await updateRows("payment", { payment_id: `eq.${paymentId}`, payment_status: "in.(paid,refund_pending)" }, {
    payment_status: "refunded",
    refunded_amount:amount,
    refund_at: new Date().toISOString(),
    gateway_response_code: "REFUNDED"
  });
  if (orderId) {
    await insertRow("order_event", {
      order_id: orderId,
      action: "stripe_refund_succeeded",
      actor_type: "system",
      result: "success",
      note: `${refundChannelName(label)} xác nhận hoàn tiền thành công (${Number(amount || 0).toLocaleString("vi-VN")} đ)`,
      payload: { payment_id: paymentId, provider_ref: providerRef, amount, gateway: label }
    });
    try {
      const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,user_id,order_code" });
      if (order?.user_id) {
        await createNotification(
          String(order.user_id),
          "refund_completed",
          `Đơn hàng #${order.order_code || orderId} đã được hoàn tiền`,
          `Số tiền ${Number(amount || 0).toLocaleString("vi-VN")} đ đã được hoàn thành công ${refundChannelText(label).toLowerCase()}.`,
          `/account/orders/${orderId}`
        );
      }
    } catch (err: unknown) {
      console.warn("[REFUND NOTIFICATION] Could not create refund notification:", errorMessage(err));
    }
  }
}

export async function markRefundFailed(orderId: string, payment: JsonObject, message: string): Promise<void> {
  await updateRows("payment", { payment_id: `eq.${asString(payment.payment_id)}` }, {
    gateway_response_code: "REFUND_FAILED"
  });
  await insertRow("order_event", {
    order_id: orderId,
    action: "refund_failed",
    actor_type: "system",
    result: "failed",
    note: message.slice(0, 500),
    payload: { payment_id: payment.payment_id }
  });
}
