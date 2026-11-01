import { HttpError } from "../http.js";
import { requirePermission } from "../rbac.js";
import { asJsonObject, asString, type AuthContext, type JsonObject, type RequestMeta } from "../types.js";
import type { MemberRepository } from "./member-repository.js";

/** Bộ lọc ví mà `admin_list_members` chấp nhận (migration 079). */
export const MEMBER_WALLET_FILTERS = ["all", "has", "none", "negative", "locked"] as const;
export type MemberWalletFilter = (typeof MEMBER_WALLET_FILTERS)[number];

/** Thứ tự sắp xếp danh sách thành viên. */
export const MEMBER_SORTS = ["balance", "name", "recent"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

/** Lý do khoá/mở tích luỹ tối thiểu, khớp ràng buộc trong RPC. */
export const MEMBER_LOCK_REASON_MIN = 8;
/** Floor enforced by admin_set_loyalty_spending; validating it here keeps the RPC from failing with a masked code. */
export const LOYALTY_SPENDING_REASON_MIN = 10;
/** Same ceiling the RPC applies to a single manual wallet correction. */
export const POINTS_ADJUST_MAX = 1_000_000;
export const POINTS_ADJUST_KEY_MIN = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mã lỗi do migration 079 `raise sqlstate ... using message`, kèm câu tiếng Việt để màn hình
 * hiện đúng việc cần làm thay vì báo lỗi chung.
 */
const MEMBER_DATABASE_ERRORS: Readonly<Record<string, { status: number; message: string }>> = {
  RBAC_DENIED: { status: 403, message: "Vai trò hiện tại không được thao tác trên điểm thành viên." },
  MEMBER_NOT_FOUND: { status: 404, message: "Không tìm thấy thành viên này." },
  MEMBER_FILTER_INVALID: { status: 422, message: "Bộ lọc ví không hợp lệ." },
  MEMBER_SORT_INVALID: { status: 422, message: "Cách sắp xếp không hợp lệ." },
  MEMBER_LOCK_STATE_REQUIRED: { status: 422, message: "Thiếu trạng thái khoá tích luỹ." },
  MEMBER_LOCK_REASON_REQUIRED: {
    status: 422,
    message: `Cần lý do tối thiểu ${MEMBER_LOCK_REASON_MIN} ký tự để khoá hoặc mở khoá tích luỹ.`,
  },
};

/**
 * Chuyển lỗi PostgREST của RPC thành viên thành HttpError có mã ổn định và thông điệp tiếng Việt.
 */
export function mapMemberDatabaseError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const details = asJsonObject(error.details);
  const code = asString(details.message).trim() || error.message.replace(/\s*\[status:\d+\]$/, "").trim();
  const known = MEMBER_DATABASE_ERRORS[code];
  return known ? new HttpError(known.status, code, known.message, error.details) : error;
}

export interface MemberService {
  overview(context: AuthContext | undefined): Promise<JsonObject>;
  listMembers(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<JsonObject>;
  memberDetail(context: AuthContext | undefined, userId: string): Promise<JsonObject>;
  setAccrualLock(context: AuthContext | undefined, userId: string, body: JsonObject, requestMeta: RequestMeta): Promise<JsonObject>;
  /** Enables or disables point spending platform-wide. */
  setLoyaltySpending(context: AuthContext | undefined, body: JsonObject, requestMeta: RequestMeta): Promise<JsonObject>;
  /** Books one signed manual correction to a member wallet. */
  adjustMemberPoints(context: AuthContext | undefined, userId: string, body: JsonObject, requestMeta: RequestMeta): Promise<JsonObject>;
}

export function createMemberService({ repository }: { repository: MemberRepository }): MemberService {
  function integer(value: string | null, fallback: number, max: number): number {
    const parsed = Number.parseInt(value || "", 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 0), max);
  }

  function requireUuid(value: string, field: string): string {
    if (!UUID_PATTERN.test(value)) {
      throw new HttpError(422, "VALIDATION_ERROR", `${field} phải là uuid`, { [field]: ["invalid uuid"] });
    }
    return value;
  }

