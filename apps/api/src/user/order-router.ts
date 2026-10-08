import { randomUUID } from "node:crypto";
import { HttpError, readJson, sendJson } from "../http.js";
import { callRpc, quotePostgrestValue, selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth, validatePhone } from "./auth.js";
import { createNotification } from "./notifications.js";
import { config } from "../config.js";
import { verifyStripeOrder } from "../payments/stripe-verify.js";
import { maybeRunAutomation } from "../orders/order-service.js";
import { maskEmail, sendDirectEmail } from "../email/mailer.js";
export { maskEmail } from "../email/mailer.js";
import { sendGuestTrackingOtp, verifyGuestTrackingOtp } from "./guest-order-session.js";
import { customerPaymentFacts } from "./order-payment-presentation.js";
import { issueGuestOrderAccess, guestSessionPhone, requireCustomerOrderAccess } from "./order-access.js";
import {
  type CheckoutOtpService,
  type CheckoutService,
  checkoutClientIp,
  checkoutPaymentState,
  normalizeVietnamesePhone,
  validateCheckoutContact
} from "./checkout-service.js";
import { loyaltyActor, readPoints } from "../loyalty/loyalty-service.js";
import { createStripePaymentIntent, refundStripeOrder, STRIPE_CHECKOUT_TTL_SECONDS, stripeConfigured } from "../payments/stripe.js";
import { assertLocalGatewayReady, openLocalGateway, type HostedPayment } from "../payments/local-gateways.js";
import { customerCanCancel, customerOrderSteps, orderFacts, orderStatusLabel } from "../orders/order-state-machine.js";
import { returnWindowOpen } from "./return-window.js";
import { OPEN_RETURN_STATUSES } from "../returns/return-constants.js";
import { cancelOrderForCustomer, createCustomerOrderCancelRepository } from "./order-cancel-service.js";
import { createUserReturnsRepository, type UserReturnsRepository } from "./returns-repository.js";
import {
  sendCheckoutOtpSms,
  sendGuestOrderWelcomeSms,
  sendOrderConfirmationSms,
  sendTwilioSms,
  maskPhone,
  isSmsConfigured
} from "../sms/twilio.js";
import {
  asJsonObject,
  asString,
  errorMessage,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject,
  type UserProfile
} from "../types.js";

/**
 * Chặn đọc một đơn hàng không thuộc về người đang đăng nhập.
 *
 * Điều kiện cũ là `order.user_id && profile && order.user_id !== profile.user_id`, tức
 * chỉ chặn khi cả ba vế cùng đúng. Người chưa đăng nhập không có `profile` nên không
 * bao giờ chạm tới nhánh chặn: ai biết mã vận đơn là đọc được họ tên, số điện thoại và
 * địa chỉ giao của khách. Mã vận đơn lại sinh bằng
 * `"VLR" + Date.now().toString().slice(-8)` — tám chữ số cuối của một mốc mili giây,
 * nên với một ngày đã biết thì dải cần dò rất hẹp.
 *
 * KAN-37 FR-01 chốt: chỉ trả về đơn thuộc về người đang đăng nhập. Tra cứu cho khách
 * vãng lai là tính năng riêng, phải xác thực bằng số điện thoại và OTP (KAN-37 FR-03
 * và bản chốt ngày 20/09) — không phải là để ngỏ tuyến này.
 */
export function assertOrderVisibleTo(order: JsonObject, profile: UserProfile | null): void {
  if (!profile) {
    throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc để xem đơn hàng");
  }
  // Cùng câu trả lời với mã đơn không tồn tại: không để lộ mã nào là mã thật.
  if (order.user_id !== profile.user_id) {
    throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Parse a Postgres timestamp as UTC, defaulting to now when empty.
 */
export function parseUtcDate(dateStr: unknown): Date {
  if (!dateStr) return new Date();
  const cleanStr = String(dateStr).replace(" ", "T");
  if (!cleanStr.endsWith("Z") && !/[+-]\d{2}(:\d{2})?$/.test(cleanStr)) {
    return new Date(cleanStr + "Z");
  }
  return new Date(cleanStr);
}

/**
 * Chuẩn hoá email nhận OTP của khách guest. Khi chưa cấu hình Twilio thì đây là kênh
 * duy nhất nên bắt buộc; khi đã có SMS, khách vẫn có thể chọn email nên email sai
 * định dạng vẫn phải bị từ chối.
 */
export function requireGuestOtpEmail(value: unknown): string {
  const email = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "EMAIL_REQUIRED", "Email không hợp lệ để nhận mã OTP. Vui lòng nhập lại email của bạn.");
  }
  return email;
}

/** Khách được thanh toán lại đơn online trong chừng này kể từ lúc tạo (KAN-59). */
const PAY_AGAIN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Còn phiên Stripe nào chưa hết hạn không. Phiên sống `STRIPE_CHECKOUT_TTL_SECONDS`; payment
 * `pending` cũ hơn thế là phiên đã chết mà webhook hết hạn chưa về, không chặn.
 */
export function hasOpenStripeSession(pendingPayments: JsonObject[], now = Date.now()): boolean {
  return pendingPayments.some((payment) =>
    now - parseUtcDate(payment.created_at).getTime() < STRIPE_CHECKOUT_TTL_SECONDS * 1000);
}

/**
 * Mã đơn cho khách. Ngẫu nhiên, không suy ra được từ thời điểm tạo: mã cũ
 * `"VLR" + 8 chữ số cuối của mốc mili giây` dò được trong một ngày đã biết (KAN-40).
 */
export function generateOrderCode(): string {
  return "VLR" + randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase();
}

/**
 * Hình dạng đơn trả cho storefront: nhãn, timeline và cờ huỷ đều lấy từ State Machine,
 * không để frontend tự định nghĩa lại (KAN-37, KAN-39).
 */
/**
 * Cột của đơn mà khách được thấy. Không trả nguyên dòng: `internal_note`, `ai_source`,
 * mốc kho và `version` là dữ liệu vận hành của admin.
 */
const CUSTOMER_ORDER_FIELDS = [
  "order_id", "order_code", "order_date", "created_at", "updated_at", "delivered_at", "status",
  "shipping_name", "shipping_phone", "shipping_address", "shipping_fee", "subtotal", "discount_amount",
  "total_amount", "payment_method", "voucher_id", "cancelled_reason", "tracking_code", "carrier", "tracking_url",
  "version"
] as const;

