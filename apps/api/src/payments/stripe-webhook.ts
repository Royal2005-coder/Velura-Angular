import { config } from "../config.js";
import { HttpError, sendJson } from "../http.js";
import { markStripePaymentPaid, verifyStripeSignature } from "./stripe.js";
import type { HeaderMap, HttpRequest, HttpResponse, JsonObject } from "../types.js";

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
  if (event.type !== "payment_intent.succeeded" && event.type !== "checkout.session.completed") {
    sendJson(res, 200, { received: true, ignored: event.type || "unknown" }, corsHeaders);
    return;
  }
  const object = (event.data as JsonObject | undefined)?.object as JsonObject | undefined;
  const orderId = (object?.metadata as JsonObject | undefined)?.order_id;
  const rawIntent = event.type === "checkout.session.completed" ? object?.payment_intent : object?.id;
  const paymentIntentId = typeof rawIntent === "string" ? rawIntent : (rawIntent as JsonObject | undefined)?.id;
  if (typeof orderId !== "string" || typeof paymentIntentId !== "string") {
    sendJson(res, 200, { received: true, ignored: "missing_order" }, corsHeaders);
    return;
  }
  const result = await markStripePaymentPaid(orderId, paymentIntentId);
  sendJson(res, 200, { received: true, result }, corsHeaders);
}

async function readRawBody(req: HttpRequest): Promise<string> {
  const chunks: Buffer[] = [];
  const iterator = req[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    throw new HttpError(400, "BAD_REQUEST", "Webhook body is missing");
  }
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator.call(req) } as AsyncIterable<unknown>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}
