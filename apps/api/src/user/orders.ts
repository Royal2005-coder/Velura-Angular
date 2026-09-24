import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { hashPassword, signJwt } from "../auth-helper.js";
import { requireUserAuth, validatePhone } from "./auth.js";
import { createNotification } from "./notifications.js";
import { recordVoucherRedemption, releaseVoucherRedemption, resolveOrderVoucher } from "./vouchers.js";
import { allowDevOtpBypass, config } from "../config.js";
import { createStripePaymentIntent, stripeConfigured } from "../payments/stripe.js";
import { ORDER_TRANSITIONS } from "../orders/order-constants.js";
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
  if (order.user_id !== profile.user_id) {
    throw new HttpError(403, "FORBIDDEN", "Bạn không có quyền xem đơn hàng này");
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

/**
 * Time-based storefront order status progression (currently a no-op return).
 */
export async function autoProgressOrder(order: JsonObject): Promise<JsonObject> {
  return order;

  if (!order || ["cancelled", "completed", "failed_delivery"].includes(asString(order.status))) {
    return order;
  }

  const createdAt = parseUtcDate(order.created_at);
  const now = new Date();
  const elapsedSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);

  let newStatus = order.status;
  let deliveredAt = order.delivered_at;
  let trackingCode = order.tracking_code;
  let changed = false;

  // 1. Time-based progression for intermediate states (1 minute = 60s per step)
  if (order.status === "pending" && elapsedSeconds >= 60) {
    newStatus = "confirmed";
    changed = true;
  }
  if (["pending", "confirmed"].includes(asString(newStatus)) && elapsedSeconds >= 120) {
    newStatus = "preparing";
    changed = true;
  }
  if (["pending", "confirmed", "preparing"].includes(asString(newStatus)) && elapsedSeconds >= 180) {
    newStatus = "shipping";
    if (!trackingCode) {
      trackingCode = "VN" + Math.floor(100000000 + Math.random() * 900000000);
    }
    changed = true;
  }
  if (["pending", "confirmed", "preparing", "shipping"].includes(asString(newStatus)) && elapsedSeconds >= 240) {
    newStatus = "delivered";
    if (!deliveredAt) {
      deliveredAt = now.toISOString();
    }
    changed = true;
  }

  // 2. Auto-complete: if delivered for more than 60 seconds (1 minute), auto transition to completed
  if (newStatus === "delivered" && deliveredAt) {
    const deliveredTime = new Date(String(deliveredAt));
    const elapsedSinceDelivery = Math.floor((now.getTime() - deliveredTime.getTime()) / 1000);
    if (elapsedSinceDelivery >= 60) {
      newStatus = "completed";
      changed = true;
    }
  }

  if (changed) {
    const updateData: JsonObject = {
      status: newStatus,
      updated_at: now.toISOString()
    };
    if (deliveredAt) {
      updateData.delivered_at = deliveredAt;
    }
    if (trackingCode) {
      updateData.tracking_code = trackingCode;
    }
    
    try {
      await updateRows("orders", { order_id: `eq.${order.order_id}` }, updateData);

      // Trigger notification for order status progression
      let title = "";
      let content = "";
      const displayTracking = trackingCode || order.tracking_code || asString(order.order_id).slice(0, 8).toUpperCase();
      switch (newStatus) {
        case "confirmed":
          title = `Đơn hàng #${displayTracking} đã được xác nhận ✅`;
          content = "Người bán đã xác nhận đơn hàng của bạn.";
          break;
        case "preparing":
          title = `Đơn hàng #${displayTracking} đang được chuẩn bị 📦`;
          content = "Velura đang chuẩn bị hàng để gửi cho đơn vị vận chuyển.";
          break;
        case "shipping":
          title = `Đơn hàng #${displayTracking} đang được giao 🚚`;
          content = "Đơn hàng đã được bàn giao cho đơn vị vận chuyển.";
          break;
        case "delivered":
          title = `Đơn hàng #${displayTracking} đã giao thành công 🎉`;
          content = "Đơn hàng đã được giao đến bạn. Hãy kiểm tra sản phẩm và để lại đánh giá nhé!";
          break;
        case "completed":
          title = `Đơn hàng #${displayTracking} hoàn thành ✨`;
          content = "Cảm ơn bạn đã mua sắm tại Velura! Đơn hàng của bạn đã hoàn thành.";
          break;
      }
      if (title && order.user_id) {
        await createNotification(
          asString(order.user_id),
          "order_status",
          title,
          content,
          `/account/orders/${order.order_id}`
        );
      }
    } catch (e: unknown) {
      console.error(`Failed to auto-progress order ${order.order_id}:`, errorMessage(e));
    }
    
    return {
      ...order,
      status: newStatus,
      delivered_at: deliveredAt,
      tracking_code: trackingCode,
      updated_at: updateData.updated_at
    };
  }

  return order;
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

      // GET /api/user/orders/:id (Action contains the ID if present)
      if (action) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let order: JsonObject | null = null;
        if (uuidRegex.test(action)) {
          order = await selectOne("orders", { order_id: `eq.${action}` });
        }
        if (!order) {
          order = await selectOne("orders", { tracking_code: `eq.${action}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }

        assertOrderVisibleTo(order, profile);
        order = await autoProgressOrder(order);
        const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
        const itemsWithProduct = await attachProductMeta(items);
        return sendJson(res, 200, { ...order, items: itemsWithProduct }, corsHeaders);
      }

      // GET /api/user/orders (Fetch all orders for user)
      if (!action) {
        if (!profile) {
          throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc");
        }
        const { rows: orders } = await selectRows("orders", { user_id: `eq.${profile.user_id}` });
        orders.sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
        const ordersWithItems: JsonObject[] = [];
        for (let order of orders) {
          order = await autoProgressOrder(order);
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
          const itemsWithProduct = await attachProductMeta(items);
          ordersWithItems.push({ ...order, items: itemsWithProduct });
        }
        return sendJson(res, 200, { success: true, orders: ordersWithItems }, corsHeaders);
      }
    }

    if (req.method === "PATCH") {
      const profile = requireUserAuth(context);
      const body = await readJson(req);
      const { order_id, status, cancelled_reason } = body;

      if (!order_id || !status) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu order_id hoặc status");
      }

      const order = await selectOne("orders", { order_id: `eq.${order_id}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }

      if (order.user_id !== profile.user_id) {
        throw new HttpError(403, "FORBIDDEN", "Bạn không có quyền cập nhật đơn hàng này");
      }

      const allowedStatuses = ["cancelled", "delivered", "completed"];
      if (!allowedStatuses.includes(asString(status))) {
        throw new HttpError(400, "BAD_REQUEST", `Trạng thái ${status} không được phép cập nhật bởi người dùng`);
      }

      // Ba trạng thái trên là những gì khách được phép ghi, nhưng "được phép ghi" khác
      // với "ghi từ đâu cũng được". Không chốt bảng chuyển trạng thái ở đây thì khách
      // đẩy được đơn từ `shipping` thẳng sang `completed`, bỏ qua `delivered` — đơn
      // thành hoàn tất mà chưa từng ghi nhận đã giao. Nhánh huỷ có danh sách chặn riêng
      // ngay dưới nên bỏ qua ở bước này.
      if (status !== "cancelled") {
        const from = asString(order.status);
        const allowed = ORDER_TRANSITIONS[from] || [];
        if (!allowed.includes(asString(status))) {
          throw new HttpError(400, "INVALID_TRANSITION",
            `Không thể chuyển đơn từ "${from}" sang "${status}"`);
        }
      }

      if (status === "cancelled") {
        const nonCancellable = ["shipping", "delivered", "failed_delivery", "completed", "cancelled"];
        if (nonCancellable.includes(asString(order.status))) {
          throw new HttpError(400, "BAD_REQUEST", "Đơn hàng đã được giao cho đơn vị vận chuyển hoặc đã kết thúc, không thể hủy");
        }
      }

      // Handle stock recovery on cancellation
      if (status === "cancelled" && order.status !== "cancelled") {
        const isCOD = order.payment_method === "COD";
        let isPaid = false;
        try {
          const payment = await selectOne("payment", { order_id: `eq.${order_id}` });
          if (payment && payment.payment_status === "paid") {
            isPaid = true;
          }
        } catch (e: unknown) {
          console.error("Error checking payment status:", errorMessage(e));
        }

        if (isCOD || isPaid) {
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order_id}` });
          for (const item of items) {
            try {
              const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
              if (variant) {
                const nextStock = Number(variant.stock_quantity) + Number(item.quantity);
                await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
              }
            } catch (e: unknown) {
              console.error(`Failed to restore stock on cancellation:`, errorMessage(e));
            }
          }
        }

        // Trả lại lượt dùng mã và ngân sách chiến dịch, nếu không thì một đơn bị hủy
        // vẫn chiếm chỗ của khách khác và vẫn ăn vào ngân sách khuyến mãi.
        if (order.voucher_id) {
          await releaseVoucherRedemption(String(order.voucher_id), Number(order.discount_amount) || 0);
        }
      }

      const updateData: JsonObject = {
        status,
        updated_at: new Date().toISOString()
      };
      if (status === "cancelled") {
        updateData.cancelled_reason = cancelled_reason || "Hủy bởi khách hàng";
      }

      const updated = await updateRows("orders", { order_id: `eq.${order_id}` }, updateData);
      const updatedOrder = asJsonObject(updated[0] || order);

      if (updatedOrder && updatedOrder.user_id) {
        const displayTracking = updatedOrder.tracking_code || asString(updatedOrder.order_id).slice(0, 8).toUpperCase();
        if (status === "cancelled") {
          await createNotification(
            asString(updatedOrder.user_id),
            "order_status",
            `Đơn hàng #${displayTracking} đã bị hủy ❌`,
            `Đơn hàng đã bị hủy thành công. Lý do: ${updateData.cancelled_reason}.`,
            `/account/orders/${updatedOrder.order_id}`
          );
        } else {
          let title = `Cập nhật đơn hàng #${displayTracking}`;
          let content = `Trạng thái đơn hàng của bạn đã thay đổi thành: ${status}.`;
          if (status === "delivered") {
            title = `Đơn hàng #${displayTracking} đã giao thành công 🎉`;
            content = "Đơn hàng đã được giao đến bạn. Hãy kiểm tra sản phẩm và để lại đánh giá nhé!";
          } else if (status === "completed") {
            title = `Đơn hàng #${displayTracking} hoàn thành ✨`;
            content = "Cảm ơn bạn đã mua sắm tại Velura! Đơn hàng của bạn đã hoàn thành.";
          }
          await createNotification(
            asString(updatedOrder.user_id),
            "order_status",
            title,
            content,
            `/account/orders/${updatedOrder.order_id}`
          );
        }
      }

      return sendJson(res, 200, { success: true, order: updatedOrder }, corsHeaders);
    }

    // POST /api/user/orders/otp-send (Send OTP)
    if (action === "otp-send" && req.method === "POST") {
      const body = await readJson(req);
      const { phone, email, full_name } = body;
      
      if (!phone) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại là bắt buộc");
      }
      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)");
      }
      const otpEmail = requireGuestOtpEmail(email);
      if (config.nodeEnv === "production" && (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword)) {
        throw new HttpError(503, "OTP_EMAIL_UNAVAILABLE", "Chưa cấu hình email để gửi mã OTP. Không gửi mã giả qua số điện thoại.");
      }
      
      const existingUser = await selectOne("users", { phone: `eq.${phone}` });
      if (existingUser && existingUser.is_active) {
        throw new HttpError(400, "DUPLICATE_ACCOUNT", "Số điện thoại này đã có tài khoản thành viên. Vui lòng đăng nhập để thanh toán.");
      }

      if (email) {
        const existingUserByEmail = await selectOne("users", { email: `eq.${email}` });
        if (existingUserByEmail) {
          if (existingUserByEmail.is_active) {
            throw new HttpError(400, "DUPLICATE_EMAIL", "Email này đã được sử dụng bởi một tài khoản thành viên. Vui lòng đăng nhập hoặc sử dụng email khác.");
          }
          if (!existingUser || existingUser.user_id !== existingUserByEmail.user_id) {
            throw new HttpError(400, "DUPLICATE_EMAIL", "Email này đã được đăng ký với một số điện thoại khác. Vui lòng sử dụng email khác.");
          }
        }
      }
      
      const otpCode = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digits
      const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      
      if (config.nodeEnv !== "production") {
        console.log(`\n==================================================`);
        console.log(`[CHECKOUT GUEST OTP] Checkout OTP for ${phone}: ${otpCode}`);
        console.log(`==================================================\n`);
      } else {
        console.log(`[CHECKOUT GUEST OTP] OTP requested for ${phone}`);
      }
      
      const userId = existingUser ? existingUser.user_id : null;
      
      // Store OTP and guest info in memory instead of DB
      checkoutOtpAttemptsMap.set(asString(phone), { 
        otpCode, 
        expiresAt: new Date(otpExpiresAt).getTime(),
        email: email || null,
        full_name: full_name || (existingUser ? existingUser.full_name : "Khách hàng Guest"),
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
      const phone = body.phone || order.shipping_phone;
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
          items: affectedItems
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
      } else {
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

      const shipping_email = body.shipping_email || order.shipping_email;
      if (shipping_email || guestUser.email) {
        const targetEmail = shipping_email || guestUser.email;
        const emailBody = `Chào ${shipping_name},\n\nTài khoản thành viên của bạn đã được tạo thành công dựa trên đơn đặt hàng.\n\nThông tin đăng nhập:\n- Số điện thoại: ${phone}\n- Mật khẩu tạm thời: ${tempPassword}\n\nVui lòng đăng nhập và đổi mật khẩu sớm nhất có thể.`;
        
        const emailHtml = `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #222; padding: 24px; text-align: center;">
              <h1 style="color: #d1b8a8; margin: 0; font-size: 32px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
            </div>
            <div style="padding: 32px; background-color: #fff;">
              <h2 style="color: #333; margin-top: 0; font-size: 22px;">Chào mừng thành viên mới!</h2>
              <p style="color: #555; line-height: 1.6;">Chào <strong>${shipping_name}</strong>,</p>
              <p style="color: #555; line-height: 1.6;">Cảm ơn bạn đã đặt hàng! Để giúp bạn dễ dàng theo dõi đơn hàng và nhận các ưu đãi hấp dẫn, tài khoản thành viên của bạn đã được tự động khởi tạo.</p>
              
              <div style="background-color: #fcfaf8; border-left: 4px solid #d1b8a8; padding: 20px; margin: 28px 0; border-radius: 0 8px 8px 0;">
                <h3 style="margin-top: 0; color: #333; font-size: 16px; margin-bottom: 16px;">Thông tin đăng nhập của bạn:</h3>
                <p style="margin: 8px 0; color: #555; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 120px; color: #777;">Tài khoản:</span> 
                  <strong>${phone}</strong>
                </p>
                <p style="margin: 8px 0; color: #555; display: flex; align-items: center;">
                  <span style="display: inline-block; width: 120px; color: #777;">Mật khẩu:</span> 
                  <span style="background-color: #eee; padding: 4px 12px; border-radius: 4px; font-family: monospace; color: #b89b88; font-weight: bold; font-size: 16px; letter-spacing: 1px;">${tempPassword}</span>
                </p>
              </div>
              
              <p style="color: #777; font-size: 14px;">Vui lòng đăng nhập và đổi mật khẩu trong phần <em>Tài khoản</em> của bạn để đảm bảo bảo mật.</p>
            </div>
            <div style="background-color: #f9f9f9; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
              <p style="color: #aaa; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
            </div>
          </div>
        `;
        
        await sendDirectEmail(targetEmail, "Chào mừng bạn đến với Velura", emailBody, emailHtml);
        
        // Cố gắng lưu vết
        try {
          await insertRow("email_outbox", {
            recipient: targetEmail,
            template_code: "member_welcome",
            subject: "Chào mừng bạn đến với Velura",
            body: emailBody,
            status: "sent", // Already sent directly, don't let worker resend
            created_at: new Date().toISOString()
          });
        } catch {
          /* ignore */
        }
      }
      
      const trackingCode = "VLR" + Date.now().toString().slice(-8).toUpperCase();
      assertStripeReady(payment_method);
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";
      const guestMerchandise = Number(subtotal) || 0;
      const guestShipping = Number(shipping_fee) || 0;
      const guestVoucher = await resolveOrderVoucher(
        context,
        guestMerchandise,
        guestShipping,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true || order.decline_voucher === true
      );
      
      const newOrder = asJsonObject(await insertRow("orders", {
        user_id: guestUser.user_id,
        status: "pending",
        shipping_name,
        shipping_phone: phone,
        shipping_address,
        shipping_fee: guestShipping,
        voucher_id: guestVoucher.voucherId,
        discount_amount: guestVoucher.discountAmount,
        subtotal: guestMerchandise,
        total_amount: Math.max(0, guestMerchandise + guestShipping - guestVoucher.discountAmount),
        payment_method: dbPaymentMethod,
        tracking_code: trackingCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));
      
      const createdItems: unknown[] = [];
      for (const item of items) {
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: item.product_name,
          product_image: item.product_image || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal_item: Number(item.quantity) * Number(item.unit_price)
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
        `Đơn hàng #${trackingCode} đã được đặt thành công ✅`,
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
        order: { ...newOrder, items: createdItems },
        temp_password: tempPassword,
        stripe: await openStripePayment(newOrder.order_id, newOrder.total_amount, payment_method)
      }, corsHeaders);
    }

    // POST /api/user/orders/payment-callback (Payment Callback)
    if (action === "payment-callback" && req.method === "POST") {
      const body = await readJson(req);
      const { order_id, payment_provider, gateway_transaction_ref, gateway_response_code } = body;
      const rawStatus = asString(body.payment_status || body.status).toLowerCase();
      
      if (!order_id || !rawStatus) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu order_id hoặc trạng thái thanh toán");
      }
      
      const payment_status = ["paid", "success", "successful"].includes(rawStatus) ? "paid" : "failed";
      
      const order = await selectOne("orders", { order_id: `eq.${order_id}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      
      const existingPayment = await selectOne("payment", { order_id: `eq.${order_id}` });
      const payStatusMapped = payment_status === "paid" ? "paid" : "failed";
      
      if (existingPayment) {
        await updateRows("payment", { payment_id: `eq.${existingPayment.payment_id}` }, {
          payment_status: payStatusMapped,
          payment_provider: payment_provider || existingPayment.payment_provider,
          gateway_transaction_ref: gateway_transaction_ref || existingPayment.gateway_transaction_ref,
          gateway_response_code: gateway_response_code || existingPayment.gateway_response_code,
          paid_at: payment_status === "paid" ? new Date().toISOString() : null
        });
      } else {
        await insertRow("payment", {
          order_id,
          payment_method: "ONLINE_PAYMENT",
          payment_provider: payment_provider || "ONLINE_GATEWAY",
          amount: order.total_amount,
          payment_status: payStatusMapped,
          gateway_transaction_ref: gateway_transaction_ref || null,
          gateway_response_code: gateway_response_code || null,
          paid_at: payment_status === "paid" ? new Date().toISOString() : null,
          created_at: new Date().toISOString()
        });
      }
      
      if (payment_status === "paid") {
        await updateRows("orders", { order_id: `eq.${order_id}` }, {
          status: "confirmed",
          updated_at: new Date().toISOString()
        });

        if (order && order.user_id) {
          const displayTracking = order.tracking_code || asString(order.order_id).slice(0, 8).toUpperCase();
          await createNotification(
            asString(order.user_id),
            "order_status",
            `Thanh toán đơn hàng #${displayTracking} thành công 💳`,
            "Chúng tôi đã nhận được thanh toán cho đơn hàng của bạn. Đơn hàng đang chuẩn bị được đóng gói.",
            `/account/orders/${order_id}`
          );
        }
        
        // Decrement stock
        const { rows: items } = await selectRows("order_item", { order_id: `eq.${order_id}` });
        for (const item of items) {
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
      
      return sendJson(res, 200, { success: true }, corsHeaders);
    }

    // POST /api/user/orders/:id/change-payment-method or POST /api/user/orders/change-payment-method
    const isChangePaymentMethod = 
      (action === "change-payment-method" && req.method === "POST") ||
      (Boolean(action) && parts[4] === "change-payment-method" && req.method === "POST");

    if (isChangePaymentMethod) {
      const body = await readJson(req).catch(() => ({} as JsonObject));
      const targetOrderId = action === "change-payment-method" ? body.order_id : action;
      
      if (!targetOrderId) {
        throw new HttpError(400, "BAD_REQUEST", "Thiếu order_id");
      }
      
      const order = await selectOne("orders", { order_id: `eq.${targetOrderId}` });
      if (!order) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
      }
      
      const updatedOrders = await updateRows("orders", { order_id: `eq.${targetOrderId}` }, {
        payment_method: "COD",
        status: "pending",
        updated_at: new Date().toISOString()
      });
      const updatedOrder = updatedOrders[0] || order;
      
      const { rows: items } = await selectRows("order_item", { order_id: `eq.${targetOrderId}` });
      for (const item of items) {
        try {
          const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
          if (variant) {
            const nextStock = Math.max(0, Number(variant.stock_quantity) - Number(item.quantity));
            await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
          }
        } catch (e: unknown) {
          console.error(`Failed to decrement stock on COD conversion:`, errorMessage(e));
        }
      }
      
      return sendJson(res, 200, { success: true, order: updatedOrder }, corsHeaders);
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
      if (!validatePhone(shipping_phone)) {
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
          items: affectedItems
        }, corsHeaders);
      }

      const trackingCode = "VLR" + Date.now().toString().slice(-8).toUpperCase();
      assertStripeReady(payment_method);
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";
      const memberMerchandise = Number(subtotal) || 0;
      const memberShipping = Number(shipping_fee) || 0;
      const memberVoucher = await resolveOrderVoucher(
        context,
        memberMerchandise,
        memberShipping,
        voucher_id ? String(voucher_id) : null,
        body.decline_voucher === true
      );

      // Create order row
      const newOrder = asJsonObject(await insertRow("orders", {
        user_id: profile.user_id,
        status: "pending",
        shipping_name,
        shipping_phone,
        shipping_address,
        shipping_fee: memberShipping,
        voucher_id: memberVoucher.voucherId,
        discount_amount: memberVoucher.discountAmount,
        subtotal: memberMerchandise,
        total_amount: Math.max(0, memberMerchandise + memberShipping - memberVoucher.discountAmount),
        payment_method: dbPaymentMethod,
        tracking_code: trackingCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));

      // Insert order items & update variant stock reservations
      const createdItems: unknown[] = [];
      for (const item of orderItems) {
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: item.product_name,
          product_image: item.product_image || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal_item: Number(item.quantity) * Number(item.unit_price)
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

      await createNotification(
        profile.user_id,
        "order_status",
        `Đơn hàng #${trackingCode} đã được đặt thành công ✅`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/account/orders/${newOrder.order_id}`
      );

      return sendJson(res, 200, {
        success: true,
        order: { ...newOrder, items: createdItems },
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

async function openStripePayment(orderId: unknown, amount: unknown, method: unknown): Promise<{ payment_intent_id: string; url: string } | null> {
  if (String(method || "").toUpperCase() !== "STRIPE") return null;
  const intent = await createStripePaymentIntent(String(orderId), Number(amount) || 0);
  return { payment_intent_id: intent.id, url: intent.url };
}
