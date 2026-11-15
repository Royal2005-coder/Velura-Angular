import { sendDirectEmail } from "../email/mailer.js";
import { insertRow, selectOne, selectRows } from "../supabase.js";
import { asString } from "../types.js";
import { createNotification } from "../user/notifications.js";

/**
 * Gửi email thông báo đơn hàng đã giao thành công và tạo thông báo chuông cho khách hàng.
 * Đảm bảo non-blocking và an toàn cho khách vãng lai (không tạo notification DB nếu user_id null).
 */
export async function notifyOrderDelivered(orderId: string): Promise<boolean> {
  try {
    const order = await selectOne("orders", {
      select: "order_id,user_id,order_code,shipping_name,shipping_email,shipping_phone,total_amount",
      order_id: `eq.${orderId}`
    });
    if (!order) return false;

    const orderCode = asString(order.order_code) || orderId.slice(0, 8).toUpperCase();
    const userId = asString(order.user_id);

    // Chặn gửi trùng lặp nếu đơn hàng đã được gửi thông báo giao hàng thành công trước đó
    const existing = await selectRows("email_outbox", {
      select: "email_id,status",
      template_code: "eq.order_delivered",
      "metadata->>order_id": `eq.${orderId}`,
      status: "eq.sent",
      limit: 1
    }).catch(() => ({ rows: [] }));
    if (existing.rows && existing.rows.length > 0) {
      return true;
    }

    let email = asString(order.shipping_email).trim();
    let name = asString(order.shipping_name).trim();

    if ((!email || !name) && userId) {
      const user = await selectOne("users", { select: "email,full_name", user_id: `eq.${userId}` }).catch(() => null);
      if (user) {
        email = email || asString(user.email).trim();
        name = name || asString(user.full_name).trim();
      }
    }
    name = name || "Quý khách";

    // 1. Tạo notification lên chuông cho Member (user_id hợp lệ)
    if (userId) {
      void createNotification(
        userId,
        "order_completed",
        `Đơn hàng #${orderCode} đã giao thành công`,
        `Đơn hàng #${orderCode} đã được giao thành công. Cảm ơn bạn đã lựa chọn Velura! Hãy đánh giá sản phẩm để tích lũy điểm thưởng.`,
        `/account/orders/${orderId}`
      ).catch((err) => console.warn(`[ORDER_DELIVERED_NOTIF] Failed to create notification: ${err}`));
    }

    // 2. Gửi email nếu có email
    if (!email || !email.includes("@")) return false;

    const trackingLink = `https://velura.royalai.dev/account/orders/${orderId}`;
    const subject = `[Velura] Đơn hàng #${orderCode} đã được giao thành công`;
    const text = `Kính chào ${name},

Đơn hàng #${orderCode} của bạn đã được giao thành công!

Velura xin chân thành cảm ơn sự tin tưởng và đồng hành của bạn. Chúng tôi hy vọng bạn hài lòng với những thiết kế tinh tế từ bộ sưu tập.

Đừng quên đánh giá sản phẩm để chia sẻ trải nghiệm và tích lũy thêm điểm thưởng thành viên:
${trackingLink}

Trân trọng,
Đội ngũ Velura`;

    const html = `
      <div style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;border:1px solid #eaeaea;border-radius:8px;overflow:hidden;background:#fff;">
        <div style="background:#222;padding:24px;text-align:center;"><h1 style="color:#d1b8a8;margin:0;font-size:28px;letter-spacing:4px;">VELURA</h1></div>
        <div style="padding:32px;">
          <h2 style="color:#111827;margin:0 0 8px;">Giao hàng thành công!</h2>
          <p style="color:#374151;line-height:1.6;">Kính chào <strong>${name}</strong>, đơn hàng <strong>#${orderCode}</strong> của bạn đã được giao thành công.</p>
          <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:4px 0;color:#4B5563;"><strong>Mã đơn hàng:</strong> <span style="font-family:monospace;color:#111827;font-weight:700;">#${orderCode}</span></p>
            <p style="margin:4px 0;color:#4B5563;"><strong>Trạng thái:</strong> Đã giao hàng thành công</p>
          </div>
          <p style="color:#374151;line-height:1.6;">Velura hy vọng bạn sẽ yêu thích sản phẩm đã chọn. Hãy dành ít phút đánh giá sản phẩm để nhận điểm thưởng thành viên nhé!</p>
          <div style="text-align:center;margin:28px 0 12px;">
            <a href="${trackingLink}" style="display:inline-block;background:#7C5454;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">Xem chi tiết & Đánh giá</a>
          </div>
          <p style="color:#9CA3AF;font-size:13px;line-height:1.5;margin-top:24px;border-top:1px solid #F3F4F6;padding-top:16px;">Cần hỗ trợ? Đội ngũ CSKH Velura luôn sẵn sàng tại cskh@velura.com.</p>
        </div>
      </div>`;

    const sent = await sendDirectEmail(email, subject, text, html);
    await insertRow("email_outbox", {
      recipient: email,
      template_code: "order_delivered",
      subject,
      body: text,
      status: sent ? "sent" : "pending",
      related_user_id: userId || null,
      metadata: { order_id: orderId, sent_at: new Date().toISOString() }
    }).catch((err) => {
      console.warn("[ORDER_DELIVERED_EMAIL] Failed to record in email_outbox:", err);
    });

    return sent;
  } catch (err) {
    console.warn(`[ORDER_DELIVERED_NOTIF] Error notifying order delivered for order ${orderId}:`, err);
    return false;
  }
}
