import { selectRows } from "../supabase.js";
import type { JsonObject } from "../types.js";

/**
 * List filters for the admin audit-log table.
 */
export interface AuditLogListFilters {
  module?: string;
  modules?: string[];
  q?: string;
  targetId?: string;
  limit: number;
  offset: number;
}

/**
 * Persistence surface used by `createAuditLogService`.
 */
export interface AuditLogRepository {
  list(
    filters: AuditLogListFilters,
    accessToken: string
  ): Promise<{ rows: JsonObject[]; count: number | undefined }>;
}

/**
 * PostgREST implementation of audit-log listing.
 */
export function createAuditLogRepository(): AuditLogRepository {
  return {
    list(filters, accessToken) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.module) query.module = `eq.${filters.module}`;
      else if (filters.modules?.length) query.module = `in.(${filters.modules.join(",")})`;
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      if (filters.q) {
        const value = String(filters.q).replace(/[,*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
        if (value) query.or = `(action.ilike.*${value}*,target_id.ilike.*${value}*,actor_id.ilike.*${value}*)`;
      }
      return selectRows("audit_log", query, { useAnonKey: true, accessToken });
    }
  };
}