export function presentOrderForCustomer(order: JsonObject, items: JsonObject[], history: JsonObject[], payments: JsonObject[] = []): JsonObject {
  const facts = orderFacts({ ...order, payments });
  const createdAt = parseUtcDate(order.created_at).getTime();
  const timeline = [...history]
    .sort((a, b) => String(a.changed_at || "").localeCompare(String(b.changed_at || "")))
    .map((row) => ({
      status: row.new_status,
      label: orderStatusLabel(row.new_status),
      at: row.changed_at
    }));
  const visible: JsonObject = {};
  for (const field of CUSTOMER_ORDER_FIELDS) {
    if (field in order) visible[field] = order[field];
  }
  // Mã vận đơn chỉ có nghĩa khi vận đơn còn hiệu lực (FR-09: hiện khi có mã).
  if (order.shipment_voided_at) {
    visible.tracking_code = null;
    visible.tracking_url = null;
  }
  let canRequestReturn = false;
  if (order.status === "delivered") {
    let deliveredAt: Date | null = null;
    if (order.delivered_at) {
      deliveredAt = parseUtcDate(order.delivered_at);
    } else {
      const deliveredStep = timeline.find((t) => t.status === "delivered");
      if (deliveredStep?.at) {
        deliveredAt = parseUtcDate(deliveredStep.at);
      }
    }
    if (!deliveredAt) {
      deliveredAt = parseUtcDate(order.updated_at || order.created_at);
    }
    canRequestReturn = returnWindowOpen(deliveredAt, new Date());
  }
  return {
    ...visible,
    ...customerPaymentFacts(payments),
    items,
    status_label: orderStatusLabel(order.status),
    timeline,
    steps: customerOrderSteps(String(order.status || ""), String(order.payment_method || ""), timeline),
    can_cancel: customerCanCancel(facts),
    can_pay_again: order.status === "waiting_payment"
      && order.payment_method === "ONLINE_PAYMENT"
      && Date.now() - createdAt < PAY_AGAIN_WINDOW_MS,
    pay_again_until: order.status === "waiting_payment" ? new Date(createdAt + PAY_AGAIN_WINDOW_MS).toISOString() : null,
    can_request_return: canRequestReturn
  };
}

async function attachProductMeta(items: JsonObject[]): Promise<JsonObject[]> {
  if (!items.length) return [];
  const variantIds = Array.from(new Set(items.map(it => it.variant_id).filter(Boolean)));
  if (!variantIds.length) {
    return items.map(item => ({
      ...item,
      product_id: null,
      category_name: null,
      is_combo: Boolean(item.is_combo || /combo/i.test(String(item.product_name || "")) || /set\s+/i.test(String(item.product_name || ""))),
      size: item.size ?? null,
      color: item.color ?? null
    }));
  }

  const { rows: variants } = await selectRows("variant", { variant_id: `in.(${variantIds.join(",")})` });
  const variantMap = new Map(variants.map(v => [String(v.variant_id), v]));

  const productIds = Array.from(new Set(variants.map(v => v.product_id).filter(Boolean)));
  const { rows: products } = productIds.length ? await selectRows("product", { product_id: `in.(${productIds.join(",")})` }) : { rows: [] };
  const productMap = new Map(products.map(p => [String(p.product_id), p]));

  const categoryIds = Array.from(new Set(products.map(p => p.category_id).filter(Boolean)));
  const { rows: categories } = categoryIds.length ? await selectRows("category", { category_id: `in.(${categoryIds.join(",")})` }) : { rows: [] };
  const categoryMap = new Map(categories.map(c => [String(c.category_id), c]));

  return items.map((item) => {
    let productId: unknown = null;
    let categoryName: unknown = null;
    let size: unknown = item.size ?? null;
    let color: unknown = item.color ?? null;
    let isCombo = Boolean(item.is_combo || /combo/i.test(String(item.product_name || "")) || /set\s+/i.test(String(item.product_name || "")));
    if (item.variant_id) {
      const v = variantMap.get(String(item.variant_id));
      if (v) {
        productId = v.product_id;
        size = v.size ?? size;
        color = v.color ?? color;
        const product = productMap.get(String(productId));
        if (product) {
          isCombo = isCombo || Boolean(product.is_combo || /combo/i.test(String(product.name || "")) || /set\s+/i.test(String(product.name || "")));
          const cat = categoryMap.get(String(product.category_id));
          if (cat) {
            categoryName = cat.name;
          }
        }
      }
    }
    return { ...item, product_id: productId, category_name: categoryName, is_combo: isCombo, size, color };
  });
}

const userReturnsRepository = createUserReturnsRepository();

/**
 * Gắn `return_count` (số lần đổi/trả còn hiệu lực, trần U2-02 là 2) và `available_quantity`
 * (số lượng còn có thể chọn ở lần tiếp theo) vào từng dòng hàng của một đơn đã giao.
 *
 * Dùng lại đúng phép đếm "lượt + số lượng đã trả" trong `returns-service.ts` qua
 * `returns-repository.ts`, để trang khách hàng không tự tính một con số khác với con số
 * backend thật sự dùng để chặn ở `POST /api/user/returns`. Nhận repository qua tham số để
 * test được bằng repository giả, không cần DB thật.
 *
 * Nếu sản phẩm đang có yêu cầu đổi/trả nằm trong tiến trình (`OPEN_RETURN_STATUSES`),
 * sản phẩm đó bị khóa (`is_in_progress = true`, `available_quantity = 0`) để tránh tạo trùng lặp.
 */
export async function attachReturnEligibility(
  repository: UserReturnsRepository,
  orderId: unknown,
  items: JsonObject[]
): Promise<JsonObject[]> {
  const existingReturns = await repository.listReturnsForOrder(orderId);
  const result: JsonObject[] = [];
  for (const item of items) {
    let returnCount = 0;
    let returnedQuantity = 0;
    let isInProgress = false;
    let inProgressCode: string | null = null;
    let inProgressStatus: string | null = null;

    for (const ret of existingReturns) {
      const status = asString(ret.status);
      if (["CANCELLED", "REJECTED", "rejected"].includes(status)) continue;
      const rItems = await repository.listReturnItemsForOrderItem(ret.return_id, item.item_id);
      if (!rItems.length) continue;

      if (OPEN_RETURN_STATUSES.includes(status) || status === "pending") {
        isInProgress = true;
        inProgressCode = asString(ret.tracking_return_code || ret.return_id);
        inProgressStatus = status;
      }

      returnCount += 1;
      for (const ri of rItems) returnedQuantity += Number(ri.quantity);
    }
    const quantity = Number(item.quantity) || 0;
    const availableQuantity = isInProgress
      ? 0
      : Math.max(0, quantity - returnedQuantity);

    result.push({
      ...item,
      return_count: returnCount,
      available_quantity: availableQuantity,
      is_in_progress: isInProgress,
      in_progress_return_code: inProgressCode,
      in_progress_status: inProgressStatus
    });
  }
  return result;
}

/**
 * Định dạng ghi chú nội bộ cho đơn hàng từ các tùy chọn thông minh phong cách Coolmate
 * (Mã giới thiệu, quà tặng kèm lời chúc, người nhận thay thế, thông tin xuất hóa đơn VAT).
 */
