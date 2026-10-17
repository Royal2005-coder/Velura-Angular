import { HttpError } from "../http.js";
import type { AuthContext, JsonObject } from "../types.js";
import type { LoyaltyRepository } from "./loyalty-repository.js";

/** Quote is advisory; checkout repeats its limits under the same wallet lock as order creation. */
export interface LoyaltyQuote {
  available_points: number;
  max_points: number;
  points_spent: number;
  points_discount_amount: number;
  balance_points?: number;
  policy_approved: boolean;
  spending_enabled: boolean;
}

/** Requires the authenticated member, never a phone-matched guest or a caller-supplied owner. */
export function loyaltyActor(context: AuthContext): string | null {
  const profile = context.profile;
  return context.authUser && !context.isAdmin && context.roleCode === "member" && profile?.is_active === true && profile.role === "member"
    ? profile.user_id : null;
}

/** Points redemption is an integer count; fractional balances remain in the durable ledger. */
export function readPoints(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new HttpError(422, "INVALID_POINTS", "Số điểm sử dụng phải là số nguyên không âm.");
  }
  return value;
}

/** Member-only wallet and referral history backed by actor-bound transactional RPCs. */
export class LoyaltyService {
  constructor(private readonly repository: LoyaltyRepository) {}

  /** Expires due lots before returning this member's balance and append-only history. */
  async snapshot(context: AuthContext, before?: string): Promise<JsonObject> {
    const actor = loyaltyActor(context);
    if (!actor) throw new HttpError(403, "LOYALTY_MEMBER_REQUIRED", "Vui lòng đăng nhập tài khoản thành viên.");
    if (before && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(before)) throw new HttpError(422, "INVALID_HISTORY_CURSOR", "Mốc lịch sử không hợp lệ.");
    return this.repository.snapshot(actor, before || null);
  }

  /** Applies voucher first and caps points to 50% of retained merchandise value, excluding shipping. */
  async quote(context: AuthContext, subtotal: number, shipping: number, voucherDiscount: number, points: unknown): Promise<LoyaltyQuote> {
    const requested = readPoints(points);
    const actor = loyaltyActor(context);
    if (!actor && requested > 0) throw new HttpError(403, "LOYALTY_MEMBER_REQUIRED", "Khách vãng lai không được sử dụng điểm thành viên.");
    if (!actor) return { available_points: 0, max_points: 0, points_spent: 0, points_discount_amount: 0, policy_approved: false, spending_enabled: false };
    try {
      return await this.repository.quote(actor, subtotal, shipping, voucherDiscount, requested);
    } catch (err: unknown) {
      console.warn("[LOYALTY_QUOTE] velura_loyalty_quote unavailable:", err);
      return { available_points: 0, max_points: 0, points_spent: 0, points_discount_amount: 0, policy_approved: false, spending_enabled: false };
    }
  }

  /** Creates the inactive registration and optional immutable referral attribution atomically. */
  register(input: JsonObject, referralCode: unknown): Promise<JsonObject> {
    if (referralCode !== undefined && referralCode !== null && typeof referralCode !== "string") {
      throw new HttpError(422, "INVALID_REFERRAL_CODE", "Mã giới thiệu không hợp lệ.");
    }
    const code = typeof referralCode === "string" ? referralCode.trim().toUpperCase() : "";
    if (code && !/^VLR[A-F0-9]{16}$/.test(code)) throw new HttpError(422, "INVALID_REFERRAL_CODE", "Mã giới thiệu không hợp lệ.");
    return this.repository.register(input, code || null);
  }
}
