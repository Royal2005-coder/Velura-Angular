import { HttpError, sendJson } from "../http.js";
import { selectRows, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import { errorMessage, type AuthContext, type HeaderMap, type HttpRequest, type HttpResponse } from "../types.js";

/**
 * Persist a user notification, or return null when the table is unavailable.
 */
export async function createNotification(
  userId: string,
  type: string,
  title: string,
  content: string,
  link: string | null = null
): Promise<unknown> {
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
    console.warn(`[Notification Failed] Could not create notification: ${errorMessage(err)}. Table 'notifications' might not exist yet.`);
    return null;
  }
}

/**
 * Storefront notification list and read-state mutations.
 */
export async function handleNotificationsRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  void parts;
  const profile = requireUserAuth(context);

  // GET /api/user/notifications
  if (req.method === "GET" && !action) {
    try {
      const { rows } = await selectRows("notifications", {
        user_id: `eq.${profile.user_id}`,
        order: "created_at.desc"
      });
      return sendJson(res, 200, { success: true, notifications: rows }, corsHeaders);
    } catch (err) {
      console.warn(`[Notification API] Failed to select notifications: ${errorMessage(err)}`);
      return sendJson(res, 200, { success: true, notifications: [] }, corsHeaders);
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
      console.warn(`[Notification API] Failed to update read-all: ${errorMessage(err)}`);
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
      console.warn(`[Notification API] Failed to update notification read status: ${errorMessage(err)}`);
      return sendJson(res, 200, { success: true, fallback: true }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "API endpoint not found");
}
