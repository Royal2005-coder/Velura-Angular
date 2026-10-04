import { sendDirectEmail } from "../email/mailer.js";
import { insertRow, selectOne, selectRows } from "../supabase.js";
import { asNumber, asString, type JsonObject } from "../types.js";

export interface RefundEmailOptions {
  method?: "stripe" | "manual" | "completed";
  reference?: string;
}

/**
 * Gửi email thông báo hoàn tiền thành công cho khách hàng khi yêu cầu đổi/trả hoàn tất.
 * Ghi log vào email_outbox để kiểm toán và đảm bảo không gửi trùng lặp.
 */
export async function sendRefundSuccessEmail(
  returnId: string,
  options: RefundEmailOptions = {}
): Promise<boolean> {
  try {
    const returnRecord = await selectOne("return_exchange", {
      select: "return_id,order_id,user_id,return_type,refund_amount,status,tracking_return_code,reason,admin_note",
      return_id: `eq.${returnId}`
    });
    if (!returnRecord) return false;

    // Chỉ gửi khi loại yêu cầu là hoàn tiền
    const returnType = asString(returnRecord.return_type);
    if (returnType !== "refund") return false;

    const orderId = asString(returnRecord.order_id);
    if (!orderId) return false;

    // Kiểm tra xem đã gửi email hoàn tiền cho phiếu này chưa để tránh gửi lặp
    const existingOutbox = await selectRows("email_outbox", {
      select: "email_id,status,created_at,metadata",
      template_code: "eq.return_refund_completed",
      recipient: `neq.`,
      limit: 20
    }).catch(() => ({ rows: [] as JsonObject[] }));

    const alreadySent = existingOutbox.rows?.some((row: JsonObject) => {
      const meta = row.metadata as JsonObject | undefined;
      return meta && asString(meta.return_id) === returnId && row.status === "sent";
    });
    if (alreadySent) {
      console.log(`[REFUND_EMAIL] Email already sent previously for return ${returnId}, skipping duplicate.`);
      return true;
    }

    const order = await selectOne("orders", {
      select: "order_id,user_id,order_code,shipping_name,shipping_email,shipping_phone,payment_method,total_amount",
      order_id: `eq.${orderId}`
    });
    if (!order) return false;

    let customerEmail = asString(order.shipping_email).trim();
    let customerName = asString(order.shipping_name).trim();

    // Nếu đơn hàng chưa có shipping_email, tra cứu qua users table
    const userId = asString(returnRecord.user_id) || asString(order.user_id);
    if ((!customerEmail || !customerName) && userId) {
      const user = await selectOne("users", {
        select: "user_id,email,full_name",
        user_id: `eq.${userId}`
      }).catch(() => null);
      if (user) {
        if (!customerEmail) customerEmail = asString(user.email).trim();
        if (!customerName) customerName = asString(user.full_name).trim();
      }
    }

    const orderCode = asString(order.order_code) || orderId.slice(0, 8).toUpperCase();

    if (!customerEmail || !customerEmail.includes("@")) {
      console.warn(`[REFUND_EMAIL] No valid customer email found for return ${returnId} (order ${orderCode}).`);
      return false;
    }

    customerName = customerName || "Quý khách";

    const trackingCode = asString(returnRecord.tracking_return_code) || returnId.slice(0, 8).toUpperCase();
    const refundAmount = asNumber(returnRecord.refund_amount) || asNumber(order.total_amount) || 0;
    const amountFormatted = refundAmount.toLocaleString("vi-VN") + " đ";

    const paymentMethod = asString(order.payment_method).toUpperCase();
    const isStripe = paymentMethod === "STRIPE" || options.method === "stripe";
    const paymentMethodText = isStripe
      ? "Cổng thanh toán Stripe (hoàn về thẻ thanh toán ban đầu)"
      : (options.reference
          ? `Chuyển khoản ngân hàng trực tiếp (Mã GD: ${options.reference})`
          : "Chuyển khoản ngân hàng trực tiếp");

    const subject = `[Velura] Xác nhận hoàn tiền thành công cho đơn hàng #${orderCode}`;
    const text = `Kính chào ${customerName},

Velura xin thông báo yêu cầu trả hàng và hoàn tiền cho đơn hàng #${orderCode} (Phiếu #${trackingCode}) của bạn đã được xử lý hoàn tất thành công.

THÔNG TIN HOÀN TIỀN:
- Mã đơn hàng: #${orderCode}
- Mã phiếu đổi trả: ${trackingCode}
- Số tiền hoàn lại: ${amountFormatted}
- Phương thức hoàn tiền: ${paymentMethodText}
- Trạng thái: Đã hoàn tiền thành công
- Thời gian xử lý: ${new Date().toLocaleString("vi-VN")}

Thời gian nhận tiền:
• Đối với chuyển khoản ngân hàng: Tiền sẽ về tài khoản của bạn trong vòng 1-24 giờ làm việc.
• Đối với thẻ quốc tế (Stripe): Tiền sẽ hoàn vào hạn mức thẻ trong vòng 3-7 ngày làm việc tùy chính sách ngân hàng phát hành thẻ.

Tra cứu đơn hàng tại: https://velura.royalai.dev/account/track?code=${orderCode}

Trân trọng,
Đội ngũ CSKH Velura`;

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #ffffff;">
        <div style="background-color: #222222; padding: 24px; text-align: center;">
          <h1 style="color: #d1b8a8; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background-color: #ecfdf5; color: #059669; font-size: 28px; font-weight: bold; margin: 0 auto;">✓</div>
            <h2 style="color: #111827; margin: 16px 0 6px; font-size: 22px; font-weight: 700;">Hoàn tiền thành công</h2>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">Phiếu yêu cầu trả hàng #${trackingCode} đã được xử lý hoàn tất</p>
          </div>

          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Kính chào <strong>${customerName}</strong>,
          </p>
          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Velura xin thông báo yêu cầu trả hàng và hoàn tiền cho đơn hàng <strong>#${orderCode}</strong> của bạn đã được kiểm tra và xử lý hoàn tất thành công.
          </p>

          <div style="background-color: #faf7f5; border: 1px solid #f0e6e0; border-left: 4px solid #7C5454; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <h3 style="margin-top: 0; color: #292524; font-size: 16px; margin-bottom: 14px; font-weight: 600;">Chi tiết hoàn tiền:</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã đơn hàng:</td>
                <td style="padding: 6px 0; color: #1c1917; font-weight: 600; text-align: right;">#${orderCode}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã phiếu đổi trả:</td>
                <td style="padding: 6px 0; color: #7C5454; font-weight: 600; text-align: right;">${trackingCode}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Số tiền hoàn lại:</td>
                <td style="padding: 6px 0; color: #059669; font-weight: 700; font-size: 16px; text-align: right;">${amountFormatted}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Phương thức hoàn:</td>
                <td style="padding: 6px 0; color: #1c1917; font-weight: 500; text-align: right;">${paymentMethodText}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Thời gian xử lý:</td>
                <td style="padding: 6px 0; color: #1c1917; text-align: right;">${new Date().toLocaleString("vi-VN")}</td>
              </tr>
            </table>
          </div>

          <div style="background-color: #f3f4f6; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #4b5563; line-height: 1.6;">
              💡 <strong>Thời gian nhận tiền:</strong><br/>
              • <strong>Chuyển khoản ngân hàng:</strong> Tiền sẽ được cộng vào tài khoản của bạn trong vòng 1-24 giờ làm việc.<br/>
              • <strong>Thẻ quốc tế (Visa/Mastercard qua Stripe):</strong> Tiền sẽ hoàn vào hạn mức thẻ trong vòng 3-7 ngày làm việc tùy theo ngân hàng phát hành thẻ.
            </p>
          </div>

          <div style="text-align: center; margin: 28px 0 12px;">
            <a href="https://velura.royalai.dev/account/track?code=${orderCode}" style="display: inline-block; background-color: #7C5454; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 6px; font-weight: 600; font-size: 14px;">Tra cứu chi tiết đơn hàng</a>
          </div>

          <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-top: 24px; text-align: center;">
            Nếu bạn cần thêm bất kỳ sự trợ giúp nào, xin vui lòng liên hệ đội ngũ Chăm sóc khách hàng Velura. Cảm ơn bạn đã luôn tin tưởng và đồng hành cùng Velura.
          </p>
        </div>
        <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
        </div>
      </div>
    `;

    console.log(`[REFUND_EMAIL] Sending refund confirmation email to ${customerEmail} for order #${orderCode}...`);
    const sent = await sendDirectEmail(customerEmail, subject, text, html);

    await insertRow("email_outbox", {
      recipient: customerEmail,
      template_code: "return_refund_completed",
      subject,
      body: text,
      status: sent ? "sent" : "pending",
      related_user_id: userId || null,
      metadata: { return_id: returnId, order_id: orderId, amount: refundAmount, sent_at: new Date().toISOString() }
    }).catch((err) => {
      console.warn("[REFUND_EMAIL] Failed to record in email_outbox:", err);
    });

    return sent;
  } catch (error) {
    console.error(`[REFUND_EMAIL] Error sending refund email for return ${returnId}:`, error);
    return false;
  }
}

