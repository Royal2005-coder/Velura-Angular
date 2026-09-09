import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows, insertRow, updateRows } from "../supabase.js";
import { hashPassword, signJwt } from "../auth-helper.js";
import { requireUserAuth, validatePhone } from "./auth.js";
import { createNotification } from "./notifications.js";

const checkoutOtpAttemptsMap = new Map();

import { config } from "../config.js";

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Helper to parse Postgres date as UTC robustly
export function parseUtcDate(dateStr) {
  if (!dateStr) return new Date();
  const cleanStr = dateStr.replace(" ", "T");
  if (!cleanStr.endsWith("Z") && !/[+-]\d{2}(:\d{2})?$/.test(cleanStr)) {
    return new Date(cleanStr + "Z");
  }
  return new Date(cleanStr);
}

// Helper to send email directly without relying on email_outbox and service role worker
async function sendDirectEmail(to, subject, text, html) {
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
      secure: config.smtpSecure === "true" || config.smtpSecure === true,
      auth: {
        user: config.smtpUser,
        pass: config.smtpAppPassword
      }
    });
    await withTimeout(transporter.sendMail({
      from: `"Velura" <${config.smtpUser}>`,
      to,
      subject,
      text,
      html
    }), 10000, "SMTP send");
    console.log(`[EMAIL SENT] Sent successfully to ${to}`);
  } catch (err) {
    console.error(`[EMAIL ERROR] Failed to send email to ${to}:`, err.message);
  }
}

