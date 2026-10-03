import { config, allowDevOtpBypass } from "../config.js";
import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows } from "../supabase.js";
import { asString, type HeaderMap, type HttpRequest, type HttpResponse, type JsonObject } from "../types.js";
import { closeStripePayment, markStripePaymentPaid } from "./stripe.js";

export interface StripeVerifyResult {
  success: boolean;
  paid: boolean;
  status: string;
  order_id: string;
  order_code: string;
  message: string;
  simulated?: boolean;
}

/**
 * Xác thực trạng thái giao dịch Stripe với cơ sở dữ liệu và Stripe API.
 * Hỗ trợ tra cứu bằng order_id (UUID), order_code (VLR...), session_id (cs_...) hoặc payment_intent (pi_...).
 * Nếu giao dịch đã thanh toán trên Stripe, hàm sẽ tự động cập nhật order sang 'confirmed' và payment sang 'paid'
 * theo đúng quy tắc AD_ORDER_07.
 */
export async function verifyStripeOrder(params: {
  orderId?: string;
  orderCode?: string;
  sessionId?: string;
  paymentIntentId?: string;
}): Promise<StripeVerifyResult> {
  const orderId = asString(params.orderId);
  const orderCode = asString(params.orderCode);
  const sessionId = asString(params.sessionId);
  const paymentIntentId = asString(params.paymentIntentId);

  // 1. Định vị đơn hàng
  let order: JsonObject | null = null;
  if (orderId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(orderId)) {
      order = await selectOne("orders", { order_id: `eq.${orderId}` });
    } else {
      order = await selectOne("orders", { order_code: `eq.${orderId.trim().toUpperCase()}` });
    }
  }
  if (!order && orderCode) {
    order = await selectOne("orders", { order_code: `eq.${orderCode.trim().toUpperCase()}` });
  }
  if (!order && sessionId) {
    const payRow = await selectOne("payment", { gateway_transaction_ref: `eq.${sessionId}` });
    if (payRow?.order_id) {
      order = await selectOne("orders", { order_id: `eq.${payRow.order_id}` });
    }
  }
  if (!order && paymentIntentId) {
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

  // 2. Nếu đơn đã ở trạng thái đã xác nhận trở lên (đã qua bước thanh toán)
  if (order.status !== "waiting_payment" && order.status !== "pending") {
    return {
      success: true,
      paid: true,
      status: "paid",
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Đơn hàng đã được ghi nhận thanh toán thành công."
    };
  }

  // 3. Tra cứu lịch sử payment của đơn
  const { rows: paymentRows } = await selectRows("payment", {
    order_id: `eq.${currentOrderId}`,
    payment_provider: "eq.stripe",
    order: "created_at.desc",
    limit: "5"
  }, { count: "none" });

  const paidPayment = paymentRows.find((p) => p.payment_status === "paid");
  if (paidPayment) {
    if (order.status === "waiting_payment") {
      try {
        await markStripePaymentPaid(
          currentOrderId,
          asString(paidPayment.gateway_transaction_ref) || "paid_existing",
          sessionId || null
        );
      } catch (err) {
        console.warn("[STRIPE SYNC ORDER CONFIRM]", err);
      }
    }
    return {
      success: true,
      paid: true,
      status: "paid",
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Thanh toán Stripe đã hoàn tất."
    };
  }

  const latestPayment = paymentRows[0];
  const targetSessionId = sessionId || (latestPayment?.gateway_transaction_ref?.toString().startsWith("cs_") ? asString(latestPayment.gateway_transaction_ref) : "");
  const targetIntentId = paymentIntentId || (latestPayment?.gateway_transaction_ref?.toString().startsWith("pi_") ? asString(latestPayment.gateway_transaction_ref) : "");

  // 4. Nếu cấu hình Stripe key, truy vấn trực tiếp Stripe API
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

            return {
              success: true,
              paid: true,
              status: "paid",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Xác thực Stripe thành công! Đơn hàng đã chuyển sang trạng thái đã thanh toán."
            };
          }

          if (session.status === "expired") {
            await closeStripePayment(currentOrderId, "checkout.session.expired", targetSessionId);
            return {
              success: true,
              paid: false,
              status: "expired",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Phiên thanh toán Stripe đã hết hạn."
            };
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

            return {
              success: true,
              paid: true,
              status: "paid",
              order_id: currentOrderId,
              order_code: currentOrderCode,
              message: "Xác thực Stripe thành công! Đơn hàng đã chuyển sang trạng thái đã thanh toán."
            };
          }
        }
      } catch (err: unknown) {
        console.error("[STRIPE VERIFY INTENT ERROR]", err);
      }
    }
  } else if (allowDevOtpBypass() && order.status === "waiting_payment") {
    // Trong môi trường dev không cấu hình key Stripe thật, cho phép giả lập xác thực
    await markStripePaymentPaid(currentOrderId, `pi_dev_${Date.now()}`, targetSessionId || null);
    return {
      success: true,
      paid: true,
      status: "paid",
      simulated: true,
      order_id: currentOrderId,
      order_code: currentOrderCode,
      message: "Xác thực Stripe thành công (Dev Mode)."
    };
  }

  return {
    success: true,
    paid: false,
    status: latestPayment?.payment_status ? asString(latestPayment.payment_status) : "pending",
    order_id: currentOrderId,
    order_code: currentOrderCode,
    message: "Giao dịch Stripe đang chờ thanh toán."
  };
}

/**
 * Direct Stripe Payment Verification HTTP Endpoint.
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

  const result = await verifyStripeOrder({ orderId, orderCode, sessionId, paymentIntentId });
  sendJson(res, 200, result, corsHeaders);
}
