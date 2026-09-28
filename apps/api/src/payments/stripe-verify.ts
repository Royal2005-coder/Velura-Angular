import { config } from "../config.js";
import { HttpError, readJson, sendJson } from "../http.js";
import { quotePostgrestValue, selectOne } from "../supabase.js";
import { asString, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";
import { closeStripePayment, markStripePaymentPaid } from "./stripe.js";
import { allowDevOtpBypass } from "../config.js";

/**
 * Direct Stripe Payment Verification Endpoint.
 * Allows Storefront and Admin Portal to actively verify a Stripe checkout session
 * or payment intent without waiting for webhooks.
 *
 * Route: `POST /api/user/payments/stripe/verify`
 * Or:    `GET /api/user/payments/stripe/verify?order_id=...&session_id=...`
 */
export async function handleStripeVerify(
  req: HttpRequest,
  res: HttpResponse,
  corsHeaders: HeaderMap
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let orderId = asString(url.searchParams.get("order_id") || url.searchParams.get("orderId"));
  let orderCode = asString(url.searchParams.get("order_code") || url.searchParams.get("code"));
  let sessionId = asString(url.searchParams.get("session_id") || url.searchParams.get("sessionId"));
  let paymentIntentId = asString(url.searchParams.get("payment_intent_id") || url.searchParams.get("payment_intent"));

  if (req.method === "POST") {
    const body = await readJson(req);
    orderId = asString(body.order_id || body.orderId) || orderId;
    orderCode = asString(body.order_code || body.code) || orderCode;
    sessionId = asString(body.session_id || body.sessionId) || sessionId;
    paymentIntentId = asString(body.payment_intent_id || body.payment_intent) || paymentIntentId;
  }

  // 1. Locate the order
  let order: JsonObject | null = null;
  if (orderId) {
    order = await selectOne("orders", { order_id: `eq.${orderId}` });
  } else if (orderCode) {
    order = await selectOne("orders", { order_code: `eq.${quotePostgrestValue(orderCode.toUpperCase())}` });
  } else if (sessionId) {
    const payRow = await selectOne("payment", { gateway_transaction_ref: `eq.${sessionId}` });
    if (payRow?.order_id) {
      order = await selectOne("orders", { order_id: `eq.${payRow.order_id}` });
    }
  } else if (paymentIntentId) {
    const payRow = await selectOne("payment", { gateway_transaction_ref: `eq.${paymentIntentId}` });
    if (payRow?.order_id) {
      order = await selectOne("orders", { order_id: `eq.${payRow.order_id}` });
    }
  }

  if (!order) {
    throw new HttpError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng cần xác thực thanh toán.");
  }

  const currentOrderId = asString(order.order_id);
  const currentOrderCode = asString(order.order_code);

  // 2. Check if order is already marked confirmed/paid
  if (order.status !== "waiting_payment" && order.status !== "pending") {
    sendJson(res, 200, {
      success: true,
      paid: true,
      status: "paid",
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Đơn hàng đã được ghi nhận thanh toán thành công."
    }, corsHeaders);
    return;
  }

  // 3. Locate pending payment record
  const payment = await selectOne("payment", {
    order_id: `eq.${currentOrderId}`,
    payment_provider: "eq.stripe"
  });

  if (payment && payment.payment_status === "paid") {
    sendJson(res, 200, {
      success: true,
      paid: true,
      status: "paid",
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Thanh toán Stripe đã hoàn tất."
    }, corsHeaders);
    return;
  }

  const targetSessionId = sessionId || (payment?.gateway_transaction_ref?.toString().startsWith("cs_") ? asString(payment.gateway_transaction_ref) : "");
  const targetIntentId = paymentIntentId || (payment?.gateway_transaction_ref?.toString().startsWith("pi_") ? asString(payment.gateway_transaction_ref) : "");

  // 4. If Stripe secret key is configured, verify directly with Stripe API
  if (config.stripeSecretKey) {
    if (targetSessionId) {
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${targetSessionId}`, {
          headers: { authorization: `Bearer ${config.stripeSecretKey}` }
        });

        if (stripeRes.ok) {
          const session = await stripeRes.json() as {
            payment_status?: string;
            status?: string;
            payment_intent?: string | { id?: string };
          };

          if (session.payment_status === "paid") {
            const rawIntent = session.payment_intent;
            const intent = typeof rawIntent === "string" ? rawIntent : (rawIntent?.id || targetSessionId);
            await markStripePaymentPaid(currentOrderId, intent, targetSessionId);

            sendJson(res, 200, {
              success: true,
              paid: true,
              status: "paid",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Xác thực Stripe thành công! Đơn hàng đã chuyển sang trạng thái đã thanh toán."
            }, corsHeaders);
            return;
          }

          if (session.status === "expired") {
            await closeStripePayment(currentOrderId, "checkout.session.expired", targetSessionId);
            sendJson(res, 200, {
              success: true,
              paid: false,
              status: "expired",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Phiên thanh toán Stripe đã hết hạn."
            }, corsHeaders);
            return;
          }
        }
      } catch (err: unknown) {
        console.error("[STRIPE VERIFY SESSION ERROR]", err);
      }
    }

    if (targetIntentId) {
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${targetIntentId}`, {
          headers: { authorization: `Bearer ${config.stripeSecretKey}` }
        });

        if (stripeRes.ok) {
          const pi = await stripeRes.json() as { status?: string };
          if (pi.status === "succeeded") {
            await markStripePaymentPaid(currentOrderId, targetIntentId, null);

            sendJson(res, 200, {
              success: true,
              paid: true,
              status: "paid",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Xác thực Stripe thành công! Đơn hàng đã chuyển sang trạng thái đã thanh toán."
            }, corsHeaders);
            return;
          }
        }
      } catch (err: unknown) {
        console.error("[STRIPE VERIFY INTENT ERROR]", err);
      }
    }
  } else if (allowDevOtpBypass() && order.status === "waiting_payment") {
    // In dev mode when Stripe sandbox key is omitted, allow verification simulation
    await markStripePaymentPaid(currentOrderId, `pi_dev_${Date.now()}`, targetSessionId || null);
    sendJson(res, 200, {
      success: true,
      paid: true,
      status: "paid",
      simulated: true,
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Xác thực Stripe thành công (Dev Mode)."
    }, corsHeaders);
    return;
  }

  // Still pending
  sendJson(res, 200, {
    success: true,
    paid: false,
    status: payment?.payment_status || "pending",
    order_id: currentOrderId,
    order_code: currentOrderCode,
    message: "Giao dịch Stripe đang chờ thanh toán."
  }, corsHeaders);
}