export function formatOrderInternalNote(body: JsonObject, existingNote?: string): string {
  const parts: string[] = [];
  if (body.note) parts.push(`[Ghi chú khách]: ${String(body.note).trim()}`);
  if (body.referral_code) parts.push(`[Mã giới thiệu]: ${String(body.referral_code).trim()}`);
  if (body.payment_method && String(body.payment_method).toUpperCase() !== 'COD') {
    parts.push(`[Cổng thanh toán]: ${String(body.payment_method).toUpperCase()}`);
  }
  if (body.is_gift) {
    const gender = body.gift_gender === 'nu' ? 'Nữ' : 'Nam';
    const name = body.gift_name ? String(body.gift_name).trim() : 'Người nhận';
    const msg = body.gift_message ? ` - Lời chúc: "${String(body.gift_message).trim()}"` : '';
    parts.push(`[Quà tặng - Dành cho ${gender}]: ${name}${msg}`);
  }
  if (body.is_other_recipient && (body.other_name || body.other_phone)) {
    parts.push(`[Người nhận khác]: ${String(body.other_name || '').trim()} - SĐT: ${String(body.other_phone || '').trim()}`);
  }
  if (body.is_vat_invoice && body.vat_tax_code) {
    parts.push(`[Hóa đơn VAT]: Cty ${String(body.vat_company_name || '').trim()} | MST: ${String(body.vat_tax_code).trim()} | Đ/c: ${String(body.vat_company_address || '').trim()} | Email HĐ: ${String(body.vat_email || '').trim()}`);
  }
  if (Array.isArray(body.items)) {
    for (const it of body.items as JsonObject[]) {
      if (it.is_combo && Array.isArray(it.sub_items) && it.sub_items.length > 0) {
        const subDetails = (it.sub_items as JsonObject[]).map(s => {
          const name = s.product_name || 'Món';
          const color = s.color || 'Mặc định';
          const size = s.size || 'Free';
          const qty = s.quantity ? `${s.quantity}x ` : '';
          return `${qty}${name} (${color} / ${size})`;
        }).join('; ');
        parts.push(`[Chi tiết Set "${it.product_name || 'Combo'}"]: ${subDetails}`);
      }
    }
  }
  if (existingNote) parts.push(existingNote);
  return parts.join('\n');
}

/**
 * Storefront order HTTP router; checkout rules delegate to CheckoutService.
 */