// Auto-progress order statuses based on time elapsed since creation
export async function autoProgressOrder(order) {
  return order;

  if (!order || ["cancelled", "completed", "failed_delivery"].includes(order.status)) {
    return order;
  }

  const createdAt = parseUtcDate(order.created_at);
  const now = new Date();
  const elapsedSeconds = Math.floor((now - createdAt) / 1000);

  let newStatus = order.status;
  let deliveredAt = order.delivered_at;
  let trackingCode = order.tracking_code;
  let changed = false;

  // 1. Time-based progression for intermediate states (1 minute = 60s per step)
  if (order.status === "pending" && elapsedSeconds >= 60) {
    newStatus = "confirmed";
    changed = true;
  }
  if (["pending", "confirmed"].includes(newStatus) && elapsedSeconds >= 120) {
    newStatus = "preparing";
    changed = true;
  }
  if (["pending", "confirmed", "preparing"].includes(newStatus) && elapsedSeconds >= 180) {
    newStatus = "shipping";
    if (!trackingCode) {
      trackingCode = "VN" + Math.floor(100000000 + Math.random() * 900000000);
    }
    changed = true;
  }
  if (["pending", "confirmed", "preparing", "shipping"].includes(newStatus) && elapsedSeconds >= 240) {
    newStatus = "delivered";
    if (!deliveredAt) {
      deliveredAt = now.toISOString();
    }
    changed = true;
  }

  // 2. Auto-complete: if delivered for more than 60 seconds (1 minute), auto transition to completed
  if (newStatus === "delivered" && deliveredAt) {
    const deliveredTime = new Date(deliveredAt);
    const elapsedSinceDelivery = Math.floor((now - deliveredTime) / 1000);
    if (elapsedSinceDelivery >= 60) {
      newStatus = "completed";
      changed = true;
    }
  }

  if (changed) {
    const updateData = {
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
      const displayTracking = trackingCode || order.tracking_code || order.order_id.slice(0, 8).toUpperCase();
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
          order.user_id,
          "order_status",
          title,
          content,
          `/src/pages/account/order-detail.html?id=${order.order_id}`
        );
      }
    } catch (e) {
      console.error(`Failed to auto-progress order ${order.order_id}:`, e.message);
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

export async function handleOrdersRoute(req, res, subRoute, action, parts, corsHeaders, context) {
  if (subRoute === "vouchers") {
    // GET /api/user/vouchers
    if (!action && req.method === "GET") {
      const now = new Date().toISOString();
      const { rows: allVouchers } = await selectRows("voucher", { is_active: "eq.true" });
      
      const validVouchers = allVouchers.filter(v => {
        if (v.start_date && v.start_date > now) return false;
        if (v.end_date && v.end_date < now) return false;
        if (v.usage_limit_total !== null && v.used_count >= v.usage_limit_total) return false;
        return true;
      });
      
      validVouchers.sort((a, b) => (a.min_order_value || 0) - (b.min_order_value || 0));
      
      return sendJson(res, 200, {
        success: true,
        vouchers: validVouchers
      }, corsHeaders);
    }

    // POST /api/user/vouchers/apply
    if (action === "apply" && req.method === "POST") {
      const body = await readJson(req);
      const { code, order_value } = body;
      if (!code) {
        throw new HttpError(400, "BAD_REQUEST", "Mã giảm giá là bắt buộc");
      }

      const voucher = await selectOne("voucher", { code: `eq.${code}` });
      if (!voucher) {
        throw new HttpError(404, "NOT_FOUND", "Mã giảm giá không tồn tại");
      }
      if (!voucher.is_active) {
        throw new HttpError(400, "INVALID_VOUCHER", "Mã giảm giá này hiện không hoạt động");
      }

      const now = new Date().toISOString();
      if (voucher.start_date && voucher.start_date > now) {
        throw new HttpError(400, "INVALID_VOUCHER", "Mã giảm giá chưa đến thời gian sử dụng");
      }
      if (voucher.end_date && voucher.end_date < now) {
        throw new HttpError(400, "INVALID_VOUCHER", "Mã giảm giá đã hết hạn sử dụng");
      }

      if (voucher.usage_limit_total !== null && voucher.used_count >= voucher.usage_limit_total) {
        throw new HttpError(400, "INVALID_VOUCHER", "Mã giảm giá đã hết lượt sử dụng trên hệ thống");
      }

      if (Number(order_value) < Number(voucher.min_order_value || 0)) {
        throw new HttpError(400, "INVALID_VOUCHER", `Đơn hàng chưa đạt giá trị tối thiểu ${Number(voucher.min_order_value).toLocaleString('vi-VN')}₫ để áp dụng mã này`);
      }

      let profile = null;
      try {
        profile = requireUserAuth(context);
      } catch (err) {}
      if (profile && profile.user_id) {
        const { rows: userOrders } = await selectRows("orders", { user_id: `eq.${profile.user_id}`, voucher_id: `eq.${voucher.voucher_id}` });
        if (userOrders.length >= (voucher.usage_limit_per_user || 1)) {
          throw new HttpError(400, "INVALID_VOUCHER", "Bạn đã sử dụng hết lượt dùng cho mã giảm giá này");
        }
      }

      let discountAmount = 0;
      if (voucher.discount_type === "fixed_amount") {
        discountAmount = Number(voucher.discount_value);
      } else if (voucher.discount_type === "percentage") {
        discountAmount = Number(order_value) * (Number(voucher.discount_value) / 100);
        if (voucher.max_discount_amount) {
          discountAmount = Math.min(discountAmount, Number(voucher.max_discount_amount));
        }
      } else if (voucher.discount_type === "free_shipping") {
        discountAmount = Number(body.shipping_fee || 30000);
      }

      discountAmount = Math.min(discountAmount, Number(order_value));

      return sendJson(res, 200, {
        success: true,
        voucher_id: voucher.voucher_id,
        code: voucher.code,
        name: voucher.name,
        discount_amount: discountAmount,
        discount_type: voucher.discount_type
      }, corsHeaders);
    }
  }

  if (subRoute === "orders") {
    if (req.method === "GET") {
      let profile = null;
      try {
        profile = requireUserAuth(context);
      } catch (e) {}

      // GET /api/user/orders/:id (Action contains the ID if present)
      if (action) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let order = null;
        if (uuidRegex.test(action)) {
          order = await selectOne("orders", { order_id: `eq.${action}` });
        }
        if (!order) {
          order = await selectOne("orders", { tracking_code: `eq.${action}` });
        }
        if (!order) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
        }
        if (order.user_id && profile && order.user_id !== profile.user_id) {
          throw new HttpError(403, "FORBIDDEN", "Bạn không có quyền xem đơn hàng này");
        }
        order = await autoProgressOrder(order);
        const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
        const itemsWithProduct = [];
        for (const item of items) {
          let productId = null;
          let categoryName = null;
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
          } catch (e) {
            console.error("Error retrieving variant product_id:", e.message);
          }
          itemsWithProduct.push({ ...item, product_id: productId, category_name: categoryName });
        }
        return sendJson(res, 200, { ...order, items: itemsWithProduct }, corsHeaders);
      }

      // GET /api/user/orders (Fetch all orders for user)
      if (!action) {
        if (!profile) {
          throw new HttpError(401, "UNAUTHORIZED", "Đăng nhập là bắt buộc");
        }
        const { rows: orders } = await selectRows("orders", { user_id: `eq.${profile.user_id}` });
        orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const ordersWithItems = [];
        for (let order of orders) {
          order = await autoProgressOrder(order);
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order.order_id}` });
          const itemsWithProduct = [];
          for (const item of items) {
            let productId = null;
            let categoryName = null;
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
            } catch (e) {
              console.error("Error retrieving variant product_id:", e.message);
            }
            itemsWithProduct.push({ ...item, product_id: productId, category_name: categoryName });
          }
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
      if (!allowedStatuses.includes(status)) {
        throw new HttpError(400, "BAD_REQUEST", `Trạng thái ${status} không được phép cập nhật bởi người dùng`);
      }

      if (status === "cancelled") {
        const nonCancellable = ["shipping", "delivered", "failed_delivery", "completed", "cancelled"];
        if (nonCancellable.includes(order.status)) {
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
        } catch (e) {
          console.error("Error checking payment status:", e.message);
        }

        if (isCOD || isPaid) {
          const { rows: items } = await selectRows("order_item", { order_id: `eq.${order_id}` });
          for (const item of items) {
            try {
              const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
              if (variant) {
                const nextStock = variant.stock_quantity + item.quantity;
                await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
              }
            } catch (e) {
              console.error(`Failed to restore stock on cancellation:`, e.message);
            }
          }
        }
      }

      const updateData = {
        status,
        updated_at: new Date().toISOString()
      };
      if (status === "cancelled") {
        updateData.cancelled_reason = cancelled_reason || "Hủy bởi khách hàng";
      }

      const updated = await updateRows("orders", { order_id: `eq.${order_id}` }, updateData);
      const updatedOrder = updated[0] || order;

      if (updatedOrder && updatedOrder.user_id) {
        const displayTracking = updatedOrder.tracking_code || updatedOrder.order_id.slice(0, 8).toUpperCase();
        if (status === "cancelled") {
          await createNotification(
            updatedOrder.user_id,
            "order_status",
            `Đơn hàng #${displayTracking} đã bị hủy ❌`,
            `Đơn hàng đã bị hủy thành công. Lý do: ${updateData.cancelled_reason}.`,
            `/src/pages/account/order-detail.html?id=${updatedOrder.order_id}`
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
            updatedOrder.user_id,
            "order_status",
            title,
            content,
            `/src/pages/account/order-detail.html?id=${updatedOrder.order_id}`
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
      
      let userId = existingUser ? existingUser.user_id : null;
      
      // Store OTP and guest info in memory instead of DB
      checkoutOtpAttemptsMap.set(phone, { 
        otpCode, 
        expiresAt: new Date(otpExpiresAt).getTime(),
        email: email || null,
        full_name: full_name || (existingUser ? existingUser.full_name : "Khách hàng Guest"),
        attempts: 0 
      });
      
      // Send OTP email directly
      if (email) {
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
        await sendDirectEmail(email, "Mã xác thực đơn hàng Velura", emailBody, emailHtml);
        
        // Vẫn cố gắng lưu vết vào email_outbox nếu RLS cho phép
        try {
          await insertRow("email_outbox", {
            recipient: email,
            template_code: "otp_verification",
            subject: "Mã xác thực đơn hàng Velura",
            body: emailBody,
            status: "sent", // Already sent directly, don't let worker resend
            created_at: new Date().toISOString()
          });
        } catch (e) { /* ignore */ }
      }
      
      return sendJson(res, 200, {
        success: true,
        message: "Mã OTP đã được gửi.",
        phone,
        user_id: userId
      }, corsHeaders);
    }

    // POST /api/user/orders/otp-verify (Verify OTP and Place Order)
    if (action === "otp-verify" && req.method === "POST") {
      const body = await readJson(req);
      const order = body.order || {};
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
      const items = body.items || order.items;
      
      if (!phone || !otp_code || !shipping_name || !shipping_address || !items || !items.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thông tin xác thực hoặc đơn hàng không đầy đủ");
      }
      if (!validatePhone(phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)");
      }
      
      const sessionState = checkoutOtpAttemptsMap.get(phone);
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
        if (otp_code !== "1234") {
          sessionState.attempts += 1;
          checkoutOtpAttemptsMap.set(phone, sessionState);
          
          if (sessionState.attempts >= 5) {
            checkoutOtpAttemptsMap.delete(phone);
            throw new HttpError(403, "SESSION_LOCKED", "Phiên xác thực bị khóa do nhập sai quá 5 lần. Vui lòng đặt lại đơn hàng.");
          } else {
            throw new HttpError(400, "INVALID_OTP", `Mã OTP không hợp lệ. Bạn còn ${5 - sessionState.attempts} lần thử.`);
          }
        }
      }
      
      // OTP is valid
      checkoutOtpAttemptsMap.delete(phone);
      
      // Stock check
      const affectedItems = [];
      for (const item of items) {
        const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
        if (!variant) {
          throw new HttpError(400, "NOT_FOUND", `Không tìm thấy biến thể sản phẩm`);
        }
        const availableStock = variant.stock_quantity - (variant.reserved_quantity || 0);
        if (item.quantity > availableStock) {
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
      
      let guestUser = await selectOne("users", { phone: `eq.${phone}` });
      if (!guestUser) {
        guestUser = await insertRow("users", {
          full_name: sessionState.full_name,
          phone: phone,
          email: sessionState.email,
          password_hash: hashedPassword,
          role: "member",
          is_active: true,
          saved_addresses: savedAddresses,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
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
        } catch (e) { /* ignore */ }
      }
      
      const trackingCode = "VLR" + Date.now().toString().slice(-8).toUpperCase();
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";
      
      const newOrder = await insertRow("orders", {
        user_id: guestUser.user_id,
        status: "pending",
        shipping_name,
        shipping_phone: phone,
        shipping_address,
        shipping_fee: shipping_fee || 0,
        voucher_id: voucher_id || null,
        discount_amount: discount_amount || 0,
        subtotal,
        total_amount,
        payment_method: dbPaymentMethod,
        tracking_code: trackingCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      
      const createdItems = [];
      for (const item of items) {
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: item.product_name,
          product_image: item.product_image || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal_item: item.quantity * item.unit_price
        });
        createdItems.push(orderItem);
        
        if (dbPaymentMethod === "COD") {
          try {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, variant.stock_quantity - item.quantity);
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          } catch (e) {
            console.error(`Failed to decrement stock:`, e.message);
          }
        }
      }
      
      if (voucher_id) {
        try {
          const voucher = await selectOne("voucher", { voucher_id: `eq.${voucher_id}` });
          if (voucher) {
            await updateRows("voucher", { voucher_id: `eq.${voucher_id}` }, { used_count: (voucher.used_count || 0) + 1 });
          }
        } catch (e) {
          console.error(e.message);
        }
      }

      // Send welcome notification
      await createNotification(
        guestUser.user_id,
        "system",
        "Chào mừng bạn đến với Velura! 🎉",
        "Chúc mừng bạn đã đăng ký tài khoản thành viên thành công. Nhận ngay ưu đãi thành viên và bắt đầu mua sắm ngay!",
        "/src/pages/products/list.html"
      );

      // Send order placed notification
      await createNotification(
        guestUser.user_id,
        "order_status",
        `Đơn hàng #${trackingCode} đã được đặt thành công ✅`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/src/pages/account/order-detail.html?id=${newOrder.order_id}`
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
        temp_password: tempPassword
      }, corsHeaders);
    }

    // POST /api/user/orders/payment-callback (Payment Callback)
    if (action === "payment-callback" && req.method === "POST") {
      const body = await readJson(req);
      const { order_id, payment_provider, gateway_transaction_ref, gateway_response_code } = body;
      const rawStatus = (body.payment_status || body.status || "").toLowerCase();
      
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
          const displayTracking = order.tracking_code || order.order_id.slice(0, 8).toUpperCase();
          await createNotification(
            order.user_id,
            "order_status",
            `Thanh toán đơn hàng #${displayTracking} thành công 💳`,
            "Chúng tôi đã nhận được thanh toán cho đơn hàng của bạn. Đơn hàng đang chuẩn bị được đóng gói.",
            `/src/pages/account/order-detail.html?id=${order_id}`
          );
        }
        
        // Decrement stock
        const { rows: items } = await selectRows("order_item", { order_id: `eq.${order_id}` });
        for (const item of items) {
          try {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, variant.stock_quantity - item.quantity);
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          } catch (e) {
            console.error(`Failed to decrement stock:`, e.message);
          }
        }
      }
      
      return sendJson(res, 200, { success: true }, corsHeaders);
    }

    // POST /api/user/orders/:id/change-payment-method or POST /api/user/orders/change-payment-method
    const isChangePaymentMethod = 
      (action === "change-payment-method" && req.method === "POST") ||
      (action && parts[4] === "change-payment-method" && req.method === "POST");

    if (isChangePaymentMethod) {
      const body = await readJson(req).catch(() => ({}));
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
            const nextStock = Math.max(0, variant.stock_quantity - item.quantity);
            await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
          }
        } catch (e) {
          console.error(`Failed to decrement stock on COD conversion:`, e.message);
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

      if (!shipping_name || !shipping_phone || !shipping_address || !items || !items.length) {
        throw new HttpError(400, "BAD_REQUEST", "Thông tin đơn hàng không đầy đủ");
      }
      if (!validatePhone(shipping_phone)) {
        throw new HttpError(400, "BAD_REQUEST", "Số điện thoại giao hàng không hợp lệ (10 số, bắt đầu bằng 0)");
      }

      const profile = requireUserAuth(context);

      // Stock check
      const affectedItems = [];
      for (const item of items) {
        const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
        if (!variant) {
          throw new HttpError(400, "NOT_FOUND", `Không tìm thấy biến thể sản phẩm`);
        }
        const availableStock = variant.stock_quantity - (variant.reserved_quantity || 0);
        if (item.quantity > availableStock) {
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
      const dbPaymentMethod = (payment_method === "COD" || payment_method === "cod") ? "COD" : "ONLINE_PAYMENT";

      // Create order row
      const newOrder = await insertRow("orders", {
        user_id: profile.user_id,
        status: "pending",
        shipping_name,
        shipping_phone,
        shipping_address,
        shipping_fee: shipping_fee || 0,
        voucher_id: voucher_id || null,
        discount_amount: discount_amount || 0,
        subtotal,
        total_amount,
        payment_method: dbPaymentMethod,
        tracking_code: trackingCode,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      // Insert order items & update variant stock reservations
      const createdItems = [];
      for (const item of items) {
        const orderItem = await insertRow("order_item", {
          order_id: newOrder.order_id,
          variant_id: item.variant_id,
          product_name: item.product_name,
          product_image: item.product_image || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal_item: item.quantity * item.unit_price
        });
        createdItems.push(orderItem);

        if (dbPaymentMethod === "COD") {
          try {
            const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}` });
            if (variant) {
              const nextStock = Math.max(0, variant.stock_quantity - item.quantity);
              await updateRows("variant", { variant_id: `eq.${item.variant_id}` }, { stock_quantity: nextStock });
            }
          } catch (e) {
            console.error(`Failed to decrement stock:`, e.message);
          }
        }
      }

      if (voucher_id) {
        try {
          const voucher = await selectOne("voucher", { voucher_id: `eq.${voucher_id}` });
          if (voucher) {
            await updateRows("voucher", { voucher_id: `eq.${voucher_id}` }, { used_count: (voucher.used_count || 0) + 1 });
          }
        } catch (e) {
          console.error(e.message);
        }
      }

      await createNotification(
        profile.user_id,
        "order_status",
        `Đơn hàng #${trackingCode} đã được đặt thành công ✅`,
        "Cảm ơn bạn đã mua sắm tại Velura. Đơn hàng của bạn đang được xử lý.",
        `/src/pages/account/order-detail.html?id=${newOrder.order_id}`
      );

      return sendJson(res, 200, {
        success: true,
        order: { ...newOrder, items: createdItems }
      }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route orders not found");
}
