import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import type { LoyaltyQuote } from "./loyalty-service.js";

/** Database owns wallet serialization, event idempotency, expiry and referral attribution. */
export interface LoyaltyRepository {
  snapshot(actorId: string, before: string | null): Promise<JsonObject>;
  quote(actorId: string, subtotal: number, shipping: number, discount: number, points: number): Promise<LoyaltyQuote>;
  register(input: JsonObject, referralCode: string | null): Promise<JsonObject>;
}

/** Maps SQL policy/ownership conflicts without hiding database failures. */
export function loyaltyDatabaseError(error: unknown): never {
  if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
    const details = asJsonObject(error.details);
    const code = asString(details.message);
    const messages: Record<string, string> = {
      LOYALTY_MEMBER_REQUIRED: "Vui lòng đăng nhập tài khoản thành viên.",
      LOYALTY_ACTOR_MISMATCH: "Không được sử dụng ví điểm của tài khoản khác.",
      LOYALTY_POLICY_APPROVAL_REQUIRED: "Chính sách làm tròn và sử dụng điểm hết hạn đang chờ phê duyệt.",
      POINTS_CHANGED: "Số điểm khả dụng hoặc giới hạn đơn hàng đã thay đổi. Vui lòng báo giá lại.",
      REWARD_VOUCHER_CHANGED: "Voucher giới thiệu không còn hợp lệ cho tài khoản hoặc đơn hàng này.",
      INVALID_REFERRAL_CODE: "Mã giới thiệu không tồn tại hoặc không còn hợp lệ.",
      SELF_REFERRAL_FORBIDDEN: "Không được tự giới thiệu chính mình.",
      INVALID_POINTS: "Số điểm sử dụng không hợp lệ."
    };
    if (messages[code]) throw new HttpError(code.includes("MEMBER") || code.includes("ACTOR") ? 403 : code.includes("REFERRAL") || code === "INVALID_POINTS" ? 422 : 409, code, messages[code]);
  }
  throw error;
}

/** Service-role calls still pass an actor derived by the server, not the request body. */
export function createLoyaltyRepository(): LoyaltyRepository {
  const rpc = async (name: string, input: JsonObject): Promise<JsonObject> => {
    try { return asJsonObject(await callRpc(name, input)); } catch (error: unknown) { return loyaltyDatabaseError(error); }
  };
  return {
    snapshot: (actorId, before) => rpc("velura_loyalty_snapshot", { p_actor_id: actorId, p_before: before }),
    quote: async (actorId, subtotal, shipping, discount, points) => {
      const value = await rpc("velura_loyalty_quote", { p_actor_id: actorId, p_subtotal: subtotal, p_shipping: shipping, p_discount: discount, p_points: points });
      return { available_points: Number(value.available_points), max_points: Number(value.max_points), points_spent: Number(value.points_spent),
        points_discount_amount: Number(value.points_discount_amount), balance_points: Number(value.balance_points),
        policy_approved: value.policy_approved === true, spending_enabled: value.spending_enabled === true };
    },
    register: (input, referralCode) => rpc("velura_register_member", { p_input: input, p_referral_code: referralCode })
  };
}
