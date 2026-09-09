import { HttpError, sendJson } from "../http.js";
import { selectRows, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";

// Helper to create notifications with grace (no crash if table missing)
export async function createNotification(userId, type, title, content, link = null) {
  try {
    const newNotif = await insertRow("notifications", {
      user_id: userId,
      type,
      title,
      content,
      link,
      is_read: false,
      created_at: new Date().toISOString()
    });
    console.log(`[Notification Created] user_id: ${userId}, title: ${title}`);
    return newNotif;
  } catch (err) {
    console.warn(`[Notification Failed] Could not create notification: ${err.message}. Table 'notifications' might not exist yet.`);
    return null;
  }
}

export async function handleNotificationsRoute(req, res, action, parts, corsHeaders, context) {
  const profile = requireUserAuth(context);

  // GET /api/user/notifications
  if (req.method === "GET" && !action) {
    try {
      const { rows } = await selectRows("notifications", {
        user_id: `eq.${profile.user_id}`,
        order: "created_at.desc"
      });
      // Fallback: if user has no notifications, return a welcome notification and an active promotion notification.
      if (rows.length === 0) {
        const welcomeNotif = {
          id: "welcome-default",
          user_id: profile.user_id,
          type: "system",
          title: "Chào mừng thành viên mới! 🎉",
          content: "Chào mừng bạn đến với Velura. Hãy khám phá những bộ sưu tập mới nhất của chúng tôi và làm trắc nghiệm Style Quiz để nhận gợi ý phối đồ AI nhé!",
          link: "/src/pages/ai/suggestions.html",
          is_read: false,
          created_at: new Date(Date.now() - 3600000).toISOString()
        };
        const promoNotif = {
          id: "promo-default",
          user_id: profile.user_id,
          type: "promotion",
          title: "Ưu đãi thành viên mới: Giảm 10% 🏷️",
          content: "Mã giảm giá VELURANEW giảm ngay 10% cho đơn hàng đầu tiên của bạn. Áp dụng ngay khi thanh toán!",
          link: "/src/pages/products/list.html",
          is_read: false,
          created_at: new Date().toISOString()
        };
        return sendJson(res, 200, { success: true, notifications: [promoNotif, welcomeNotif] }, corsHeaders);
      }
      return sendJson(res, 200, { success: true, notifications: rows }, corsHeaders);
    } catch (err) {
      console.warn(`[Notification API] Failed to select notifications: ${err.message}. Returning fallback static notifications.`);
      const welcomeNotif = {
        id: "welcome-default",
        user_id: profile.user_id,
        type: "system",
        title: "Chào mừng thành viên mới! 🎉",
        content: "Chào mừng bạn đến với Velura. Hãy khám phá những bộ sưu tập mới nhất của chúng tôi và làm trắc nghiệm Style Quiz để nhận gợi ý phối đồ AI nhé!",
        link: "/src/pages/ai/suggestions.html",
        is_read: false,
        created_at: new Date(Date.now() - 3600000).toISOString()
      };
      const promoNotif = {
        id: "promo-default",
        user_id: profile.user_id,
        type: "promotion",
        title: "Ưu đãi thành viên mới: Giảm 10% 🏷️",
        content: "Mã giảm giá VELURANEW giảm ngay 10% cho đơn hàng đầu tiên của bạn. Áp dụng ngay khi thanh toán!",
        link: "/src/pages/products/list.html",
        is_read: false,
        created_at: new Date().toISOString()
      };
      return sendJson(res, 200, { success: true, notifications: [promoNotif, welcomeNotif] }, corsHeaders);
    }
  }

  // POST /api/user/notifications/read-all
  if (req.method === "POST" && action === "read-all") {
    try {
      await updateRows(
        "notifications",
        { user_id: `eq.${profile.user_id}` },
        { is_read: true }
      );
      return sendJson(res, 200, { success: true }, corsHeaders);
    } catch (err) {
      console.warn(`[Notification API] Failed to update read-all: ${err.message}`);
      return sendJson(res, 200, { success: true, fallback: true }, corsHeaders);
    }
  }

  // POST /api/user/notifications/:id/read
  if (req.method === "POST" && action) {
    try {
      await updateRows(
        "notifications",
        { id: `eq.${action}`, user_id: `eq.${profile.user_id}` },
        { is_read: true }
      );
      return sendJson(res, 200, { success: true }, corsHeaders);
    } catch (err) {
      console.warn(`[Notification API] Failed to update notification read status: ${err.message}`);
      return sendJson(res, 200, { success: true, fallback: true }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "API endpoint not found");
}