/**
 * Gửi email thông báo đơn hàng thay thế đang được giao đến khách hàng (kèm mã vận đơn và link tra cứu).
 */
export async function sendExchangeShippingEmail(
  returnId: string,
  trackingCode?: string
): Promise<boolean> {
  try {
    const returnRecord = await selectOne("return_exchange", {
      select: "return_id,order_id,user_id,return_type,exchange_order_id,exchange_tracking_code,tracking_return_code,status",
      return_id: `eq.${returnId}`
    });
    if (!returnRecord) return false;

    const returnType = asString(returnRecord.return_type);
    if (returnType !== "exchange") return false;

    const exchangeOrderId = asString(returnRecord.exchange_order_id);
    if (!exchangeOrderId) return false;

    const shipmentCode = trackingCode || asString(returnRecord.exchange_tracking_code) || "";

    // Kiểm tra chống gửi trùng
    const existingOutbox = await selectRows("email_outbox", {
      select: "email_id,status,created_at,metadata",
      template_code: "eq.return_exchange_shipping",
      recipient: `neq.`,
      limit: 20
    }).catch(() => ({ rows: [] as JsonObject[] }));

    const alreadySent = existingOutbox.rows?.some((row: JsonObject) => {
      const meta = row.metadata as JsonObject | undefined;
      return meta && asString(meta.return_id) === returnId && row.status === "sent";
    });
    if (alreadySent) {
      console.log(`[EXCHANGE_EMAIL] Shipping email already sent for return ${returnId}, skipping duplicate.`);
      return true;
    }

    const exchangeOrder = await selectOne("orders", {
      select: "order_id,user_id,order_code,shipping_name,shipping_email,shipping_phone,shipping_address,total_amount",
      order_id: `eq.${exchangeOrderId}`
    });
    if (!exchangeOrder) return false;

    let customerEmail = asString(exchangeOrder.shipping_email).trim();
    let customerName = asString(exchangeOrder.shipping_name).trim();

    const userId = asString(returnRecord.user_id) || asString(exchangeOrder.user_id);
    if ((!customerEmail || !customerName) && userId) {
      const user = await selectOne("users", {
        select: "user_id,email,full_name",
        user_id: `eq.${userId}`
      }).catch(() => null);
      if (user) {
        if (!customerEmail) customerEmail = asString(user.email).trim();
        if (!customerName) customerName = asString(user.full_name).trim();
      }
    }

    const exchangeOrderCode = asString(exchangeOrder.order_code) || exchangeOrderId.slice(0, 8).toUpperCase();
    if (!customerEmail || !customerEmail.includes("@")) {
      console.warn(`[EXCHANGE_EMAIL] No valid customer email found for exchange order #${exchangeOrderCode}.`);
      return false;
    }

    customerName = customerName || "Quý khách";
    const trackingReturnCode = asString(returnRecord.tracking_return_code) || returnId.slice(0, 8).toUpperCase();

    // Lấy danh sách sản phẩm thay thế
    const itemsRes = await selectRows("order_item", {
      select: "item_id,product_name,quantity,unit_price",
      order_id: `eq.${exchangeOrderId}`
    }).catch(() => ({ rows: [] as JsonObject[] }));

    const itemsHtml = (itemsRes.rows || []).map((item: JsonObject) => `
      <tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0e6e0; color: #1c1917;">${asString(item.product_name)}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0e6e0; text-align: center; color: #78716c;">x${asNumber(item.quantity)}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #f0e6e0; text-align: right; color: #059669; font-weight: 600;">Miễn phí (Đổi hàng)</td>
      </tr>
    `).join("");

    const subject = `[Velura] Đơn hàng thay thế #${exchangeOrderCode} đang trên đường giao đến bạn`;
    const text = `Kính chào ${customerName},

Velura xin thông báo yêu cầu đổi hàng cho đơn hàng của bạn (Phiếu #${trackingReturnCode}) đã được kiểm tra chất lượng đạt chuẩn. Đơn hàng thay thế mới mang mã #${exchangeOrderCode} đã được xuất kho và bàn giao cho đơn vị vận chuyển.

THÔNG TIN ĐƠN HÀNG THAY THẾ:
- Mã đơn hàng thay thế: #${exchangeOrderCode}
- Mã phiếu đổi trả: ${trackingReturnCode}
- Mã vận đơn giao hàng: ${shipmentCode || "Đang cập nhật"}
- Người nhận: ${customerName} (${asString(exchangeOrder.shipping_phone)})
- Địa chỉ nhận: ${asString(exchangeOrder.shipping_address)}
- Cần thanh toán: 0 đ (Bù trừ 100% từ hàng đổi trả)

Theo dõi đơn hàng tại: https://velura.royalai.dev/account/track?code=${exchangeOrderCode}

Trân trọng,
Đội ngũ CSKH Velura`;

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #ffffff;">
        <div style="background-color: #222222; padding: 24px; text-align: center;">
          <h1 style="color: #d1b8a8; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background-color: #eff6ff; color: #2563eb; font-size: 26px; font-weight: bold; margin: 0 auto;">🚚</div>
            <h2 style="color: #111827; margin: 16px 0 6px; font-size: 22px; font-weight: 700;">Đơn hàng thay thế đang được giao</h2>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">Sản phẩm đổi mới của bạn đã xuất kho và đang trên đường giao</p>
          </div>

          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Kính chào <strong>${customerName}</strong>,
          </p>
          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Velura xin thông báo sản phẩm gửi trả của bạn thuộc phiếu <strong>#${trackingReturnCode}</strong> đã được kiểm tra đạt chuẩn. Đơn hàng thay thế mới mang mã <strong>#${exchangeOrderCode}</strong> đã được chuẩn bị xong và bàn giao cho đơn vị vận chuyển.
          </p>

          <div style="background-color: #faf7f5; border: 1px solid #f0e6e0; border-left: 4px solid #7C5454; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <h3 style="margin-top: 0; color: #292524; font-size: 16px; margin-bottom: 14px; font-weight: 600;">Thông tin đơn thay thế:</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã đơn mới:</td>
                <td style="padding: 6px 0; color: #7C5454; font-weight: 700; text-align: right;">#${exchangeOrderCode}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã vận đơn giao hàng:</td>
                <td style="padding: 6px 0; color: #1c1917; font-weight: 600; text-align: right;">${shipmentCode || "Đang cập nhật"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Người nhận:</td>
                <td style="padding: 6px 0; color: #1c1917; text-align: right;">${customerName} (${asString(exchangeOrder.shipping_phone)})</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Địa chỉ giao:</td>
                <td style="padding: 6px 0; color: #1c1917; text-align: right;">${asString(exchangeOrder.shipping_address)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Số tiền thanh toán:</td>
                <td style="padding: 6px 0; color: #059669; font-weight: 700; text-align: right;">0 đ (Bù trừ 100%)</td>
              </tr>
            </table>

            ${itemsHtml ? `
              <h4 style="margin: 18px 0 8px 0; color: #292524; font-size: 14px; font-weight: 600;">Sản phẩm thay thế gửi đến bạn:</h4>
              <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                ${itemsHtml}
              </table>
            ` : ""}
          </div>

          <div style="text-align: center; margin: 28px 0 12px;">
            <a href="https://velura.royalai.dev/account/track?code=${exchangeOrderCode}" style="display: inline-block; background-color: #7C5454; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 6px; font-weight: 600; font-size: 14px;">Theo dõi đơn hàng thay thế</a>
          </div>

          <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-top: 24px; text-align: center;">
            Nếu bạn cần thay đổi thời gian hoặc địa điểm nhận hàng, xin vui lòng liên hệ hotline CSKH Velura để được hỗ trợ nhanh nhất.
          </p>
        </div>
        <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
        </div>
      </div>
    `;

    console.log(`[EXCHANGE_EMAIL] Sending replacement shipment email to ${customerEmail} for order #${exchangeOrderCode}...`);
    const sent = await sendDirectEmail(customerEmail, subject, text, html);

    await insertRow("email_outbox", {
      recipient: customerEmail,
      template_code: "return_exchange_shipping",
      subject,
      body: text,
      status: sent ? "sent" : "pending",
      related_user_id: userId || null,
      metadata: { return_id: returnId, exchange_order_id: exchangeOrderId, tracking_code: shipmentCode, sent_at: new Date().toISOString() }
    }).catch((err) => {
      console.warn("[EXCHANGE_EMAIL] Failed to record in email_outbox:", err);
    });

    return sent;
  } catch (error) {
    console.error(`[EXCHANGE_EMAIL] Error sending exchange shipment email for return ${returnId}:`, error);
    return false;
  }
}

/**
 * Gửi email thông báo đơn hàng thay thế đã được giao thành công và quy trình đổi hàng hoàn tất.
 */
export async function sendExchangeCompletedEmail(returnId: string): Promise<boolean> {
  try {
    const returnRecord = await selectOne("return_exchange", {
      select: "return_id,order_id,user_id,return_type,exchange_order_id,tracking_return_code,status",
      return_id: `eq.${returnId}`
    });
    if (!returnRecord) return false;

    const returnType = asString(returnRecord.return_type);
    if (returnType !== "exchange") return false;

    const exchangeOrderId = asString(returnRecord.exchange_order_id);
    if (!exchangeOrderId) return false;

    // Kiểm tra chống gửi trùng
    const existingOutbox = await selectRows("email_outbox", {
      select: "email_id,status,created_at,metadata",
      template_code: "eq.return_exchange_completed",
      recipient: `neq.`,
      limit: 20
    }).catch(() => ({ rows: [] as JsonObject[] }));

    const alreadySent = existingOutbox.rows?.some((row: JsonObject) => {
      const meta = row.metadata as JsonObject | undefined;
      return meta && asString(meta.return_id) === returnId && row.status === "sent";
    });
    if (alreadySent) {
      console.log(`[EXCHANGE_EMAIL] Completion email already sent for return ${returnId}, skipping duplicate.`);
      return true;
    }

    const exchangeOrder = await selectOne("orders", {
      select: "order_id,user_id,order_code,shipping_name,shipping_email,shipping_phone,total_amount",
      order_id: `eq.${exchangeOrderId}`
    });
    if (!exchangeOrder) return false;

    let customerEmail = asString(exchangeOrder.shipping_email).trim();
    let customerName = asString(exchangeOrder.shipping_name).trim();

    const userId = asString(returnRecord.user_id) || asString(exchangeOrder.user_id);
    if ((!customerEmail || !customerName) && userId) {
      const user = await selectOne("users", {
        select: "user_id,email,full_name",
        user_id: `eq.${userId}`
      }).catch(() => null);
      if (user) {
        if (!customerEmail) customerEmail = asString(user.email).trim();
        if (!customerName) customerName = asString(user.full_name).trim();
      }
    }

    const exchangeOrderCode = asString(exchangeOrder.order_code) || exchangeOrderId.slice(0, 8).toUpperCase();
    if (!customerEmail || !customerEmail.includes("@")) {
      console.warn(`[EXCHANGE_EMAIL] No valid customer email found for completed exchange order #${exchangeOrderCode}.`);
      return false;
    }

    customerName = customerName || "Quý khách";
    const trackingReturnCode = asString(returnRecord.tracking_return_code) || returnId.slice(0, 8).toUpperCase();

    const subject = `[Velura] Xác nhận đổi hàng thành công - Đơn hàng #${exchangeOrderCode}`;
    const text = `Kính chào ${customerName},

Velura xin thông báo đơn hàng thay thế #${exchangeOrderCode} (thuộc yêu cầu đổi hàng #${trackingReturnCode}) đã được giao thành công đến bạn.

Yêu cầu đổi hàng của bạn đã được hoàn tất thành công.
Chúng tôi hy vọng bạn hài lòng với sản phẩm mới từ Velura!

Tra cứu chi tiết tại: https://velura.royalai.dev/account/track?code=${exchangeOrderCode}

Trân trọng,
Đội ngũ CSKH Velura`;

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #ffffff;">
        <div style="background-color: #222222; padding: 24px; text-align: center;">
          <h1 style="color: #d1b8a8; margin: 0; font-size: 28px; letter-spacing: 4px; font-weight: 700;">VELURA</h1>
        </div>
        <div style="padding: 32px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background-color: #ecfdf5; color: #059669; font-size: 28px; font-weight: bold; margin: 0 auto;">✓</div>
            <h2 style="color: #111827; margin: 16px 0 6px; font-size: 22px; font-weight: 700;">Đổi hàng thành công</h2>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">Đơn hàng thay thế #${exchangeOrderCode} đã được giao thành công</p>
          </div>

          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Kính chào <strong>${customerName}</strong>,
          </p>
          <p style="color: #374151; line-height: 1.6; font-size: 15px;">
            Velura xin thông báo đơn hàng thay thế mới <strong>#${exchangeOrderCode}</strong> cho phiếu yêu cầu đổi hàng <strong>#${trackingReturnCode}</strong> của bạn đã được giao thành công. Toàn bộ quy trình đổi hàng đã được xử lý hoàn tất trọn vẹn.
          </p>

          <div style="background-color: #faf7f5; border: 1px solid #f0e6e0; border-left: 4px solid #7C5454; padding: 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
            <h3 style="margin-top: 0; color: #292524; font-size: 16px; margin-bottom: 14px; font-weight: 600;">Chi tiết hoàn tất đổi hàng:</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã đơn đổi mới:</td>
                <td style="padding: 6px 0; color: #7C5454; font-weight: 700; text-align: right;">#${exchangeOrderCode}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Mã phiếu đổi hàng:</td>
                <td style="padding: 6px 0; color: #1c1917; font-weight: 600; text-align: right;">${trackingReturnCode}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Trạng thái:</td>
                <td style="padding: 6px 0; color: #059669; font-weight: 700; text-align: right;">Đã giao thành công & Hoàn tất</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #78716c;">Thời gian hoàn tất:</td>
                <td style="padding: 6px 0; color: #1c1917; text-align: right;">${new Date().toLocaleString("vi-VN")}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin: 28px 0 12px;">
            <a href="https://velura.royalai.dev/account/track?code=${exchangeOrderCode}" style="display: inline-block; background-color: #7C5454; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 6px; font-weight: 600; font-size: 14px;">Xem chi tiết đơn hàng</a>
          </div>

          <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-top: 24px; text-align: center;">
            Cảm ơn bạn đã luôn tin tưởng và đồng hành cùng Velura. Hy vọng bạn hài lòng với sản phẩm mới!
          </p>
        </div>
        <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #eaeaea;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Velura. Mọi quyền được bảo lưu.</p>
        </div>
      </div>
    `;

    console.log(`[EXCHANGE_EMAIL] Sending exchange completion email to ${customerEmail} for order #${exchangeOrderCode}...`);
    const sent = await sendDirectEmail(customerEmail, subject, text, html);

    await insertRow("email_outbox", {
      recipient: customerEmail,
      template_code: "return_exchange_completed",
      subject,
      body: text,
      status: sent ? "sent" : "pending",
      related_user_id: userId || null,
      metadata: { return_id: returnId, exchange_order_id: exchangeOrderId, sent_at: new Date().toISOString() }
    }).catch((err) => {
      console.warn("[EXCHANGE_EMAIL] Failed to record in email_outbox:", err);
    });

    return sent;
  } catch (error) {
    console.error(`[EXCHANGE_EMAIL] Error sending exchange completion email for return ${returnId}:`, error);
    return false;
  }
}

