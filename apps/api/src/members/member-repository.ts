import { callRpc } from "../supabase.js";
import type { JsonObject } from "../types.js";

/**
 * Truy cập bốn RPC thành viên (migration 079).
 *
 * RPC chạy bằng token của người gọi (`useAnonKey` + Authorization) và tự kiểm tra quyền admin,
 * nên tầng API không ghi audit lần thứ hai. Ví điểm chỉ đọc từ `loyalty_account`/`loyalty_ledger`;
 * `users.loyalty_points` là cột cũ, production để 0 cho mọi người nên không dùng làm nguồn sự thật.
 */
export interface MemberRepository {
  overview(accessToken: string | null): Promise<JsonObject>;
  list(
    input: { q: string; wallet: string; sort: string; limit: number; offset: number },
    accessToken: string | null,
  ): Promise<JsonObject>;
  detail(userId: string, accessToken: string | null): Promise<JsonObject>;
  setAccrualLock(
    input: { userId: string; locked: boolean; reason: string; ipAddress: string },
    accessToken: string | null,
  ): Promise<JsonObject>;
}

function authOptions(accessToken: string | null | undefined): { useAnonKey?: boolean; accessToken?: string } {
  if (!accessToken) return {};
  return { useAnonKey: true, accessToken };
}

export function createMemberRepository(): MemberRepository {
  return {
    async overview(accessToken) {
      return (await callRpc("admin_member_overview", {}, authOptions(accessToken))) as JsonObject;
    },

    async list(input, accessToken) {
      const result = await callRpc(
        "admin_list_members",
        {
          p_q: input.q || null,
          p_wallet: input.wallet,
          p_sort: input.sort,
          p_limit: input.limit,
          p_offset: input.offset,
        },
        authOptions(accessToken),
      );
      return (result || { rows: [], count: 0 }) as JsonObject;
    },

    async detail(userId, accessToken) {
      return (await callRpc("admin_member_detail", { p_user_id: userId }, authOptions(accessToken))) as JsonObject;
    },

    async setAccrualLock(input, accessToken) {
      return (await callRpc(
        "admin_set_member_accrual_lock",
        {
          p_user_id: input.userId,
          p_locked: input.locked,
          p_reason: input.reason,
          p_ip_address: input.ipAddress,
        },
        authOptions(accessToken),
      )) as JsonObject;
    },
  };
}
