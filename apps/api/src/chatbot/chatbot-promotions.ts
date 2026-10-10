import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";
import { asJsonObject, type JsonObject } from "../types.js";

/** Lists only current approved, audience-qualified real recovery programs; codes stay private until staff confirmation. */
export async function listEligibleSupportOffers(sessionId: string): Promise<JsonObject[]> {
  const result = await callRpc("chat_list_eligible_support_offers", { p_session: sessionId });
  if (!Array.isArray(result)) throw new HttpError(503, "SUPPORT_OFFER_SOURCE_UNAVAILABLE", "Không đọc được nguồn ưu đãi CSKH đã phê duyệt.");
  return result.map((value: unknown) => {
    const offer = asJsonObject(value);
    const snapshot = asJsonObject(offer.snapshot);
    const conditions = Array.isArray(snapshot.conditions)
      ? snapshot.conditions.filter((condition: unknown): condition is string => typeof condition === "string").join("; ")
      : "";
    const discount = snapshot.discount_type === "percentage"
      ? `Giảm ${Number(snapshot.discount_value).toLocaleString("vi-VN")}%`
      : snapshot.discount_type === "free_shipping"
        ? "Miễn phí vận chuyển"
        : `Giảm ${Number(snapshot.discount_value).toLocaleString("vi-VN")}₫`;
    const description = [
      discount,
      Number(snapshot.maximum_discount) > 0 ? `giảm tối đa ${Number(snapshot.maximum_discount).toLocaleString("vi-VN")}₫` : "",
      `đơn tối thiểu ${Number(snapshot.min_order_value).toLocaleString("vi-VN")}₫`,
      `tối đa ${Number(snapshot.per_customer_limit).toLocaleString("vi-VN")} lượt/khách`,
      `hạn dùng ${new Date(String(snapshot.expiry)).toLocaleString("vi-VN")}`,
      conditions
    ].filter(Boolean).join(" · ");
    return {
      ...offer,
      title: String(snapshot.name || snapshot.campaign || "Ưu đãi hỗ trợ"),
      description,
      content: JSON.stringify(snapshot)
    };
  });
}

/** Records explicit staff-confirmed conditions on an assigned case; does not mint vouchers or redeem a benefit. */
export async function confirmSupportOffer(sessionId: string, actorId: string, offerId: string): Promise<JsonObject> {
  const result = asJsonObject(await callRpc("chat_confirm_support_offer", {
    p_session: sessionId, p_actor: actorId, p_offer: offerId
  }));
  if (result.confirmed !== true || typeof result.code !== "string" || !result.code) {
    throw new HttpError(503, "SUPPORT_OFFER_CONFIRMATION_UNAVAILABLE", "Không xác nhận được ưu đãi CSKH.");
  }
  return result;
}

/** Resolves confirmed recovery claims for an authenticated member or a phone already verified by checkout OTP. */
export async function listConfirmedSupportVoucherIds(profileId: string | null, verifiedGuestPhone: string | null = null): Promise<string[]> {
  if (!profileId && !verifiedGuestPhone) return [];
  const result = await callRpc("chat_support_wallet_offer_ids", {
    p_profile: profileId, p_guest_phone: verifiedGuestPhone
  });
  if (!Array.isArray(result)) throw new HttpError(503, "SUPPORT_OFFER_CLAIMS_UNAVAILABLE", "Không đọc được ưu đãi CSKH đã xác nhận.");
  return result.filter((value: unknown): value is string => typeof value === "string");
}