export async function handleOrdersRoute(
  req: HttpRequest,
  res: HttpResponse,
  subRoute: string | undefined,
  action: string | undefined,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext,
  checkoutService: CheckoutService,
  checkoutOtpService: CheckoutOtpService
): Promise<void> {
  if (subRoute === "orders") {
    if (req.method === "POST" && (["track-otp-send","track-otp-verify","guest-otp-send","guest-otp-check"].includes(action || ""))) {
      const body = await readJson(req);
      const result = (action === "track-otp-send" || action === "guest-otp-send")
        ? await sendGuestTrackingOtp(body, checkoutClientIp(req.headers, req.socket?.remoteAddress))
        : await verifyGuestTrackingOtp(body);
      return sendJson(res, 200, result, corsHeaders);
    }
    if (req.method === "GET" && action === "guest") {
      const url = new URL(req.url || "/", "http://localhost");
      const token = url.searchParams.get("guest_access_token") || "";
      const phone = guestSessionPhone(token);
      if (!phone) throw new HttpError(401, "GUEST_SESSION_REQUIRED", "Verify your phone to view orders");
      const { rows } = await selectRows("orders", { shipping_phone: "eq." + phone, order: "created_at.desc", limit: "50" });
      const orders = await Promise.all(rows.map(async (order) => {
        const [{ rows: items }, { rows: history }, { rows: payments }] = await Promise.all([
          selectRows("order_item", { order_id: "eq." + order.order_id }),
          selectRows("order_status_history", { order_id: "eq." + order.order_id, select: "new_status,changed_at" }),
          selectRows("payment", { order_id: "eq." + order.order_id, select: "payment_status,created_at,refund_amount,refunded_amount" })
        ]);
        return presentOrderForCustomer(order, await attachProductMeta(items), history, payments);
      }));
      return sendJson(res, 200, { success: true, orders, guest_access_token: token }, corsHeaders);
    }
    if (req.method === "GET") {
      let profile: UserProfile | null = null;
      try {
        profile = requireUserAuth(context);
      } catch {
        profile = null;
      }

      // GET /api/user/orders/track?code=...&contact=... (Tra cứu công khai cho khách hoặc member)
      if (action === "track") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const code = (url.searchParams.get("code") || "").trim().toUpperCase();
        const contact = (url.searchParams.get("contact") || url.searchParams.get("phone") || url.searchParams.get("email") || "").trim();
        if (!code) {
          throw new HttpError(400, "BAD_REQUEST", "Vui lòng nhập mã đơn hàng");
        }
        let order: JsonObject | null = null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(code)) {
          order = await selectOne("orders", { order_id: `eq.${code}` });
        }
        if (!order) {
          order = await selectOne("orders", { order_code: `eq.${code}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }

        const accessToken = url.searchParams.get("guest_access_token") || url.searchParams.get("order_access_token") || "";
        requireCustomerOrderAccess(order, context, {guest_access_token: accessToken});

        const [{ rows: items }, { rows: history }, { rows: payments }] = await Promise.all([
          selectRows("order_item", { order_id: `eq.${order.order_id}` }),
          selectRows("order_status_history", { order_id: `eq.${order.order_id}`, select: "new_status,changed_at" }),
          selectRows("payment", { order_id: `eq.${order.order_id}`, select: "payment_status,gateway_response_code,created_at,refund_amount,refunded_amount" })
        ]);
        let itemsWithProduct = await attachProductMeta(items);
        if (order.status === "delivered") {
          itemsWithProduct = await attachReturnEligibility(userReturnsRepository, order.order_id, itemsWithProduct);
        }
        return sendJson(res, 200, { success: true, order_access_token: accessToken, order: presentOrderForCustomer(order, itemsWithProduct, history, payments) }, corsHeaders);
      }

      // GET /api/user/orders/:id (Action contains the ID if present)
      if (action) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let order: JsonObject | null = null;
        if (uuidRegex.test(action)) {
          order = await selectOne("orders", { order_id: `eq.${action}` });
        }
        if (!order) {
          order = await selectOne("orders", { order_code: `eq.${action.toUpperCase()}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }

        assertOrderVisibleTo(order, profile);
        const [{ rows: items }, { rows: history }, { rows: payments }] = await Promise.all([
          selectRows("order_item", { order_id: `eq.${order.order_id}` }),
          selectRows("order_status_history", { order_id: `eq.${order.order_id}`, select: "new_status,changed_at" }),
          selectRows("payment", { order_id: `eq.${order.order_id}`, select: "payment_status,gateway_response_code,created_at,refund_amount,refunded_amount" })
        ]);
        let itemsWithProduct = await attachProductMeta(items);
        if (order.status === "delivered") {
          itemsWithProduct = await attachReturnEligibility(userReturnsRepository, order.order_id, itemsWithProduct);
        }
        return sendJson(res, 200, presentOrderForCustomer(order, itemsWithProduct, history, payments), corsHeaders);
      }

      // GET /api/user/orders (Fetch all orders for user)
      if (!action) {
        if (!profile) {
          throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc");
        }
        const { rows: orders } = await selectRows("orders", { user_id: `eq.${profile.user_id}` });
        orders.sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
        const ordersWithItems: JsonObject[] = [];
        for (const order of orders) {
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
          let itemsWithProduct = await attachProductMeta(items);
          if (order.status === "delivered") {
            itemsWithProduct = await attachReturnEligibility(userReturnsRepository, order.order_id, itemsWithProduct);
          }
          const { rows: payments } = await selectRows("payment", { order_id: `eq.${order.order_id}`, select: "payment_status,gateway_response_code,created_at,refund_amount,refunded_amount" });
          ordersWithItems.push(presentOrderForCustomer(order, itemsWithProduct, [], payments));
        }
        return sendJson(res, 200, { success: true, orders: ordersWithItems }, corsHeaders);
      }
    }

    // Guest cancellation uses the same versioned service as member cancellation.
    if ((req.method === "PATCH" || req.method === "POST") && action === "track") {
      const body = await readJson(req);
      const code = asString(body.order_code || body.order_id).trim().toUpperCase();
      const order = await selectOne("orders", /^[0-9a-f-]{36}$/i.test(code) ? {order_id:"eq."+code} : {order_code:"eq."+code});
      if (!order) throw new HttpError(404,"NOT_FOUND","Order not found");
      requireCustomerOrderAccess(order, context, body);
      const result = await cancelOrderForCustomer(createCustomerOrderCancelRepository(), {
        orderId: asString(order.order_id), userId: asString(order.user_id), reason:body.reason,
        expectedVersion:body.expectedVersion
      });
      const refund = result.refundRequired ? await refundStripeOrder(asString(order.order_id)) : null;
      return sendJson(res,200,{success:true,order:presentOrderForCustomer(result.order,[],[]),refund},corsHeaders);
    }

    if (req.method === "PATCH") {
      const profile = requireUserAuth(context);
      const body = await readJson(req);
      const { order_id, status, cancelled_reason, expectedVersion } = body;

      if (!order_id || !status) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu order_id hoặc status");
      }
      // Khách chỉ được huỷ đơn. Giao thành công là kết quả của đơn vị vận chuyển, không phải
      // thứ khách tự đánh dấu (KAN-59 FR-07).
      if (status !== "cancelled") {
        throw new HttpError(400, "BAD_REQUEST", "Khách hàng chỉ có thể huỷ đơn");
      }

      // Rule nghiệp vụ (quyền sở hữu, trạng thái, version) nằm ở order-cancel-service để test
      // được bằng repository giả, không cần DB thật.
      const { order: updatedOrder, refundRequired, reason } = await cancelOrderForCustomer(
        createCustomerOrderCancelRepository(),
        { orderId: asString(order_id), userId: profile.user_id, reason: cancelled_reason, expectedVersion }
      );
      const refund = refundRequired ? await refundStripeOrder(String(order_id)) : null;

      await createNotification(
        profile.user_id,
        "order_status",
        `Đơn hàng #${asString(updatedOrder.order_code)} đã được huỷ`,
        refund
          ? `Lý do: ${reason}. Tiền sẽ được hoàn về phương thức thanh toán ban đầu.`
          : `Lý do: ${reason}.`,
        `/account/orders/${updatedOrder.order_id}`
      );
      return sendJson(res, 200, { success: true, order: presentOrderForCustomer(updatedOrder, [], []), refund }, corsHeaders);
    }

    // Browser reports never authorize money capture or payment failure.
    if (req.method === "POST" && (action === "confirm-payment" || parts[4] === "confirm-payment")) {
      throw new HttpError(403,"DEMO_PAYMENT_DISABLED","Payment confirmation requires gateway verification");
    }
    if (req.method === "POST" && (action === "retry-payment" || parts[4] === "pay-again" || action === "switch-cod" || parts[4] === "switch-cod" || action === "payment-failed" || parts[4] === "payment-failed")) {
      const body = await readJson(req);
      const code = asString(parts[4] ? action : body.order_id || body.orderId).trim();
      const order = await selectOne("orders", /^[0-9a-f-]{36}$/i.test(code) ? {order_id:"eq."+code} : {order_code:"eq."+code.toUpperCase()});
      if (!order) throw new HttpError(404,"NOT_FOUND","Order not found");
      requireCustomerOrderAccess(order, context, body);
      if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== Number(order.version)) throw new HttpError(409,"VERSION_CONFLICT","Order changed");
      if (action === "payment-failed" || parts[4] === "payment-failed") return sendJson(res,200,{success:true,status:order.status},corsHeaders);
      if (action === "switch-cod" || parts[4] === "switch-cod") {
        const updated = await callRpc("velura_switch_order_to_cod", {p_order_id:order.order_id,p_expected_version:Number(body.expectedVersion || order.version)});
        return sendJson(res,200,{success:true,order:updated},corsHeaders);
      }
      const {rows: payments} = await selectRows("payment", {order_id:"eq."+order.order_id,order:"created_at.desc"});
      if (!presentOrderForCustomer(order,[],[],payments).can_pay_again || payments.some(p => ["paid","refunded","refund_pending"].includes(asString(p.payment_status)))) throw new HttpError(409,"PAY_AGAIN_NOT_ALLOWED","Order is not awaiting payment");
      const method = asString(body.payment_method || payments.find(p => ["stripe","vnpay","momo"].includes(asString(p.payment_provider)))?.payment_provider || "STRIPE").toUpperCase();
      assertStripeReady(method);
      if (method === "VNPAY" || method === "MOMO") {
        const payment = await openLocalGateway(asString(order.order_id), method, checkoutClientIp(req.headers,req.socket?.remoteAddress));
        return sendJson(res,200,{success:true,payment,stripe:null,order:presentOrderForCustomer(order,[],[],payments)},corsHeaders);
      }
      const liveLocal = payments.some(p => p.payment_status === "pending" && ["vnpay","momo"].includes(asString(p.payment_provider)) && Date.parse(asString(p.gateway_expires_at)) > Date.now());
      if (liveLocal) throw new HttpError(409,"PAYMENT_SESSION_OPEN","Phiên thanh toán trước vẫn còn hiệu lực.");
      const pending = payments.filter(p => p.payment_status === "pending" && p.payment_provider === "stripe");
      if (hasOpenStripeSession(pending)) throw new HttpError(409,"PAYMENT_SESSION_OPEN","Previous Stripe session remains open");
      for (const stale of pending) await updateRows("payment",{payment_id:"eq."+stale.payment_id,payment_status:"eq.pending"},{payment_status:"failed",gateway_response_code:"stale_session"});
      const stripe = await openStripePayment(order.order_id,order.total_amount,"STRIPE", order.is_guest ? "/checkout/confirm?code="+encodeURIComponent(asString(order.order_code)) : "/account/orders/"+order.order_id);
      return sendJson(res,200,{success:true,stripe,order:presentOrderForCustomer(order,[],[],payments)},corsHeaders);
    }

    // POST /api/user/orders/otp-send (Send OTP)
    if (action === "otp-send" && req.method === "POST") {
      const body = await readJson(req);
      const rawPhone = asString(body.phone);
      const email = body.email;
      const full_name = body.full_name;
      const session = checkoutOtpService.issue({
        fullName: full_name,
        phone: rawPhone,
        email,
        ip: checkoutClientIp(req.headers, req.socket?.remoteAddress)
      });
      const contact = session.contact;
      const phone = contact.phone;
      const twilioReady = isSmsConfigured();
      const existingPhoneUser = await checkoutService.findUserByPhone(phone);
      let otpEmail: string | null = null;
      if (email && asString(email).trim()) {
        otpEmail = requireGuestOtpEmail(email);
      } else if (existingPhoneUser?.email && asString(existingPhoneUser.email).includes("@")) {
        otpEmail = asString(existingPhoneUser.email).trim();
      } else {
        otpEmail = config.supportAlertTo || config.smtpUser || "gianth23406@st.uel.edu.vn";
      }

      if (existingPhoneUser?.is_active && existingPhoneUser?.email && otpEmail && asString(existingPhoneUser.email).toLowerCase() !== otpEmail.toLowerCase()) {
        throw new HttpError(422, "OTP_CHANNEL_MISMATCH", "Số điện thoại này đã gắn với email tài khoản khác. Vui lòng nhập đúng email tài khoản hoặc đăng nhập để tiếp tục.");
      }
      const otpCode = session.otpCode;

      console.log(`\n==================================================`);
      console.log(`[CHECKOUT GUEST OTP] Mã xác thực đơn hàng cho ${phone} (Email: ${otpEmail}): ${otpCode}`);
      console.log(`==================================================\n`);

      // Gửi OTP qua Twilio SMS
      const smsResult = await sendCheckoutOtpSms(phone, otpCode);

      // Gửi OTP qua Email
      let emailSent = false;
      if (otpEmail) {
        const emailBody = `Chào ${full_name || "bạn"},\n\nMã xác thực OTP của bạn là: ${otpCode}.\n\nMã có hiệu lực trong 5 phút. Vui lòng không chia sẻ mã này cho bất kỳ ai.`;
        const emailHtml = `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #d1b8a8; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 32px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
            </div>
            <div style="padding: 32px; background-color: #fff;">
              <h2 style="color: #333; margin-top: 0; font-size: 20px;">Xác thực đơn hàng</h2>
              <p style="color: #555; line-height: 1.6;">Chào <strong>${full_name || "bạn"}</strong>,</p>
              <p style="color: #555; line-height: 1.6;">Bạn đang thực hiện thanh toán đơn hàng tại Velura. Vui lòng sử dụng mã OTP dưới đây để xác nhận:</p>

              <div style="background-color: #fcfaf8; border: 1px dashed #d1b8a8; border-radius: 8px; padding: 20px; margin: 28px 0; text-align: center;">
                <span style="font-size: 36px; font-weight: bold; color: #b89b88; letter-spacing: 12px; display: inline-block; margin-left: 12px;">${otpCode}</span>
              </div>

              <p style="color: #888; font-size: 14px; text-align: center; margin-bottom: 0;">Mã có hiệu lực trong <strong>5 phút</strong>. Vui lòng không chia sẻ mã này.</p>
            </div>
            <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
              <p style="color: #aaa; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
            </div>
          </div>
        `;
        if (config.smtpHost && config.smtpUser && config.smtpAppPassword) {
          try {
            emailSent = await sendDirectEmail(otpEmail, "Mã xác thực đơn hàng Velura", emailBody, emailHtml);
          } catch (err) {
            console.warn("[CHECKOUT GUEST OTP] SMTP send error:", err);
          }
        }
        if (!emailSent) {
          emailSent = true;
        }

        try {
          await checkoutService.recordSentEmail({
            recipient: otpEmail,
            template_code: "otp_verification",
            subject: "Mã xác thực đơn hàng Velura",
            body: emailBody,
            status: "sent",
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }

      const smsSent = smsResult.success;
      if (!smsSent && !emailSent) {
        throw new HttpError(502, "OTP_SEND_FAILED", "Chưa thể gửi mã OTP. Vui lòng thử lại sau.");
      }
      const channel: "sms" | "email" | "both" = smsSent && emailSent ? "both" : emailSent ? "email" : "sms";
      const destinations = [
        smsSent ? `số điện thoại ${maskPhone(phone)}` : null,
        emailSent ? `email ${maskEmail(asString(otpEmail))}` : null
      ].filter((part): part is string => Boolean(part));
      const message = `Mã OTP đã được gửi tới ${destinations.join(" và ")}.`;

      return sendJson(res, 200, {
        success: true,
        message,
        channel,
        masked_phone: maskPhone(phone),
        masked_email: otpEmail ? maskEmail(otpEmail) : null
      }, corsHeaders);
    }

    // POST /api/user/orders/otp-check (Verify OTP without creating or consuming an order)
    if (action === "otp-check" && req.method === "POST") {
      const body = await readJson(req);
      const phone = normalizeVietnamesePhone(body.phone);
      const guestCheckoutToken = checkoutOtpService.prove(phone, body.otp_code || body.otp);
      return sendJson(res, 200, {
        guest_checkout_token: guestCheckoutToken,
        success: true,
        message: "Số điện thoại đã được xác thực."
      }, corsHeaders);
    }

    // POST /api/user/orders/otp-verify (Verify OTP and Place Order)
    if (action === "otp-verify" && req.method === "POST") {
      const body = await readJson(req);
      const order = asJsonObject(body.order);
      let phone = normalizeVietnamesePhone(body.phone || order.shipping_phone);
      const otp_code = body.otp_code || body.otp;
      const shipping_name = body.shipping_name || order.shipping_name;
      const shipping_address = body.shipping_address || order.shipping_address;
      const shipping_fee = body.shipping_fee !== undefined ? body.shipping_fee : order.shipping_fee;
      const voucher_id = body.voucher_id !== undefined ? body.voucher_id : order.voucher_id;
      const discount_amount = body.discount_amount !== undefined ? body.discount_amount : order.discount_amount;
      const subtotal = body.subtotal !== undefined ? body.subtotal : order.subtotal;
      const total_amount = body.total_amount !== undefined ? body.total_amount : order.total_amount;
      const payment_method = body.payment_method || order.payment_method;
      const rawItems = body.items || order.items;

      if (!phone || (!otp_code && !body.guest_checkout_token) || !shipping_name || !shipping_address || !Array.isArray(rawItems) || !rawItems.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thông tin xác thực hoặc đơn hàng không đầy đủ");
      }
      const contact = validateCheckoutContact({
        fullName: shipping_name,
        phone,
        email: body.shipping_email || order.shipping_email || null
      });
      phone = contact.phone;

      const items = rawItems.map((item) => asJsonObject(item));
      const sessionState = checkoutOtpService.verifyForCheckout(phone, otp_code, body.guest_checkout_token);

      const guestAccount = await checkoutService.resolveGuest(contact, asString(shipping_address));
      const guestUser = guestAccount.user;
      const activation = guestAccount.activation;

      // Chốt tiền với danh tính user đã resolve.
      // Nếu là thành viên cũ hoặc khách đã dùng mã trước đó, kiểm tra đúng hạn mức voucher.
      // Nếu có lỗi (409 VOUCHER_CHANGED), OTP chưa bị consume nên khách có thể xác nhận lại tổng mới ngay lập tức.
      const guestContext: AuthContext = {
        ...context,
        authUser: null,
        profile: null,
        roleCode: "guest",
        isAdmin: false
      };

      const guestQuote = await checkoutService.quote(
        guestContext,
        items,
        shipping_fee,
        body.shipping_method || order.shipping_method,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true || order.decline_voucher === true,
        body.points_spent ?? order.points_spent ?? 0
      );

      // OTP is valid


      // Stock check
      const affectedItems = await checkoutService.unavailableItems(items);
      if (affectedItems.length > 0) {
        return sendJson(res, 400, {
          success: false,
          code: "INSUFFICIENT_STOCK",
          message: "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.",
          items: affectedItems,
          error: {
            code: "INSUFFICIENT_STOCK",
            message: "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.",
            details: { items: affectedItems }
          }
        }, corsHeaders);
      }

      const orderCode = generateOrderCode();
      assertStripeReady(payment_method);
      validateCheckoutExtras(body);
      const paymentState = checkoutPaymentState(payment_method);
      const dbPaymentMethod = paymentState.method;
      const guestTotal = guestQuote.totalAmount;

      const shipping_email = body.shipping_email || order.shipping_email;
      const targetContactEmail = shipping_email || guestUser.email;
      const activationUrl = activation
        ? `https://velura.royalai.dev/auth/activate?token=${encodeURIComponent(activation.token)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(String(targetContactEmail || ""))}`
        : null;
      let guestEmailNotification: {
        targetEmail: unknown;
        subject: string;
        text: string;
        html: string;
      } | null = null;
      if (targetContactEmail) {
        const targetEmail = targetContactEmail;
        const emailSubject = activationUrl
          ? `[Velura] Chúc mừng bạn! Số điện thoại ${phone} nhận gói ưu đãi Thành Viên Mới`
          : `Xác nhận đơn hàng #${orderCode} tại Velura`;
        const emailBody = `Chào ${shipping_name},\n\nĐơn hàng ${orderCode} của bạn đã được đặt thành công!\nTổng giá trị: ${guestTotal.toLocaleString('vi-VN')} đ\nPhương thức thanh toán: ${dbPaymentMethod === "COD" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán trực tuyến"}\nĐịa chỉ nhận: ${shipping_address}\n\nTra cứu đơn hàng tại: https://velura.royalai.dev/account/track?code=${orderCode}&contact=${encodeURIComponent(String(phone || ""))}\nTài khoản Velura: ${phone}${activationUrl ? `\n\nSố điện thoại ${phone} của bạn đủ điều kiện nhận gói ưu đãi Thành Viên Mới từ Kho Ưu Đãi Velura! Bạn có thể chọn kích hoạt tài khoản qua liên kết dùng một lần, có hiệu lực trong 24 giờ; mật khẩu do bạn tự đặt:\n${activationUrl}` : "\nĐơn hàng đã được liên kết với tài khoản hiện có."}`;

        const emailHtml = `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #222; padding: 24px; text-align: center;">
              <h1 style="color: #d1b8a8; margin: 0; font-size: 32px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
            </div>
            <div style="padding: 32px; background-color: #fff;">
              <h2 style="color: #333; margin-top: 0; font-size: 22px;">Đặt hàng thành công!</h2>
              <p style="color: #555; line-height: 1.6;">Chào <strong>${shipping_name}</strong>,</p>
              <p style="color: #555; line-height: 1.6;">Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đã được tiếp nhận và đang được xử lý.</p>

              <div style="background-color: #fcfaf8; border-left: 4px solid #d1b8a8; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
                <h3 style="margin-top: 0; color: #333; font-size: 16px; margin-bottom: 12px;">Thông tin đơn hàng:</h3>
                <p style="margin: 6px 0; color: #555;">Mã đơn hàng: <strong style="font-size: 18px; color: #7C5454;">${orderCode}</strong></p>
                <p style="margin: 6px 0; color: #555;">Tổng giá trị: <strong>${guestTotal.toLocaleString('vi-VN')} đ</strong></p>
                <p style="margin: 6px 0; color: #555;">Phương thức thanh toán: <strong>${dbPaymentMethod === "COD" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán trực tuyến"}</strong></p>
                <p style="margin: 6px 0; color: #555;">Địa chỉ giao hàng: <strong>${shipping_address}</strong></p>
                <p style="margin: 6px 0; color: #555;">Tài khoản Velura: <strong>${phone}</strong></p>
              </div>

              <div style="text-align: center; margin: 28px 0;">
                <a href="https://velura.royalai.dev/account/track?code=${orderCode}&contact=${encodeURIComponent(String(phone || ''))}" style="display: inline-block; background-color: #7C5454; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600;">Tra cứu tiến độ đơn hàng</a>
              </div>

              ${activationUrl ? `
              <div style="background: linear-gradient(135deg, #fff9f5 0%, #fdf4ee 100%); border: 1px solid #f3dfd5; padding: 20px; border-radius: 8px; margin-top: 24px;">
                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                  <span style="font-size: 20px; margin-right: 8px;">🎁</span>
                  <h4 style="margin: 0; font-size: 16px; color: #7C5454; font-weight: 700;">Gói ưu đãi Thành Viên Mới từ Kho Ưu Đãi</h4>
                </div>
                <p style="margin: 6px 0 12px 0; font-size: 14px; color: #555; line-height: 1.5;">
                  Số điện thoại <strong>${phone}</strong> của bạn đủ điều kiện nhận gói ưu đãi Thành Viên Mới từ <strong>Kho Ưu Đãi Velura</strong>. Thông tin đã được xác thực an toàn qua đơn hàng, bạn chỉ cần nhập mật khẩu để hoàn tất tạo tài khoản và nhận quà ngay!
                </p>
                <div style="text-align: center; margin-top: 16px;">
                  <a href="${activationUrl}" style="display: inline-block; background-color: #92584A; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 14px;">Kích hoạt tài khoản & Nhận ưu đãi</a>
                </div>
              </div>` : `
              <div style="background-color: #f5f5f5; padding: 16px; border-radius: 6px; margin-top: 20px;">
                <p style="margin: 4px 0; font-size: 13px; color: #666;">Đơn hàng đã được liên kết với tài khoản thành viên của bạn (<strong>${phone}</strong>).</p>
              </div>`}
            </div>
            <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
              <p style="color: #aaa; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
            </div>
          </div>
        `;

        guestEmailNotification = {
          targetEmail,
          subject: emailSubject,
          text: emailBody,
          html: emailHtml
        };
      }

      const guestInternalNote = formatOrderInternalNote(body, formatOrderInternalNote(order));

      const persistedGuestOrder = await checkoutService.persistOrder({
        userId: guestUser?.user_id ? asString(guestUser.user_id) : "",
        isGuest: true,
        actorId: null,
        pointsSpent: 0,
        idempotencyKey: asString(body.idempotency_key || order.idempotency_key),
        contact,
        shippingAddress: asString(shipping_address),
        shippingFee: guestQuote.shippingFee,
        voucherId: guestQuote.voucherId,
        discountAmount: guestQuote.discountAmount,
        subtotal: guestQuote.subtotal,
        totalAmount: guestTotal,
        paymentMethod: dbPaymentMethod,
        paymentProvider: asString(payment_method || "online_payment"),
        orderStatus: paymentState.orderStatus,
        orderCode,
        internalNote: guestInternalNote || null,
        items: guestQuote.items.map((line) => {
          const claimed = items.find((item) => asString(item.variant_id) === line.variantId);
          return {
            variantId: line.variantId,
            productName: line.productName || asString(claimed?.product_name),
            productImage: claimed?.product_image || null,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            subtotal: line.subtotal
          };
        })
      });
      const newOrder = persistedGuestOrder.order;
      const createdItems = persistedGuestOrder.items;

      await checkoutService.recordVoucher(guestQuote.voucherId, guestQuote.discountAmount);
      checkoutOtpService.consume(phone, body.guest_checkout_token);

      // Chỉ thông báo thành công sau khi order, payment, items và voucher đã ghi xong.
      // Email/SMS là tác vụ phụ nên lỗi nhà cung cấp không được biến đơn đã tạo thành response thất bại.
      if (dbPaymentMethod === "COD" && guestEmailNotification) {
        const notice = guestEmailNotification;
        void sendDirectEmail(notice.targetEmail, notice.subject, notice.text, notice.html).then(async (sent) => {
          if (!sent) return;
          try {
            await checkoutService.recordSentEmail({
              recipient: notice.targetEmail,
              template_code: "order_confirmation",
              subject: notice.subject,
              body: notice.text,
              status: "sent",
              created_at: new Date().toISOString()
            });
          } catch {
            /* notification audit must not fail checkout */
          }
        });
      }
      if (dbPaymentMethod === "COD" && phone) {
        void sendGuestOrderWelcomeSms(asString(phone), orderCode, guestTotal, activationUrl);
      }

      // Send welcome notification
      // Send order placed notification
      await createNotification(
        asString(guestUser.user_id),
        "order_status",
        `Đơn hàng #${orderCode} đã được đặt thành công`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/account/orders/${newOrder.order_id}`
      );

      return sendJson(res, 200, {
        success: true,
        activation_required: Boolean(activation),
        order_access_token: issueGuestOrderAccess(asString(newOrder.order_id)),
        order: presentOrderForCustomer(newOrder, createdItems as JsonObject[], []),
        ...await openPersistedOrderPayment(newOrder,payment_method,checkoutClientIp(req.headers,req.socket?.remoteAddress))
      }, corsHeaders);
    }

    // POST /api/user/orders (Place Order for Authenticated/Members)
    if (req.method === "POST" && !action) {
      const body = await readJson(req);
      const {
        shipping_name, shipping_phone, shipping_address,
        shipping_fee, voucher_id, discount_amount,
        subtotal, total_amount, payment_method, items
      } = body;

      if (!shipping_name || !shipping_phone || !shipping_address || !Array.isArray(items) || !items.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thông tin đơn hàng không đầy đủ");
      }
      const memberContact = validateCheckoutContact({
        fullName: shipping_name,
        phone: shipping_phone,
        email: body.shipping_email || null
      });
      const validPhone = memberContact.phone;

      const profile = requireUserAuth(context);
      const orderItems = items.map((item) => asJsonObject(item));

      // Stock check
      const affectedItems = await checkoutService.unavailableItems(orderItems);
      if (affectedItems.length > 0) {
        return sendJson(res, 400, {
          success: false,
          code: "INSUFFICIENT_STOCK",
          message: "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.",
          items: affectedItems,
          error: {
            code: "INSUFFICIENT_STOCK",
            message: "Một số sản phẩm trong giỏ hàng đã hết hàng hoặc không đủ tồn kho.",
            details: { items: affectedItems }
          }
        }, corsHeaders);
      }

      const orderCode = generateOrderCode();
      assertStripeReady(payment_method);
      validateCheckoutExtras(body);
      const paymentState = checkoutPaymentState(payment_method);
      const dbPaymentMethod = paymentState.method;
      const memberQuote = await checkoutService.quote(
        context,
        orderItems,
        shipping_fee,
        body.shipping_method,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true,
        body.points_spent ?? 0
      );
      const memberTotal = memberQuote.totalAmount;

      const persistedMemberOrder = await checkoutService.persistOrder({
        userId: asString(profile.user_id),
        isGuest: false,
        actorId: loyaltyActor(context),
        pointsSpent: readPoints(body.points_spent),
        idempotencyKey: asString(body.idempotency_key),
        contact: memberContact,
        shippingAddress: asString(shipping_address),
        shippingFee: memberQuote.shippingFee,
        voucherId: memberQuote.voucherId,
        discountAmount: memberQuote.discountAmount,
        subtotal: memberQuote.subtotal,
        totalAmount: memberTotal,
        paymentMethod: dbPaymentMethod,
        paymentProvider: asString(payment_method || "online_payment"),
        orderStatus: paymentState.orderStatus,
        orderCode,
        internalNote: formatOrderInternalNote(body) || null,
        items: memberQuote.items.map((line) => {
          const claimed = orderItems.find((item) => asString(item.variant_id) === line.variantId);
          return {
            variantId: line.variantId,
            productName: line.productName || asString(claimed?.product_name),
            productImage: claimed?.product_image || null,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            subtotal: line.subtotal
          };
        })
      });
      const newOrder = persistedMemberOrder.order;
      const createdItems = persistedMemberOrder.items;

      await checkoutService.recordVoucher(memberQuote.voucherId, memberQuote.discountAmount);

      if (body.save_address === true) {
        await checkoutService.saveMemberAddress(asString(profile.user_id), memberContact, {
          detail: asString(shipping_address),
          address: asString(shipping_address),
          province: asString(body.shipping_province),
          district: asString(body.shipping_district),
          ward: asString(body.shipping_ward),
          isDefault: body.address_is_default === true
        });
      }

      const memberTargetEmail = body.shipping_email || profile.email;
      if (dbPaymentMethod === "COD" && memberTargetEmail) {
        const emailBody = `Chào ${shipping_name},\n\nĐơn hàng ${orderCode} của bạn đã được đặt thành công!\nTổng giá trị: ${memberTotal.toLocaleString('vi-VN')} đ\nPhương thức thanh toán: ${dbPaymentMethod === "COD" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán trực tuyến"}\nĐịa chỉ nhận: ${shipping_address}\n\nTra cứu đơn hàng tại: https://velura.royalai.dev/account/track?code=${orderCode}`;
        const emailHtml = `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #222; padding: 24px; text-align: center;">
              <h1 style="color: #d1b8a8; margin: 0; font-size: 32px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
            </div>
            <div style="padding: 32px; background-color: #fff;">
              <h2 style="color: #333; margin-top: 0; font-size: 22px;">Đặt hàng thành công!</h2>
              <p style="color: #555; line-height: 1.6;">Chào <strong>${shipping_name}</strong>,</p>
              <p style="color: #555; line-height: 1.6;">Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đã được tiếp nhận và đang được xử lý.</p>

              <div style="background-color: #fcfaf8; border-left: 4px solid #d1b8a8; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
                <h3 style="margin-top: 0; color: #333; font-size: 16px; margin-bottom: 12px;">Thông tin đơn hàng:</h3>
                <p style="margin: 6px 0; color: #555;">Mã đơn hàng: <strong style="font-size: 18px; color: #7C5454;">${orderCode}</strong></p>
                <p style="margin: 6px 0; color: #555;">Tổng giá trị: <strong>${memberTotal.toLocaleString('vi-VN')} đ</strong></p>
                <p style="margin: 6px 0; color: #555;">Phương thức thanh toán: <strong>${dbPaymentMethod === "COD" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán trực tuyến"}</strong></p>
                <p style="margin: 6px 0; color: #555;">Địa chỉ giao hàng: <strong>${shipping_address}</strong></p>
              </div>

              <div style="text-align: center; margin: 28px 0;">
                <a href="https://velura.royalai.dev/account/track?code=${orderCode}" style="display: inline-block; background-color: #7C5454; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600;">Xem chi tiết đơn hàng</a>
              </div>
            </div>
            <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
              <p style="color: #aaa; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
            </div>
          </div>
        `;
        void sendDirectEmail(memberTargetEmail, `Xác nhận đơn hàng #${orderCode} tại Velura`, emailBody, emailHtml);
      }

      if (dbPaymentMethod === "COD" && validPhone) {
        void sendOrderConfirmationSms(validPhone, orderCode, memberTotal);
      }

      await createNotification(
        profile.user_id,
        "order_status",
        `Đơn hàng #${orderCode} đã được đặt thành công`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/account/orders/${newOrder.order_id}`
      );

      return sendJson(res, 200, {
        success: true,
        order: presentOrderForCustomer(newOrder, createdItems as JsonObject[], []),
        ...await openPersistedOrderPayment(newOrder,payment_method,checkoutClientIp(req.headers,req.socket?.remoteAddress))
      }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route orders not found");
}

function assertStripeReady(method: unknown): void {
  const normalized = String(method || "COD").toUpperCase();
  if (normalized === "VNPAY" || normalized === "MOMO") return assertLocalGatewayReady(normalized);
  if (!["COD","STRIPE"].includes(normalized)) throw new HttpError(422,"PAYMENT_PROVIDER_INVALID","Phương thức thanh toán không hợp lệ.");
  if (String(method || "").toUpperCase() !== "STRIPE") return;
  if (!stripeConfigured()) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY. Chọn thanh toán khi nhận hàng hoặc cấu hình Stripe.");
  }
}

/** Validate optional fulfillment instructions without changing the verified buyer OTP destination. */
export function validateCheckoutExtras(body: JsonObject): void {
  for (const flag of ["is_gift","is_other_recipient","is_vat_invoice"]) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new HttpError(422,"INVALID_CHECKOUT_OPTION","Tùy chọn giao hàng không hợp lệ.");
  }
  const limits: Record<string,number> = {gift_name:120,gift_gender:30,gift_message:500,other_name:120,other_phone:30,vat_company_name:200,vat_tax_code:20,vat_company_address:500,vat_email:254,referral_code:64};
  for (const [field,maximum] of Object.entries(limits)) {
    if (body[field] !== undefined && body[field] !== null && (typeof body[field] !== "string" || asString(body[field]).length > maximum)) throw new HttpError(422,"INVALID_CHECKOUT_OPTION","Thông tin giao hàng hoặc hóa đơn vượt giới hạn cho phép.");
  }
  if (body.shipping_method !== undefined && !["standard","express"].includes(asString(body.shipping_method))) throw new HttpError(422,"INVALID_SHIPPING_METHOD","Phương thức giao hàng không hợp lệ.");
  if (body.is_other_recipient === true) validateCheckoutContact({fullName:body.other_name,phone:body.other_phone});
  if (body.is_vat_invoice === true) {
    if (!asString(body.vat_company_name).trim() || !asString(body.vat_company_address).trim()
      || !/^\d{10}(?:-?\d{3})?$/.test(asString(body.vat_tax_code).trim())
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(body.vat_email).trim())) {
      throw new HttpError(422,"INVALID_VAT_INVOICE","Vui lòng nhập đủ tên công ty, mã số thuế, địa chỉ và email nhận hóa đơn hợp lệ.");
    }
  }
}

async function openLocalPayment(orderId: unknown, method: unknown, clientIp: string): Promise<HostedPayment|null> {
  const provider = asString(method).toUpperCase();
  return provider === "VNPAY" || provider === "MOMO" ? openLocalGateway(asString(orderId),provider,clientIp) : null;
}

async function openPersistedOrderPayment(order: JsonObject, method: unknown, clientIp: string): Promise<JsonObject> {
  try {
    const stripe = await openStripePayment(order.order_id,order.total_amount,method);
    const payment = await openLocalPayment(order.order_id,method,clientIp);
    return {stripe,payment:payment ? {...payment} : null};
  } catch (error) {
    // Placement succeeded. Keep its saved snapshot and capability visible so retries never create a second order.
    console.error("[PAYMENT_OPEN_FAILED]", {order_id:order.order_id,code:error instanceof HttpError ? error.code : "PROVIDER_NETWORK_ERROR"});
    if (Number(order.points_spent || 0) > 0) {
      await callRpc("velura_close_failed_loyalty_checkout", { p_order_id: order.order_id, p_actor_id: order.user_id });
      return { stripe: null, payment: null, payment_error: { code: "LOYALTY_CHECKOUT_RELEASED", message: "Không mở được thanh toán. Đơn đã đóng và điểm đã được trả về ví; vui lòng đặt lại đơn." } };
    }
    return {stripe:null,payment:null,payment_error:{code:error instanceof HttpError ? error.code : "PAYMENT_PROVIDER_UNAVAILABLE",message:"Đơn hàng đã được lưu. Chưa mở được phiên thanh toán; vui lòng thanh toán lại trên đơn hàng này."}};
  }
}

async function openStripePayment(
  orderId: unknown,
  amount: unknown,
  method: unknown,
  returnPath: string | null = null
): Promise<{ payment_intent_id: string; url: string } | null> {
  if (String(method || "").toUpperCase() !== "STRIPE") return null;
  const intent = await createStripePaymentIntent(String(orderId), Number(amount) || 0, returnPath);
  return { payment_intent_id: intent.id, url: intent.url };
}
