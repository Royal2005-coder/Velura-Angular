import { selectRows } from "../supabase.js";

export function createAuditLogRepository() {
  return {
    list(filters, accessToken) {
      const query = {
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
