import { signJwt, verifyJwt } from "../auth-helper.js";
import { HttpError } from "../http.js";
import { asString, type AuthContext, type JsonObject } from "../types.js";

/** A guest checkout grants access to one order, never a member account. */
export function issueGuestOrderAccess(orderId: string): string {
  return signJwt({ purpose: "guest_order_access", order_id: orderId }, 15 * 60);
}

/** One successful phone OTP authorizes the customer's orders for 15 minutes. */
export function issueGuestPhoneAccess(phone: string): string {
  return signJwt({ purpose: "guest_order_session", phone }, 15 * 60);
}

/** Resolve a verified phone session without asking for another OTP per action. */
export function guestSessionPhone(token: unknown): string | null {
  const claims = verifyJwt(asString(token));
  return claims?.purpose === "guest_order_session" && typeof claims.phone === "string" ? claims.phone : null;
}

/** Verify a guest's phone session or the capability of a newly placed order. */
export function hasGuestOrderAccess(order: JsonObject, body: JsonObject): boolean {
  const phone = guestSessionPhone(body.guest_access_token || body.order_access_token);
  if (phone && phone === order.shipping_phone) return true;
  const claims = verifyJwt(asString(body.order_access_token || body.guest_access_token));
  return claims?.purpose === "guest_order_access" && claims.order_id === order.order_id;
}

/** Member ownership or a signed capability is required for every customer order mutation. */
export function requireCustomerOrderAccess(order: JsonObject, context: AuthContext, body: JsonObject): void {
  if (context.profile?.user_id) {
    if (order.user_id === context.profile.user_id) return;
  } else {
    if (hasGuestOrderAccess(order, body)) return;
  }
  throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
}
