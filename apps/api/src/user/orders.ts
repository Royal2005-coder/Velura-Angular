import { randomUUID } from "node:crypto";
import { HttpError, readJson, sendJson } from "../http.js";
import { callRpc, quotePostgrestValue, selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { hashPassword, signJwt } from "../auth-helper.js";
import { requireUserAuth, validatePhone } from "./auth.js";
import { createNotification } from "./notifications.js";
import { recordVoucherRedemption, resolveOrderVoucher } from "./vouchers.js";
import { allowDevOtpBypass, config } from "../config.js";
import { createStripePaymentIntent, refundStripeOrder, STRIPE_CHECKOUT_TTL_SECONDS, stripeConfigured } from "../payments/stripe.js";
import { priceOrder, shippingMethodFromClaim } from "./order-pricing.js";
import { buildCartLines, loadCatalog, loadCategoryTree } from "./cart-catalog.js";
import { customerCanCancel, customerOrderSteps, orderFacts, orderStatusLabel } from "../orders/order-state-machine.js";
import { returnWindowOpen } from "./return-window.js";
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

interface CheckoutOtpSession {
  otpCode: string;
  expiresAt: number;
  email: unknown;
  full_name: unknown;
  attempts: number;
}

const checkoutOtpAttemptsMap = new Map<string, CheckoutOtpSession>();

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
 * Guest checkout has no SMS provider. The code is emailed, so an address is required.
 */
export function requireGuestOtpEmail(value: unknown): string {
  const email = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "EMAIL_REQUIRED", "Email là bắt buộc để nhận mã OTP. Velura chưa gửi OTP qua số điện thoại.");
  }
  return email;
}

/**
 * Hides the mailbox name before showing the destination on the checkout screen.
 */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

// Helper to send email directly without relying on email_outbox and service role worker
async function sendDirectEmail(to: unknown, subject: string, text: string, html: string): Promise<void> {
  if (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword) {
    if (config.nodeEnv !== "production") {
      console.log(`[EMAIL MOCK] Sending to ${to}: ${subject}`);
    }
    return;
  }
  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: config.smtpSecure === true,
      auth: {
        user: config.smtpUser,
        pass: config.smtpAppPassword
      }
    });
    await withTimeout(transporter.sendMail({
      from: `"Velura" <${config.smtpUser}>`,
      to: String(to),
      subject,
      text,
      html
    }), 10000, "SMTP send");
    console.log(`[EMAIL SENT] Sent successfully to ${to}`);
  } catch (err: unknown) {
    console.error(`[EMAIL ERROR] Failed to send email to ${to}:`, errorMessage(err));
  }
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
  "total_amount", "payment_method", "voucher_id", "cancelled_reason", "tracking_code", "carrier", "tracking_url"
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
  const itemsWithProduct: JsonObject[] = [];
  for (const item of items) {
    let productId: unknown = null;
    let categoryName: unknown = null;
    try {
      const v = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
      if (v) {
        productId = v.product_id;
        const product = await selectOne("product", { product_id: `eq.${productId}` });
        if (product) {
          const cat = await selectOne("category", { category_id: `eq.${product.category_id}` });
          if (cat) {
            categoryName = cat.name;
          }
        }
      }
    } catch (e: unknown) {
      console.error("Error retrieving variant product_id:", errorMessage(e));
    }
    itemsWithProduct.push({ ...item, product_id: productId, category_name: categoryName });
  }
  return itemsWithProduct;
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
  if (existingNote) parts.push(existingNote);
  return parts.join('\n');
}

/**
 * Storefront vouchers and order list/create/status/payment flows.
 */
