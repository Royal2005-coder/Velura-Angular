import { selectRows } from "../supabase.js";
import type { JsonObject } from "../types.js";

/**
 * List filters for the admin audit-log table.
 */
export interface AuditLogListFilters {
  module?: string;
  modules?: string[];
  q?: string;
  /** Folded match over the actor id/label only (UAT TC_ACC_16 "lọc theo người thực hiện"). */
  actor?: string;
  /** Inclusive ISO bounds on `timestamp`. */
  from?: string;
  to?: string;
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
      const range: string[] = [];
      if (filters.from) range.push(`timestamp.gte.${filters.from}`);
      if (filters.to) range.push(`timestamp.lte.${filters.to}`);
      if (range.length) query.and = `(${range.join(",")})`;
      // Free-text search is folded in the service over enriched rows; `ilike` on the enum
      // `action` or the uuid id columns fails in PostgREST (UAT TC_ACC_16).
      return selectRows("audit_log", query, { useAnonKey: true, accessToken });
    }
  };
}
