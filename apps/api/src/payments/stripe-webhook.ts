import { config } from "../config.js";
import { HttpError, sendJson } from "../http.js";
import { classifyStripeEvent, closeStripePayment, markStripePaymentPaid, markStripeRefunded, verifyStripeSignature } from "./stripe.js";
import type { HeaderMap, HttpRequest, HttpResponse, JsonObject } from "../types.js";
import { selectOne } from "../supabase.js";
import { asJsonObject } from "../types.js";

/**
 * Stripe CLI and live webhooks both post here.
 * Forward with `stripe listen --forward-to http://localhost:8787/api/user/payments/stripe/webhook`.
 */
export async function handleStripeWebhook(req: HttpRequest, res: HttpResponse, corsHeaders: HeaderMap): Promise<void> {
  if (req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only POST is accepted");
  }
  if (!config.stripeWebhookSecret) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_WEBHOOK_SECRET.");
  }
  const rawBody = await readRawBody(req);
  const signature = headerValue(req.headers["stripe-signature"]);
  if (!verifyStripeSignature(rawBody, signature, config.stripeWebhookSecret)) {
    throw new HttpError(400, "STRIPE_SIGNATURE_INVALID", "Chữ ký Stripe không hợp lệ.");
  }
  const event = JSON.parse(rawBody) as JsonObject;
  const action = classifyStripeEvent(event);
  if (action.kind === "ignore") {
    sendJson(res, 200, { received: true, ignored: action.reason }, corsHeaders);
    return;
  }
  if (action.kind === "paid") {
    const object = asJsonObject(asJsonObject(event.data).object);
    const order = await selectOne("orders", {order_id:`eq.${action.orderId}`,select:"total_amount"});
    const amount = event.type === "payment_intent.succeeded" ? object.amount_received : object.amount_total;
    if (!order || object.currency !== "vnd" || !Number.isSafeInteger(Number(amount)) || Number(amount) !== Number(order.total_amount)) {
      throw new HttpError(422,"PAYMENT_AMOUNT_MISMATCH","Giao dịch không khớp số tiền hoặc tiền tệ của đơn hàng.");
    }
  }
  const result = action.kind === "paid"
    ? await markStripePaymentPaid(action.orderId, action.paymentIntentId, action.sessionId)
    : action.kind === "refunded"
      ? await markStripeRefunded(action.paymentIntentId,action.amount,action.refunds)
      : await closeStripePayment(action.orderId, action.reason, action.sessionId);
  sendJson(res, 200, { received: true, result }, corsHeaders);
}

async function readRawBody(req: HttpRequest): Promise<string> {
  const reqObj = req as { rawBody?: unknown; body?: unknown };
  if (typeof reqObj.rawBody === "string") return reqObj.rawBody;
  if (Buffer.isBuffer(reqObj.rawBody)) return reqObj.rawBody.toString("utf8");
  if (typeof reqObj.body === "string") return reqObj.body;
  if (Buffer.isBuffer(reqObj.body)) return reqObj.body.toString("utf8");
  if (typeof reqObj.body === "object" && reqObj.body !== null) {
    return JSON.stringify(reqObj.body);
  }

  const chunks: Buffer[] = [];
  const iterator = req[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    if (typeof reqObj.body === "object" && reqObj.body !== null) {
      return JSON.stringify(reqObj.body);
    }
    throw new HttpError(400, "BAD_REQUEST", "Webhook body is missing");
  }
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator.call(req) } as AsyncIterable<unknown>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk)));
  }
  const collected = Buffer.concat(chunks).toString("utf8");
  if (!collected && typeof reqObj.body === "object" && reqObj.body !== null) {
    return JSON.stringify(reqObj.body);
  }
  return collected;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}
