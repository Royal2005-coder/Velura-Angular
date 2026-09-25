import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc, insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, errorMessage, type JsonObject } from "../types.js";

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
    reason: "checkout.session.expired" | "payment_intent.canceled";
    /** Mã phiên Checkout khi sự kiện mang theo, để chỉ đóng đúng phiên đó. */
    sessionId: string | null;
  }
  | { kind: "refunded"; paymentIntentId: string }
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
  if (type === "charge.refunded") {
    const intent = object?.payment_intent;
    const paymentIntentId = typeof intent === "string" ? intent : (intent as JsonObject | undefined)?.id;
    return typeof paymentIntentId === "string" && paymentIntentId
      ? { kind: "refunded", paymentIntentId }
      : { kind: "ignore", reason: "missing_payment_intent" };
  }

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
    const sessionId = type === "checkout.session.completed" && typeof object?.id === "string" ? object.id : null;
    return { kind: "paid", orderId, paymentIntentId, sessionId };
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
  const body = new URLSearchParams({
    mode: "payment",
    // Thanh toán lại từ trang đơn thì quay về chính trang đơn, không về luồng checkout
    // (trang xác nhận checkout không có dữ liệu của đơn cũ).
    success_url: `${origin}${returnPath ?? "/checkout/confirm"}?stripe=success`,
    cancel_url: `${origin}${returnPath ?? "/checkout/shipping"}?stripe=cancel`,
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
  try {
    await insertRow("payment", {
      order_id: orderId,
      payment_method: "ONLINE_PAYMENT",
      payment_provider: "stripe",
      amount: charge,
      payment_status: "pending",
      payment_channel: "stripe",
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
  reason: "checkout.session.expired" | "payment_intent.canceled",
  sessionId: string | null
): Promise<"closed" | "ignored"> {
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
  const paid = await markOneStripePaymentPaid(orderId, {
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    gateway_response_code: "succeeded",
    gateway_transaction_ref: paymentIntentId
  }, sessionId);
  if (!paid) {
    const existing = await selectRows("payment", {
      order_id: `eq.${orderId}`,
      payment_provider: "eq.stripe",
      payment_status: "eq.paid",
      limit: 1
    });
    return existing.rows[0] ? "paid" : "ignored";
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
    await refundStripeOrder(orderId);
    return "refunding";
  }
  if (asString(order?.status) === "waiting_payment") {
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
}

/** Kết quả một lần yêu cầu hoàn tiền. */
export interface RefundResult {
  status: "refunded" | "requested" | "failed" | "skipped";
  message?: string;
}

/**
 * Hoàn tiền của payment Stripe cho một đơn hàng (hỗ trợ hoàn toàn bộ hoặc một phần).
 *
 * Idempotency key gắn với payment và phiên bản của nó: gọi lại vì mạng chập chờn thì
 * Stripe trả lại đúng kết quả cũ, còn "Thử hoàn tiền lại" sau khi lỗi (payment đã tăng
 * phiên bản) là một yêu cầu mới. Stripe từ chối thì payment giữ `refund_pending` và mang
 * dấu `REFUND_FAILED` để admin thấy và thử lại (OPEN-02).
 */
export async function refundStripeOrder(
  orderId: string,
  fetchImplOrOptions: typeof fetch | RefundStripeOptions = fetch
): Promise<RefundResult> {
  const fetchImpl = typeof fetchImplOrOptions === "function" ? fetchImplOrOptions : (fetchImplOrOptions?.fetchImpl ?? fetch);
  const refundAmount = typeof fetchImplOrOptions === "object" && typeof fetchImplOrOptions?.amount === "number"
    ? fetchImplOrOptions.amount
    : undefined;
  const reason = typeof fetchImplOrOptions === "object" && typeof fetchImplOrOptions?.reason === "string"
    ? fetchImplOrOptions.reason
    : undefined;

  const payment = await selectOne("payment", {
    order_id: `eq.${orderId}`,
    payment_provider: "eq.stripe",
    payment_status: "in.(paid,refund_pending)",
    order: "created_at.desc"
  });
  if (!payment) return { status: "skipped", message: "Không có payment Stripe nào chờ hoàn tiền" };

  // Nếu payment đang ở trạng thái 'paid', chuyển sang 'refund_pending' để ghi nhận tiến trình
  if (payment.payment_status === "paid") {
    await updateRows("payment", { payment_id: `eq.${payment.payment_id}` }, {
      payment_status: "refund_pending",
      refund_amount: refundAmount ?? payment.amount,
      refund_reason: reason || "Yêu cầu hoàn tiền từ quản trị viên / trả hàng",
      gateway_response_code: "REFUND_REQUESTED"
    });
  }

  const intent = asString(payment.gateway_transaction_ref);
  if (!config.stripeSecretKey || !intent.startsWith("pi_")) {
    await markRefundFailed(orderId, payment, !config.stripeSecretKey ? "Chưa cấu hình STRIPE_SECRET_KEY" : "Thiếu mã PaymentIntent của giao dịch");
    return { status: "failed", message: "Không gửi được yêu cầu hoàn tiền tới Stripe" };
  }
  try {
    const params = new URLSearchParams({ payment_intent: intent, "metadata[order_id]": orderId });
    if (refundAmount && refundAmount > 0 && refundAmount < Number(payment.amount)) {
      params.append("amount", String(Math.round(refundAmount)));
    }
    const response = await fetchImpl("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `refund-${asString(payment.payment_id)}-${String(payment.version ?? 1)}`
      },
      body: params
    });
    const body = await response.json() as { id?: string; status?: string; error?: { message?: string } };
    if (!response.ok || !body.id || body.status === "failed" || body.status === "canceled") {
      await markRefundFailed(orderId, payment, body.error?.message || `Stripe trả trạng thái ${body.status || response.status}`);
      return { status: "failed", message: body.error?.message || "Stripe từ chối hoàn tiền" };
    }
    if (body.status === "succeeded") {
      await completeRefund(asString(payment.payment_id), orderId, refundAmount ?? Number(payment.amount), body.id);
      return { status: "refunded" };
    }
    // `pending`: Stripe xử lý bất đồng bộ, webhook `charge.refunded` sẽ chốt.
    await insertRow("order_event", {
      order_id: orderId,
      action: "stripe_refund_requested",
      actor_type: "system",
      result: "success",
      note: "Yêu cầu hoàn tiền Stripe đã được gửi, đang chờ xử lý từ cổng thanh toán",
      payload: { payment_id: payment.payment_id, payment_intent: intent, stripe_refund_id: body.id, amount: refundAmount ?? payment.amount }
    });
    return { status: "requested" };
  } catch (error: unknown) {
    await markRefundFailed(orderId, payment, errorMessage(error));
    return { status: "failed", message: "Không kết nối được Stripe" };
  }
}

/** Webhook `charge.refunded`: chốt payment đang chờ hoàn thành Đã hoàn tiền, một lần. */
export async function markStripeRefunded(paymentIntentId: string): Promise<"refunded" | "ignored"> {
  const changed = await updateRows("payment", {
    gateway_transaction_ref: `eq.${paymentIntentId}`,
    payment_provider: "eq.stripe",
    payment_status: "in.(paid,refund_pending)"
  }, {
    payment_status: "refunded",
    refund_at: new Date().toISOString(),
    gateway_response_code: "REFUNDED"
  });
  if (changed.length) {
    const payment = asJsonObject(changed[0]);
    const orderId = asString(payment.order_id);
    if (orderId) {
      await insertRow("order_event", {
        order_id: orderId,
        action: "stripe_refund_succeeded",
        actor_type: "system",
        result: "success",
        note: "Stripe xác nhận hoàn tiền thành công (webhook)",
        payload: { payment_id: payment.payment_id, payment_intent: paymentIntentId, amount: payment.amount }
      });
      try {
        const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,user_id,order_code" });
        if (order?.user_id) {
          await insertRow("notification", {
            user_id: order.user_id,
            type: "order_status",
            title: `Đơn hàng #${order.order_code || orderId} đã được hoàn tiền`,
            content: "Cổng Stripe đã xác nhận hoàn tiền thành công về tài khoản thẻ của bạn.",
            link: `/account/orders/${orderId}`,
            is_read: false
          });
        }
      } catch (err: unknown) {
        console.warn("[STRIPE WEBHOOK NOTIFICATION] Failed to create notification:", errorMessage(err));
      }
    }
    return "refunded";
  }
  return "ignored";
}

async function completeRefund(paymentId: string, orderId?: string, amount?: number, stripeRefundId?: string): Promise<void> {
  await updateRows("payment", { payment_id: `eq.${paymentId}`, payment_status: "in.(paid,refund_pending)" }, {
    payment_status: "refunded",
    refund_at: new Date().toISOString(),
    gateway_response_code: "REFUNDED"
  });
  if (orderId) {
    await insertRow("order_event", {
      order_id: orderId,
      action: "stripe_refund_succeeded",
      actor_type: "system",
      result: "success",
      note: `Stripe xác nhận hoàn tiền thành công (${Number(amount || 0).toLocaleString("vi-VN")} đ)`,
      payload: { payment_id: paymentId, stripe_refund_id: stripeRefundId, amount }
    });
    try {
      const order = await selectOne("orders", { order_id: `eq.${orderId}`, select: "order_id,user_id,order_code" });
      if (order?.user_id) {
        await insertRow("notification", {
          user_id: order.user_id,
          type: "order_status",
          title: `Đơn hàng #${order.order_code || orderId} đã được hoàn tiền`,
          content: `Số tiền ${Number(amount || 0).toLocaleString("vi-VN")} đ đã được hoàn thành công về phương thức thanh toán ban đầu qua Stripe.`,
          link: `/account/orders/${orderId}`,
          is_read: false
        });
      }
    } catch (err: unknown) {
      console.warn("[STRIPE NOTIFICATION] Could not create refund notification:", errorMessage(err));
    }
  }
}

async function markRefundFailed(orderId: string, payment: JsonObject, message: string): Promise<void> {
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
