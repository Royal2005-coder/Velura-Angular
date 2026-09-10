import { selectRows } from "../supabase.js";
import type { JsonObject } from "../types.js";

/**
 * List filters for the admin audit-log table.
 */
export interface AuditLogListFilters {
  module?: string;
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
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return selectRows("audit_log", query, { useAnonKey: true, accessToken });
    }
  };
}