export async function handleOrdersRoute(
  req: HttpRequest,
  res: HttpResponse,
  subRoute: string | undefined,
  action: string | undefined,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (subRoute === "orders") {
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
          order = await selectOne("orders", { order_code: `eq.${quotePostgrestValue(code)}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }

        const isOwner = profile && profile.user_id === order.user_id;
        const normContact = contact.toLowerCase().replace(/\s/g, "");
        const normPhone = String(order.shipping_phone || "").replace(/\D/g, "");
        const normEmail = String(order.shipping_email || "").toLowerCase().trim();
        const contactMatches = Boolean(contact) && (
          normContact === normEmail ||
          (contact.replace(/\D/g, "") && contact.replace(/\D/g, "") === normPhone)
        );

        if (!isOwner && !contactMatches) {
          throw new HttpError(404, "NOT_FOUND", "Mã đơn hàng hoặc thông tin liên hệ (SĐT/Email) không khớp");
        }

        const [{ rows: items }, { rows: history }, { rows: payments }] = await Promise.all([
          selectRows("order_item", { order_id: `eq.${order.order_id}` }),
          selectRows("order_status_history", { order_id: `eq.${order.order_id}`, select: "new_status,changed_at" }),
          selectRows("payment", { order_id: `eq.${order.order_id}`, select: "payment_status,gateway_response_code,created_at" })
        ]);
        const itemsWithProduct = await attachProductMeta(items);
        return sendJson(res, 200, { success: true, order: presentOrderForCustomer(order, itemsWithProduct, history, payments) }, corsHeaders);
      }

      // GET /api/user/orders/:id (Action contains the ID if present)
      if (action) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let order: JsonObject | null = null;
        if (uuidRegex.test(action)) {
          order = await selectOne("orders", { order_id: `eq.${action}` });
        }
        if (!order) {
          order = await selectOne("orders", { order_code: `eq.${quotePostgrestValue(action.toUpperCase())}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }

        assertOrderVisibleTo(order, profile);
        const [{ rows: items }, { rows: history }, { rows: payments }] = await Promise.all([
          selectRows("order_item", { order_id: `eq.${order.order_id}` }),
          selectRows("order_status_history", { order_id: `eq.${order.order_id}`, select: "new_status,changed_at" }),
          selectRows("payment", { order_id: `eq.${order.order_id}`, select: "payment_status,gateway_response_code,created_at" })
        ]);
        const itemsWithProduct = await attachProductMeta(items);
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
          const itemsWithProduct = await attachProductMeta(items);
          ordersWithItems.push(presentOrderForCustomer(order, itemsWithProduct, []));
        }
        return sendJson(res, 200, { success: true, orders: ordersWithItems }, corsHeaders);
      }
    }

    // PATCH /api/user/orders/track hoặc POST /api/user/orders/track — Huỷ đơn qua mã đơn + xác thực
    if ((req.method === "PATCH" || req.method === "POST") && action === "track") {
      const body = await readJson(req);
      const cleanCode = String(body.order_code || "").trim().toUpperCase();
      const cleanContact = String(body.contact || body.phone || body.email || "").trim();
      const reason = body.reason;
      if (!cleanCode || !cleanContact) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu mã đơn hàng hoặc thông tin liên hệ");
      }
      let order = await selectOne("orders", { order_code: `eq.${cleanCode}` });
      if (!order && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCode)) {
        order = await selectOne("orders", { order_id: `eq.${cleanCode}` });
      }
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }

      let profile: UserProfile | null = null;
      try {
        profile = requireUserAuth(context);
      } catch {
        profile = null;
      }

      const isOwner = profile && profile.user_id === order.user_id;
      const normContact = cleanContact.toLowerCase().replace(/\s/g, "");
      const normPhone = String(order.shipping_phone || "").replace(/\D/g, "");
      const normEmail = String(order.shipping_email || "").toLowerCase().trim();
      const contactMatches = (
        normContact === normEmail ||
        (cleanContact.replace(/\D/g, "") && cleanContact.replace(/\D/g, "") === normPhone)
      );

      if (!isOwner && !contactMatches) {
        throw new HttpError(404, "NOT_FOUND", "Mã đơn hàng hoặc thông tin liên hệ không khớp");
      }

      if (order.status !== "pending" && order.status !== "waiting_payment") {
        throw new HttpError(400, "CANNOT_CANCEL", "Đơn hàng đã được chuẩn bị hoặc giao cho ĐVVC, không thể tự hủy.");
      }

      const cancelReason = String(reason || "Khách hàng tự huỷ").trim().slice(0, 300);
      try {
        await callRpc("velura_order_service_action", {
          p_order_id: order.order_id,
          p_action: "customer_cancel",
          p_actor_id: order.user_id || "guest",
          p_note: cancelReason,
          p_payload: { cancel_reason: cancelReason },
          p_expected_version: null
        });
      } catch {
        await updateRows("orders", { order_id: `eq.${order.order_id}` }, {
          status: "cancelled",
          cancelled_reason: cancelReason,
          updated_at: new Date().toISOString()
        });
        await insertRow("order_status_history", {
          order_id: order.order_id,
          old_status: order.status,
          new_status: "cancelled",
          trigger_type: "customer",
          changed_by: isOwner ? profile?.user_id : "guest",
          changed_at: new Date().toISOString(),
          note: cancelReason
        });
      }
      return sendJson(res, 200, { success: true, message: "Hủy đơn hàng thành công" }, corsHeaders);
    }

    if (req.method === "PATCH") {
      const profile = requireUserAuth(context);
      const body = await readJson(req);
      const { order_id, status, cancelled_reason } = body;

      if (!order_id || !status) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu order_id hoặc status");
      }
      // Khách chỉ được huỷ đơn. Giao thành công là kết quả của đơn vị vận chuyển, không phải
      // thứ khách tự đánh dấu (KAN-59 FR-07).
      if (status !== "cancelled") {
        throw new HttpError(400, "BAD_REQUEST", "Khách hàng chỉ có thể huỷ đơn");
      }

      const order = await selectOne("orders", { order_id: `eq.${order_id}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      if (order.user_id !== profile.user_id) {
        throw new HttpError(403, "FORBIDDEN", "Bạn không có quyền cập nhật đơn hàng này");
      }

      // Cùng đường xử lý với admin: kiểm trạng thái (BR-03), trả kho đúng một lần, ghi lịch
      // sử và nhật ký, chuyển thanh toán sang Chờ hoàn tiền nếu đã trả tiền.
      const reason = String(cancelled_reason || "").trim().slice(0, 300) || "Khách hàng tự huỷ";
      let result: JsonObject;
      try {
        result = asJsonObject(await callRpc("velura_order_service_action", {
          p_order_id: order_id,
          p_action: "customer_cancel",
          p_actor_id: profile.user_id,
          p_note: reason,
          p_payload: { cancel_reason: reason },
          p_expected_version: null
        }));
      } catch (error: unknown) {
        const code = error instanceof HttpError ? asString(asJsonObject(error.details).message) : "";
        if (code === "INVALID_ORDER_ACTION" || code === "ORDER_ALREADY_HANDED_OVER") {
          throw new HttpError(400, code, "Đơn hàng đã được chuẩn bị hoặc giao cho đơn vị vận chuyển, không thể tự huỷ. Vui lòng liên hệ CSKH.");
        }
        throw error;
      }
      const refund = result.refund_required ? await refundStripeOrder(String(order_id)) : null;
      const updatedOrder = asJsonObject(result.order);

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

    // POST /api/user/orders/:id/pay-again — thanh toán lại đơn online trong 24 giờ.
    if (action && parts[4] === "pay-again" && req.method === "POST") {
      const profile = requireUserAuth(context);
      const order = await selectOne("orders", { order_id: `eq.${action}` });
      if (!order || order.user_id !== profile.user_id) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      const view = presentOrderForCustomer(order, [], []);
      if (!view.can_pay_again) {
        throw new HttpError(409, "PAY_AGAIN_NOT_ALLOWED", "Đơn không còn ở trạng thái chờ thanh toán hoặc đã quá 24 giờ.");
      }
      // Một phiên còn mở thì không mở phiên thứ hai: khách trả cả hai thì lần sau rơi vào
      // đơn đã xác nhận và không có đường hoàn tiền tự động.
      const { rows: openSessions } = await selectRows("payment", {
        order_id: `eq.${order.order_id}`,
        payment_provider: "eq.stripe",
        payment_status: "eq.pending",
        select: "payment_id,created_at"
      });
      if (hasOpenStripeSession(openSessions)) {
        throw new HttpError(409, "PAYMENT_SESSION_OPEN", "Phiên thanh toán trước vẫn còn mở. Hoàn tất ở tab đó hoặc thử lại sau ít phút.");
      }
      // Phiên quá hạn mà webhook hết hạn chưa về: Stripe đã đóng phiên đó, nên đóng theo để
      // chỉ mục một-phiên-mở-mỗi-đơn nhận phiên mới. Tiền về muộn cho phiên này vẫn được
      // ghi nhận, vì webhook có mã phiên nhận cả payment đã đóng.
      for (const stale of openSessions) {
        await updateRows("payment", { payment_id: `eq.${asString(stale.payment_id)}`, payment_status: "eq.pending" }, {
          payment_status: "failed",
          gateway_response_code: "stale_session"
        });
      }
      const stripe = await openStripePayment(order.order_id, order.total_amount, "STRIPE", `/account/orders/${order.order_id}`);
      return sendJson(res, 200, { success: true, stripe }, corsHeaders);
    }

    // POST /api/user/orders/:id/switch-cod hoặc POST /api/user/orders/switch-cod
    if (((action && parts[4] === "switch-cod") || action === "switch-cod") && req.method === "POST") {
      const body = await readJson(req);
      const targetOrderId = (action !== "switch-cod" ? action : asString(body.order_id || body.orderId)) || "";
      const order = await selectOne("orders", { order_id: `eq.${targetOrderId}` }) ||
                    await selectOne("orders", { order_code: `eq.${quotePostgrestValue(targetOrderId.toUpperCase())}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      if (order.status !== "pending" && order.status !== "waiting_payment") {
        throw new HttpError(400, "INVALID_STATE", "Đơn hàng không ở trạng thái chờ thanh toán");
      }
      await updateRows("orders", { order_id: `eq.${order.order_id}` }, {
        payment_method: "COD",
        status: "pending",
        stock_committed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      try {
        await updateRows("payment", { order_id: `eq.${order.order_id}`, payment_status: "eq.pending" }, {
          payment_status: "failed",
          gateway_response_code: "SWITCHED_TO_COD",
          updated_at: new Date().toISOString()
        });
      } catch {
        /* ignore */
      }
      try {
        await insertRow("order_status_history", {
          order_id: order.order_id,
          old_status: order.status,
          new_status: "pending",
          trigger_type: "customer",
          changed_by: "customer",
          changed_at: new Date().toISOString(),
          note: "Khách hàng đổi phương thức thanh toán sang COD (Thanh toán khi nhận hàng)"
        });
      } catch {
        /* ignore */
      }
      return sendJson(res, 200, { success: true, message: "Đã chuyển sang phương thức thanh toán COD thành công" }, corsHeaders);
    }

    // POST /api/user/orders/:id/payment-failed hoặc POST /api/user/orders/payment-failed
    if (((action && parts[4] === "payment-failed") || action === "payment-failed") && req.method === "POST") {
      const body = await readJson(req);
      const targetOrderId = (action !== "payment-failed" ? action : asString(body.order_id || body.orderId)) || "";
      const order = await selectOne("orders", { order_id: `eq.${targetOrderId}` }) ||
                    await selectOne("orders", { order_code: `eq.${quotePostgrestValue(targetOrderId.toUpperCase())}` });
      if (order) {
        try {
          await updateRows("payment", { order_id: `eq.${order.order_id}`, payment_status: "eq.pending" }, {
            payment_status: "failed",
            gateway_response_code: "TIMEOUT_OR_CANCELLED",
            updated_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }
      return sendJson(res, 200, { success: true, message: "Đã cập nhật trạng thái thanh toán" }, corsHeaders);
    }

    // POST /api/user/orders/:id/confirm-payment hoặc POST /api/user/orders/confirm-payment
    if (((action && parts[4] === "confirm-payment") || action === "confirm-payment") && req.method === "POST") {
      const body = await readJson(req);
      const targetOrderId = (action !== "confirm-payment" ? action : asString(body.order_id || body.orderId)) || "";
      const order = await selectOne("orders", { order_id: `eq.${targetOrderId}` }) ||
                    await selectOne("orders", { order_code: `eq.${quotePostgrestValue(targetOrderId.toUpperCase())}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      if (order.status !== "pending" && order.status !== "waiting_payment") {
        throw new HttpError(400, "INVALID_STATE", "Đơn hàng không ở trạng thái chờ thanh toán");
      }
      const nowIso = new Date().toISOString();
      try {
        await callRpc("velura_order_service_action", {
          p_order_id: order.order_id,
          p_action: "payment_succeeded",
          p_actor_id: null,
          p_note: "Khách hàng xác nhận đã chuyển khoản thành công qua VietQR (VNPay/MoMo Demo)",
          p_payload: { method: order.payment_method || "VIETQR" },
          p_expected_version: null
        });
      } catch {
        // Fallback direct update
        await updateRows("orders", { order_id: `eq.${order.order_id}` }, {
          status: "confirmed",
          stock_committed_at: order.stock_committed_at || nowIso,
          updated_at: nowIso
        });
      }

      // Update payment record to paid
      try {
        await updateRows("payment", { order_id: `eq.${order.order_id}`, payment_status: "eq.pending" }, {
          payment_status: "paid",
          paid_at: nowIso,
          gateway_response_code: "DEMO_CONFIRMED",
          updated_at: nowIso
        });
      } catch {
        /* ignore */
      }

      // Commit stock if not already committed
      if (!order.stock_committed_at) {
        try {
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
          for (const item of items) {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          }
        } catch (e: unknown) {
          console.error("Failed to commit variant stock on confirm-payment:", errorMessage(e));
        }
      }

      // Insert order status history
      try {
        await insertRow("order_status_history", {
          order_id: order.order_id,
          old_status: order.status,
          new_status: "confirmed",
          trigger_type: "customer",
          changed_by: "customer",
          changed_at: nowIso,
          note: "Khách hàng xác nhận đã chuyển khoản thành công qua VietQR (VNPay/MoMo Demo)"
        });
      } catch {
        /* ignore */
      }

      if (order.user_id) {
        try {
          await createNotification(
            asString(order.user_id),
            "order_status",
            `Đã xác nhận thanh toán đơn hàng #${asString(order.order_code)}`,
            "Cảm ơn bạn! Kho Velura đang tiến hành đóng gói và chuẩn bị đơn hàng cho bạn.",
            `/account/orders/${asString(order.order_id)}`
          );
        } catch {
          /* ignore */
        }
      }

      return sendJson(res, 200, {
        success: true,
        message: "Xác nhận thanh toán thành công",
        order: {
          ...order,
          status: "confirmed"
        }
      }, corsHeaders);
    }

    // POST /api/user/orders/otp-send (Send OTP)
    if (action === "otp-send" && req.method === "POST") {
      const body = await readJson(req);
      let { phone, email, full_name } = body;
      
      if (!phone) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại là bắt buộc");
      }

      // Chuẩn hóa số điện thoại Việt Nam (+84 hoặc 84 -> 0)
      let cleanPhone = String(phone).trim().replace(/[\s.-]/g, "");
      if (cleanPhone.startsWith("+84")) {
        cleanPhone = "0" + cleanPhone.slice(3);
      } else if (cleanPhone.startsWith("84") && cleanPhone.length === 11) {
        cleanPhone = "0" + cleanPhone.slice(2);
      }
      phone = cleanPhone;

      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)");
      }
      const otpEmail = requireGuestOtpEmail(email);
      if (config.nodeEnv === "production" && (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword)) {
        throw new HttpError(503, "OTP_EMAIL_UNAVAILABLE", "Chưa cấu hình email để gửi mã OTP. Không gửi mã giả qua số điện thoại.");
      }
      
      const existingUser = await selectOne("users", { phone: `eq.${phone}` });
      const existingUserByEmail = email ? await selectOne("users", { email: `eq.${email}` }) : null;
      // Nếu số điện thoại hoặc email đã thuộc thành viên, KHÔNG CHẶN mà vẫn gửi OTP về email bình thường
      const userId = existingUser ? existingUser.user_id : (existingUserByEmail ? existingUserByEmail.user_id : null);
      
      const otpCode = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
      const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      
      if (config.nodeEnv !== "production") {
        console.log(`\n==================================================`);
        console.log(`[CHECKOUT GUEST OTP] Checkout OTP for ${phone}: ${otpCode}`);
        console.log(`==================================================\n`);
      } else {
        console.log(`[CHECKOUT GUEST OTP] OTP requested for ${phone}`);
      }
      
      // Store OTP and guest info in memory instead of DB
      checkoutOtpAttemptsMap.set(asString(phone), { 
        otpCode, 
        expiresAt: new Date(otpExpiresAt).getTime(),
        email: email || null,
        full_name: full_name || (existingUser ? existingUser.full_name : "Khách hàng"),
        attempts: 0 
      });
      
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
        await sendDirectEmail(otpEmail, "Mã xác thực đơn hàng Velura", emailBody, emailHtml);
        
        // Vẫn cố gắng lưu vết vào email_outbox nếu RLS cho phép
        try {
          await insertRow("email_outbox", {
            recipient: otpEmail,
            template_code: "otp_verification",
            subject: "Mã xác thực đơn hàng Velura",
            body: emailBody,
            status: "sent", // Already sent directly, don't let worker resend
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      
      return sendJson(res, 200, {
        success: true,
        message: "Mã OTP đã được gửi tới email.",
        channel: "email",
        masked_email: maskEmail(otpEmail),
        dev_bypass: allowDevOtpBypass(),
        phone,
        user_id: userId
      }, corsHeaders);
    }

    // POST /api/user/orders/otp-verify (Verify OTP and Place Order)
    if (action === "otp-verify" && req.method === "POST") {
      const body = await readJson(req);
      const order = asJsonObject(body.order);
      let phone = body.phone || order.shipping_phone;
      if (phone) {
        let cleanPhone = String(phone).trim().replace(/[\s.-]/g, "");
        if (cleanPhone.startsWith("+84")) {
          cleanPhone = "0" + cleanPhone.slice(3);
        } else if (cleanPhone.startsWith("84") && cleanPhone.length === 11) {
          cleanPhone = "0" + cleanPhone.slice(2);
        }
        phone = cleanPhone;
      }
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
      
      if (!phone || !otp_code || !shipping_name || !shipping_address || !Array.isArray(rawItems) || !rawItems.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thông tin xác thực hoặc đơn hàng không đầy đủ");
      }
      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)");
      }

      const items = rawItems.map((item) => asJsonObject(item));
      const phoneKey = asString(phone);
      
      const sessionState = checkoutOtpAttemptsMap.get(phoneKey);
      if (!sessionState) {
        throw new HttpError(400, "INVALID_OTP", "Không tìm thấy phiên xác thực. Vui lòng nhận lại mã OTP.");
      }
      
      if (sessionState.attempts >= 5) {
        throw new HttpError(403, "SESSION_LOCKED", "Phiên xác thực bị khóa do nhập sai quá 5 lần. Vui lòng đặt lại đơn hàng.");
      }

      if (sessionState.expiresAt < Date.now()) {
        throw new HttpError(400, "EXPIRED_OTP", "Mã xác thực đã hết hạn.");
      }

      if (sessionState.otpCode !== otp_code) {
        if (!allowDevOtpBypass() || otp_code !== "1234") {
          sessionState.attempts += 1;
          checkoutOtpAttemptsMap.set(phoneKey, sessionState);
          
          if (sessionState.attempts >= 5) {
            checkoutOtpAttemptsMap.delete(phoneKey);
            throw new HttpError(403, "SESSION_LOCKED", "Phiên xác thực bị khóa do nhập sai quá 5 lần. Vui lòng đặt lại đơn hàng.");
          } else {
            throw new HttpError(400, "INVALID_OTP", `Mã OTP không hợp lệ. Bạn còn ${5 - sessionState.attempts} lần thử.`);
          }
        }
      }
      
      // Chốt tiền trước khi tiêu mã OTP. Giá lệch bảng giá hoặc mã giảm giá vừa đổi
      // (409 VOUCHER_CHANGED) thì khách phải xác nhận lại tổng mới; nếu OTP đã bị xoá
      // thì khách phải xin mã lần nữa chỉ vì một mã giảm giá, và tài khoản khách bên
      // dưới đã được tạo thừa.
      const guestPriced = await priceClaimedOrder(items, shipping_fee, body.shipping_method || order.shipping_method);
      const guestVoucher = await resolveOrderVoucher(
        context,
        guestPriced.subtotal,
        guestPriced.shippingFee,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true || order.decline_voucher === true,
        guestPriced.cart
      );

      // OTP is valid
      checkoutOtpAttemptsMap.delete(phoneKey);
      
      // Stock check
      const affectedItems: JsonObject[] = [];
      for (const item of items) {
        const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
        if (!variant) {
          throw new HttpError(400, "NOT_FOUND", `Không tìm thấy biến thể sản phẩm`);
        }
        const availableStock = Number(variant.stock_quantity) - Number(variant.reserved_quantity || 0);
        if (Number(item.quantity) > availableStock) {
          affectedItems.push({
            variant_id: item.variant_id,
            product_name: item.product_name,
            color: item.color,
            size: item.size,
            requested: item.quantity,
            available: Math.max(0, availableStock)
          });
        }
      }
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
      
      const tempPassword = "VLR" + Math.floor(100000 + Math.random() * 900000).toString();
      const hashedPassword = hashPassword(tempPassword);
      const savedAddresses = [{
        name: shipping_name,
        phone: phone,
        detail: shipping_address,
        is_default: true
      }];
      
      let guestUser: JsonObject | null = await selectOne("users", { phone: `eq.${phone}` });
      if (!guestUser && sessionState.email) {
        guestUser = await selectOne("users", { email: `eq.${sessionState.email}` });
      }
      const isExistingMember = Boolean(guestUser && guestUser.is_active);
      if (!guestUser) {
        guestUser = asJsonObject(await insertRow("users", {
          full_name: sessionState.full_name,
          phone: phone,
          email: sessionState.email,
          password_hash: hashedPassword,
          role: "member",
          is_active: true,
          saved_addresses: savedAddresses,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }));
      } else if (!guestUser.is_active) {
        await updateRows("users", { user_id: `eq.${guestUser.user_id}` }, {
          is_active: true,
          otp_code: null,
          otp_expires_at: null,
          password_hash: hashedPassword,
          saved_addresses: savedAddresses,
          updated_at: new Date().toISOString()
        });
        guestUser.email = guestUser.email || sessionState.email;
      }

      const orderCode = generateOrderCode();
      assertStripeReady(payment_method);
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";
      const guestTotal = Math.max(0, guestPriced.subtotal + guestPriced.shippingFee - guestVoucher.discountAmount);

      const shipping_email = body.shipping_email || order.shipping_email;
      if (shipping_email || guestUser.email) {
        const targetEmail = shipping_email || guestUser.email;
        const emailBody = `Chào ${shipping_name},\n\nĐơn hàng ${orderCode} của bạn đã được đặt thành công!\nTổng giá trị: ${guestTotal.toLocaleString('vi-VN')} đ\nPhương thức thanh toán: ${dbPaymentMethod === "COD" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán trực tuyến"}\nĐịa chỉ nhận: ${shipping_address}\n\nTra cứu đơn hàng tại: https://velura.royalai.dev/account/track?code=${orderCode}\n\nThông tin đăng nhập tài khoản:\n- Số điện thoại: ${phone}\n- Mật khẩu tạm thời: ${tempPassword}`;
        
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
              </div>

              <div style="text-align: center; margin: 28px 0;">
                <a href="https://velura.royalai.dev/account/track?code=${orderCode}&contact=${encodeURIComponent(String(phone || ''))}" style="display: inline-block; background-color: #7C5454; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600;">Tra cứu tiến độ đơn hàng</a>
              </div>

              ${!isExistingMember ? `
              <div style="background-color: #f5f5f5; padding: 16px; border-radius: 6px; margin-top: 20px;">
                <h4 style="margin: 0 0 8px 0; font-size: 14px; color: #555;">Tài khoản thành viên tự động tạo:</h4>
                <p style="margin: 4px 0; font-size: 13px; color: #666;">Số điện thoại: <strong>${phone}</strong> | Mật khẩu: <span style="font-family: monospace; font-weight: bold;">${tempPassword}</span></p>
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
        
        await sendDirectEmail(targetEmail, `Xác nhận đơn hàng #${orderCode} tại Velura`, emailBody, emailHtml);
        
        try {
          await insertRow("email_outbox", {
            recipient: targetEmail,
            template_code: "order_confirmation",
            subject: `Xác nhận đơn hàng #${orderCode} tại Velura`,
            body: emailBody,
            status: "sent",
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }
      
      const guestInternalNote = formatOrderInternalNote(body, formatOrderInternalNote(order));

      const newOrder = asJsonObject(await insertRow("orders", {
        user_id: guestUser.user_id,
        // OPEN-05: đơn online vào Chờ thanh toán ngay khi tạo.
        status: dbPaymentMethod === "COD" ? "pending" : "waiting_payment",
        shipping_name,
        shipping_phone: phone,
        shipping_address,
        shipping_fee: guestPriced.shippingFee,
        voucher_id: guestVoucher.voucherId,
        discount_amount: guestVoucher.discountAmount,
        subtotal: guestPriced.subtotal,
        total_amount: guestTotal,
        payment_method: dbPaymentMethod,
        order_code: orderCode,
        internal_note: guestInternalNote || null,
        // COD trừ kho ngay lúc tạo; đơn online trừ kho khi tiền về (action payment_succeeded).
        stock_committed_at: dbPaymentMethod === "COD" ? new Date().toISOString() : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));

      if (dbPaymentMethod !== "COD") {
        try {
          const provider = String(payment_method || "online_payment").toLowerCase();
          await insertRow("payment", {
            order_id: newOrder.order_id,
            amount: guestTotal,
            payment_method: provider.toUpperCase(),
            payment_provider: provider,
            payment_status: "pending",
            transaction_id: `pay_${provider}_${orderCode}`,
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }
      
      const createdItems: unknown[] = [];
      for (const item of items) {
        const pricedLine = guestPriced.items.find((line) => line.variantId === String(item.variant_id));
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: pricedLine?.productName || item.product_name,
          product_image: item.product_image || null,
          quantity: pricedLine?.quantity || item.quantity,
          unit_price: pricedLine?.unitPrice,
          subtotal_item: pricedLine?.subtotal
        });
        createdItems.push(orderItem);
        
        if (dbPaymentMethod === "COD") {
          try {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          } catch (e: unknown) {
            console.error(`Failed to decrement stock:`, errorMessage(e));
          }
        }
      }
      
      if (guestVoucher.voucherId) {
        await recordVoucherRedemption(guestVoucher.voucherId, guestVoucher.discountAmount);
      }

      // Send welcome notification
      await createNotification(
        asString(guestUser.user_id),
        "system",
        "Chào mừng bạn đến với Velura! 🎉",
        "Chúc mừng bạn đã đăng ký tài khoản thành viên thành công. Nhận ngay ưu đãi thành viên và bắt đầu mua sắm ngay!",
        "/src/pages/products/list.html"
      );

      // Send order placed notification
      await createNotification(
        asString(guestUser.user_id),
        "order_status",
        `Đơn hàng #${orderCode} đã được đặt thành công`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/account/orders/${newOrder.order_id}`
      );
      
      const token = signJwt({ user_id: guestUser.user_id, email: guestUser.email || `${phone}@velura.vn`, role: "member" });
      
      return sendJson(res, 200, {
        success: true,
        token,
        user: {
          user_id: guestUser.user_id,
          email: guestUser.email,
          phone: guestUser.phone,
          full_name: guestUser.full_name,
          role: "member"
        },
        order: presentOrderForCustomer(newOrder, createdItems as JsonObject[], []),
        temp_password: tempPassword,
        stripe: await openStripePayment(newOrder.order_id, newOrder.total_amount, payment_method)
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
      let cleanPhone = String(shipping_phone || "").trim().replace(/[\s.-]/g, "");
      if (cleanPhone.startsWith("+84")) {
        cleanPhone = "0" + cleanPhone.slice(3);
      } else if (cleanPhone.startsWith("84") && cleanPhone.length === 11) {
        cleanPhone = "0" + cleanPhone.slice(2);
      }
      const validPhone = cleanPhone;

      if (!validatePhone(validPhone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại giao hàng không hợp lệ (10 số, bắt đầu bằng 0)");
      }

      const profile = requireUserAuth(context);
      const orderItems = items.map((item) => asJsonObject(item));

      // Stock check
      const affectedItems: JsonObject[] = [];
      for (const item of orderItems) {
        const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
        if (!variant) {
          throw new HttpError(400, "NOT_FOUND", `Không tìm thấy biến thể sản phẩm`);
        }
        const availableStock = Number(variant.stock_quantity) - Number(variant.reserved_quantity || 0);
        if (Number(item.quantity) > availableStock) {
          affectedItems.push({
            variant_id: item.variant_id,
            product_name: item.product_name,
            color: item.color,
            size: item.size,
            requested: item.quantity,
            available: Math.max(0, availableStock)
          });
        }
      }
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
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";
      const memberPriced = await priceClaimedOrder(orderItems, shipping_fee, body.shipping_method);
      const memberVoucher = await resolveOrderVoucher(
        context,
        memberPriced.subtotal,
        memberPriced.shippingFee,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true,
        memberPriced.cart
      );
      const memberTotal = Math.max(0, memberPriced.subtotal + memberPriced.shippingFee - memberVoucher.discountAmount);

      // Create order row
      const newOrder = asJsonObject(await insertRow("orders", {
        user_id: profile.user_id,
        status: dbPaymentMethod === "COD" ? "pending" : "waiting_payment",
        shipping_name,
        shipping_phone: validPhone,
        shipping_address,
        shipping_fee: memberPriced.shippingFee,
        voucher_id: memberVoucher.voucherId,
        discount_amount: memberVoucher.discountAmount,
        subtotal: memberPriced.subtotal,
        total_amount: memberTotal,
        payment_method: dbPaymentMethod,
        order_code: orderCode,
        internal_note: formatOrderInternalNote(body) || null,
        // COD trừ kho ngay lúc tạo; đơn online trừ kho khi tiền về (action payment_succeeded).
        stock_committed_at: dbPaymentMethod === "COD" ? new Date().toISOString() : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));

      if (dbPaymentMethod !== "COD") {
        try {
          const provider = String(payment_method || "online_payment").toLowerCase();
          await insertRow("payment", {
            order_id: newOrder.order_id,
            amount: memberTotal,
            payment_method: provider.toUpperCase(),
            payment_provider: provider,
            payment_status: "pending",
            transaction_id: `pay_${provider}_${orderCode}`,
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }

      // Insert order items & update variant stock reservations
      const createdItems: unknown[] = [];
      for (const item of orderItems) {
        const pricedLine = memberPriced.items.find((line) => line.variantId === String(item.variant_id));
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: pricedLine?.productName || item.product_name,
          product_image: item.product_image || null,
          quantity: pricedLine?.quantity || item.quantity,
          unit_price: pricedLine?.unitPrice,
          subtotal_item: pricedLine?.subtotal
        });
        createdItems.push(orderItem);

        if (dbPaymentMethod === "COD") {
          try {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          } catch (e: unknown) {
            console.error(`Failed to decrement stock:`, errorMessage(e));
          }
        }
      }

      if (memberVoucher.voucherId) {
        await recordVoucherRedemption(memberVoucher.voucherId, memberVoucher.discountAmount);
      }

      const memberTargetEmail = body.shipping_email || profile.email;
      if (memberTargetEmail) {
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
        stripe: await openStripePayment(newOrder.order_id, newOrder.total_amount, payment_method)
      }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route orders not found");
}

function assertStripeReady(method: unknown): void {
  if (String(method || "").toUpperCase() !== "STRIPE") return;
  if (!stripeConfigured()) {
    throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Chưa cấu hình STRIPE_SECRET_KEY. Chọn thanh toán khi nhận hàng hoặc cấu hình Stripe.");
  }
}

async function priceClaimedOrder(
  rawItems: Array<Record<string, unknown>>,
  claimedFee: unknown,
  claimedMethod: unknown
) {
  const lines = rawItems.map((item) => ({
    variantId: String(item.variant_id || ""),
    quantity: Number(item.quantity),
    claimedUnitPrice: Number(item.unit_price)
  }));
  // Một truy vấn cho cả giỏ thay vì hai truy vấn cho mỗi dòng. Cùng nguồn với ví mã, nên
  // số tiền giảm trong ví và số tiền trừ khi đặt đơn không lệch nhau.
  const [catalog, tree] = await Promise.all([
    loadCatalog(lines.map((line) => line.variantId)),
    loadCategoryTree()
  ]);
  const priced = priceOrder(lines, catalog, shippingMethodFromClaim(claimedFee, claimedMethod));
  if (!priced.ok) {
    throw new HttpError(400, priced.code, priced.message, {
      variant_id: priced.variantId,
      claimed_unit_price: priced.claimedUnitPrice,
      catalog_unit_price: priced.catalogUnitPrice
    });
  }
  const { lines: cartLines } = buildCartLines(
    priced.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
    catalog,
    tree
  );
  return { ...priced, cart: { lines: cartLines, categoryNameById: tree.nameById } };
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