  return {
    async overview(context) {
      requirePermission(context as AuthContext, "members", "read");
      try {
        return await repository.overview(context?.accessToken ?? null);
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },

    async listMembers(context, searchParams) {
      requirePermission(context as AuthContext, "members", "read");
      const wallet = (searchParams.get("wallet") || "all").trim();
      const sort = (searchParams.get("sort") || "balance").trim();
      if (!MEMBER_WALLET_FILTERS.includes(wallet as MemberWalletFilter)) {
        throw new HttpError(422, "MEMBER_FILTER_INVALID", MEMBER_DATABASE_ERRORS.MEMBER_FILTER_INVALID.message, {
          wallet: [MEMBER_WALLET_FILTERS.join(", ")],
        });
      }
      if (!MEMBER_SORTS.includes(sort as MemberSort)) {
        throw new HttpError(422, "MEMBER_SORT_INVALID", MEMBER_DATABASE_ERRORS.MEMBER_SORT_INVALID.message, {
          sort: [MEMBER_SORTS.join(", ")],
        });
      }
      try {
        return await repository.list(
          {
            q: (searchParams.get("q") || "").trim(),
            wallet,
            sort,
            limit: integer(searchParams.get("limit"), 50, 200),
            offset: integer(searchParams.get("offset"), 0, 100000),
          },
          context?.accessToken ?? null,
        );
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },

    async memberDetail(context, userId) {
      requirePermission(context as AuthContext, "members", "read");
      try {
        return await repository.detail(requireUuid(userId, "userId"), context?.accessToken ?? null);
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },

    async setAccrualLock(context, userId, body, requestMeta) {
      requirePermission(context as AuthContext, "members", "update");
      const target = requireUuid(userId, "userId");
      const locked = body.locked;
      const reason = asString(body.reason).trim();
      if (typeof locked !== "boolean") {
        throw new HttpError(422, "VALIDATION_ERROR", "Thiếu trạng thái khoá tích luỹ.", {
          locked: [MEMBER_DATABASE_ERRORS.MEMBER_LOCK_STATE_REQUIRED.message],
        });
      }
      if (reason.length < MEMBER_LOCK_REASON_MIN) {
        throw new HttpError(422, "VALIDATION_ERROR", MEMBER_DATABASE_ERRORS.MEMBER_LOCK_REASON_REQUIRED.message, {
          reason: [MEMBER_DATABASE_ERRORS.MEMBER_LOCK_REASON_REQUIRED.message],
        });
      }
      try {
        return await repository.setAccrualLock(
          { userId: target, locked, reason, ipAddress: requestMeta.ipAddress },
          context?.accessToken ?? null,
        );
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },
    async setLoyaltySpending(context, body, requestMeta) {
      requirePermission(context as AuthContext, "members", "update");
      const enabled = body.enabled;
      const reason = asString(body.reason).trim();
      const maxPercent = Number(body.maxPercent);
      if (typeof enabled !== "boolean") {
        throw new HttpError(422, "VALIDATION_ERROR", "Thiếu trạng thái bật/tắt dùng điểm.", {
          enabled: ["INVALID_RISK"],
        });
      }
      if (!Number.isFinite(maxPercent) || maxPercent < 1 || maxPercent > 100) {
        throw new HttpError(422, "INVALID_PERCENT", "Tỉ lệ tối đa phải từ 1 đến 100.");
      }
      if (reason.length < LOYALTY_SPENDING_REASON_MIN) {
        throw new HttpError(422, "REASON_REQUIRED", `Cần lý do tối thiểu ${LOYALTY_SPENDING_REASON_MIN} ký tự để lưu dấu vết vận hành.`, {
          reason: [MEMBER_DATABASE_ERRORS.MEMBER_LOCK_REASON_REQUIRED.message],
        });
      }
      try {
        return await repository.setLoyaltySpending(
          { enabled, maxPercent, reason, ipAddress: requestMeta.ipAddress },
          context?.accessToken ?? null,
        );
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },
    async adjustMemberPoints(context, userId, body, requestMeta) {
      requirePermission(context as AuthContext, "members", "update");
      const target = requireUuid(userId, "userId");
      const points = Number(body.points);
      const reason = asString(body.reason).trim();
      const idempotencyKey = asString(body.idempotencyKey).trim();
      const returnId = asString(body.returnId).trim();
      if (!Number.isInteger(points) || points === 0 || Math.abs(points) > POINTS_ADJUST_MAX) {
        throw new HttpError(422, "INVALID_POINTS", `Số điểm điều chỉnh phải là số nguyên khác 0 và không quá ±${POINTS_ADJUST_MAX}.`, {
          points: ["INVALID_POINTS"],
        });
      }
      if (reason.length < LOYALTY_SPENDING_REASON_MIN) {
        throw new HttpError(422, "REASON_REQUIRED", `Cần lý do tối thiểu ${LOYALTY_SPENDING_REASON_MIN} ký tự để lưu dấu vết vận hành.`, {
          reason: [MEMBER_DATABASE_ERRORS.MEMBER_LOCK_REASON_REQUIRED.message],
        });
      }
      if (idempotencyKey.length < POINTS_ADJUST_KEY_MIN) {
        throw new HttpError(422, "TRANSFER_REFERENCE_REQUIRED", `Mã chống trùng phải có ít nhất ${POINTS_ADJUST_KEY_MIN} ký tự.`, {
          idempotencyKey: ["TRANSFER_REFERENCE_REQUIRED"],
        });
      }
      if (returnId && !UUID_PATTERN.test(returnId)) {
        throw new HttpError(422, "VALIDATION_ERROR", "returnId phải là uuid.", { returnId: ["invalid uuid"] });
      }
      try {
        return await repository.adjustMemberPoints(
          {
            userId: target, points, reason, idempotencyKey,
            returnId: returnId || null, ipAddress: requestMeta.ipAddress,
          },
          context?.accessToken ?? null,
        );
      } catch (error: unknown) {
        throw mapMemberDatabaseError(error);
      }
    },
  };
}
