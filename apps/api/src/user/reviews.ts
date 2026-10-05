import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, selectRows, insertRow, updateRows, deleteRows } from "../supabase.js";
import { createNotification } from "./notifications.js";
import { guestSessionPhone } from "./order-access.js";
import { sendGuestTrackingOtp, verifyGuestTrackingOtp } from "./guest-order-session.js";
import { checkoutClientIp, normalizeVietnamesePhone } from "./checkout-service.js";
import {
  asJsonObject,
  asString,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse
} from "../types.js";

/**
 * Authenticated member or phone-verified guest review management, create with auto-moderation, and customer reply.
 */
export async function handleReviewsRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  parts: string[],
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  // 1. Phục vụ các endpoint OTP dành cho khách vãng lai
  if (action === "otp-send" && req.method === "POST") {
    const body = await readJson(req);
    const result = await sendGuestTrackingOtp(body, checkoutClientIp(req.headers, req.socket?.remoteAddress));
    return sendJson(res, 200, {
      ...result,
      challenge_id: result.phone || asString(body.phone)
    }, corsHeaders);
  }

  if ((action === "otp-check" || action === "otp-verify") && req.method === "POST") {
    const body = await readJson(req);
    const result = await verifyGuestTrackingOtp(body);
    return sendJson(res, 200, {
      success: true,
      guest_review_token: result.guest_access_token,
      guest_access_token: result.guest_access_token,
      expires_in: 900,
      phone: result.phone
    }, corsHeaders);
  }

  // 2. Xác thực danh tính: Thành viên đăng nhập hoặc Khách vãng lai đã xác thực SĐT qua OTP
  const profile = context.profile;
  const url = new URL(req.url || "/", "http://localhost");
  const guestHeader = asString(req.headers["x-guest-access-token"] || "");
  let guestToken = (url.searchParams.get("guest_access_token") || url.searchParams.get("guest_review_token") || guestHeader).trim();

  // POST /api/user/reviews/:id/reply
  if (action && parts[4] === "reply" && req.method === "POST") {
    const body = await readJson(req);
    const replyText = asString(body.reply_text);
    if (!guestToken) {
      guestToken = asString(body.guest_access_token || body.guest_review_token).trim();
    }
    const guestPhone = !profile && guestToken ? guestSessionPhone(guestToken) : null;

    if (!profile && !guestPhone) {
      throw new HttpError(401, "UNAUTHORIZED", "Vui lòng đăng nhập hoặc xác thực số điện thoại để phản hồi");
    }

    if (!replyText || !replyText.trim()) {
      throw new HttpError(400, "BAD_REQUEST", "Nội dung phản hồi không được để trống");
    }

    const review = await selectOne("review", { review_id: `eq.${action}` });
    if (!review) {
      throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đánh giá");
    }

    let customerName = "Khách hàng";
    if (profile) {
      if (review.user_id !== profile.user_id) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đánh giá");
      }
      customerName = profile.full_name || "Khách hàng";
    } else if (guestPhone) {
      const order = await selectOne("orders", { order_id: `eq.${review.order_id}` });
      if (!order || normalizeVietnamesePhone(order.shipping_phone) !== guestPhone) {
        throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đánh giá");
      }
      customerName = asString(order.shipping_name) || "Khách hàng";
    }

    let replies: unknown[] = [];
    if (review.admin_reply) {
      try {
        const parsed: unknown = JSON.parse(typeof review.admin_reply === "string" ? review.admin_reply : String(review.admin_reply));
        if (!Array.isArray(parsed)) {
          replies = [{
            user_name: "Admin",
            role: "admin",
            reply_text: review.admin_reply,
            created_at: review.moderated_at || review.updated_at || new Date().toISOString()
          }];
        } else {
          replies = parsed;
        }
      } catch {
        replies = [{
          user_name: "Admin",
          role: "admin",
          reply_text: review.admin_reply,
          created_at: review.moderated_at || review.updated_at || new Date().toISOString()
        }];
      }
    }

    replies.push({
      user_name: customerName,
      role: "customer",
      reply_text: replyText.trim(),
      created_at: new Date().toISOString()
    });

    const updated = await updateRows(
      "review",
      { review_id: `eq.${action}` },
      { admin_reply: JSON.stringify(replies) }
    );

    return sendJson(res, 200, { success: true, review: updated[0] }, corsHeaders);
  }

  // GET /api/user/reviews
  if (req.method === "GET") {
    const guestPhone = !profile && guestToken ? guestSessionPhone(guestToken) : null;
    if (profile) {
      const { rows: reviews } = await selectRows("review", { user_id: `eq.${profile.user_id}`, order: "submitted_at.desc" });
      return sendJson(res, 200, { success: true, reviews }, corsHeaders);
    }
    if (guestPhone) {
      const { rows: orders } = await selectRows("orders", { shipping_phone: `eq.${guestPhone}` });
      if (!orders.length) {
        return sendJson(res, 200, { success: true, reviews: [] }, corsHeaders);
      }
      const orderIds = orders.map((o) => asString(o.order_id));
      const { rows: reviews } = await selectRows("review", {
        order_id: `in.(${orderIds.join(",")})`,
        order: "submitted_at.desc"
      });
      return sendJson(res, 200, { success: true, reviews }, corsHeaders);
    }
    throw new HttpError(401, "UNAUTHORIZED", "Vui lòng đăng nhập hoặc xác thực số điện thoại để xem đánh giá.");
  }

  // POST /api/user/reviews
  if (req.method === "POST") {
    const body = await readJson(req);
    const { product_id, order_id, rating, comment, images, review_tags } = body;
    if (!guestToken) {
      guestToken = asString(body.guest_access_token || body.guest_review_token).trim();
    }
    const guestPhone = !profile && guestToken ? guestSessionPhone(guestToken) : null;

    if (!profile && !guestPhone) {
      throw new HttpError(401, "UNAUTHORIZED", "Vui lòng đăng nhập hoặc xác thực số điện thoại trước khi đánh giá.");
    }

    if (!product_id || !order_id || !rating) {
      throw new HttpError(400, "BAD_REQUEST", "Thiếu thông tin product_id, order_id hoặc rating");
    }
    if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) {
      throw new HttpError(422, "INVALID_RATING", "Điểm đánh giá phải là số nguyên từ 1 đến 5.");
    }

    // Check if order belongs to user or guest
    const order = await selectOne("orders", { order_id: `eq.${order_id}` });
    if (!order) {
      throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
    }

    if (profile) {
      if (order.user_id !== profile.user_id) {
        throw new HttpError(403, "FORBIDDEN", "Đơn hàng không thuộc về tài khoản của bạn");
      }
    } else if (guestPhone) {
      if (normalizeVietnamesePhone(order.shipping_phone) !== guestPhone) {
        throw new HttpError(403, "FORBIDDEN", "Đơn hàng không thuộc về số điện thoại đã xác thực");
      }
    }

    if (order.status !== "delivered") {
      throw new HttpError(400, "BAD_REQUEST", "Chỉ có thể đánh giá sản phẩm sau khi đơn hàng đã giao thành công hoặc hoàn thành");
    }
    const { rows: purchasedItems } = await selectRows("order_item", { order_id: `eq.${order_id}`, select: "variant_id" });
    let productPurchased = false;
    for (const item of purchasedItems) {
      const variant = await selectOne("variant", { variant_id: `eq.${item.variant_id}`, select: "product_id" });
      if (variant?.product_id === product_id) { productPurchased = true; break; }
    }
    if (!productPurchased) throw new HttpError(403, "PRODUCT_NOT_PURCHASED", "Sản phẩm không thuộc đơn hàng đã giao.");

    // Check if review already exists for this product in this order
    const existingReview = await selectOne("review", {
      product_id: `eq.${product_id}`,
      order_id: `eq.${order_id}`
    });

    if (existingReview) {
      if (existingReview.status === "rejected") {
        // Delete old rejected review to allow re-review
        await deleteRows("review", { review_id: `eq.${existingReview.review_id}` });
      } else {
        throw new HttpError(400, "BAD_REQUEST", "Sản phẩm này trong đơn hàng đã được đánh giá rồi");
      }
    }

    const reviewerUserId = profile?.user_id || asString(order.user_id);

    // 1. Save initially as 'pending'
    const review = asJsonObject(await insertRow("review", {
      product_id,
      user_id: reviewerUserId,
      order_id,
      rating,
      comment: comment || null,
      images: images || null,
      review_tags: review_tags || null,
      status: "pending",
      submitted_at: new Date().toISOString()
    }));

    console.log(`[AUTO-MODERATION Queue] Đã đưa đánh giá ${review.review_id} vào hàng đợi kiểm duyệt tự động.`);

    // 2. Perform auto-moderation
    const profanities = ["đéo", "chửi", "vãi", "cứt", "mẹ kiếp", "đầu buồi", "dcm", "clm", "địt", "lồn", "buồi", "cặc", "ngu", "chó", "khốn nạn"];
    const adKeywords = ["http://", "https://", "t.me/", "zalo:", "shopee.vn", "lazada.vn", "click vào đây", "nhận quà miễn phí", "quà tặng miễn phí", "mua ngay", "giảm giá sốc"];

    let finalStatus = "approved";
    let rejectionReason: string | null = null;
    const lowerComment = String(comment || "").toLowerCase();

    // Check profanities
    for (const word of profanities) {
      if (lowerComment.includes(word)) {
        finalStatus = "rejected";
        rejectionReason = "Nội dung chứa từ ngữ không phù hợp hoặc thô tục";
        break;
      }
    }

    // Check ads/spam
    if (finalStatus === "approved") {
      for (const ad of adKeywords) {
        if (lowerComment.includes(ad)) {
          finalStatus = "rejected";
          rejectionReason = "Nội dung chứa quảng cáo, spam hoặc liên kết ngoài";
          break;
        }
      }
    }

    // Check image validity
    if (finalStatus === "approved" && Array.isArray(images)) {
      for (const img of images) {
        const lowerImg = String(img).toLowerCase();
        if (lowerImg.includes("fake") || lowerImg.includes("spam") || lowerImg.includes("cheat") || lowerImg.includes("error")) {
          finalStatus = "rejected";
          rejectionReason = "Hình ảnh tải lên không hợp lệ hoặc chứa nội dung vi phạm";
          break;
        }
      }
    }

    // 3. Update database row with auto-moderation result
    const updatedRows = await updateRows(
      "review",
      { review_id: `eq.${review.review_id}` },
      {
        status: finalStatus,
        rejection_reason: rejectionReason,
        moderated_at: new Date().toISOString()
      }
    );

    const finalReview = updatedRows[0] || review;

    // Send moderation notification
    if (profile) {
      if (finalStatus === "approved") {
        await createNotification(
          profile.user_id,
          "review_moderation",
          "Đánh giá của bạn đã được duyệt ✅",
          "Cảm ơn bạn! Đánh giá sản phẩm trong đơn hàng của bạn đã được duyệt thành công.",
          "/account/reviews"
        );
      } else if (finalStatus === "rejected") {
        await createNotification(
          profile.user_id,
          "review_moderation",
          "Đánh giá không đạt kiểm duyệt ❌",
          `Đánh giá sản phẩm của bạn bị từ chối. Lý do: ${rejectionReason || "Không xác định"}`,
          "/account/reviews"
        );
      }
    }

    console.log(`[AUTO-MODERATION Result] Đánh giá ${review.review_id} -> Kết quả: ${finalStatus.toUpperCase()}${rejectionReason ? ` (Lý do: ${rejectionReason})` : ""}`);

    return sendJson(res, 200, { success: true, review: finalReview }, corsHeaders);
  }

  throw new HttpError(404, "NOT_FOUND", "Route reviews not found");
}
