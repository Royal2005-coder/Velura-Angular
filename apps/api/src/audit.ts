import { insertRow } from "./supabase.js";
import { errorMessage, type AuthContext, type JsonObject } from "./types.js";

/**
 * Fields written to `audit_logs` by admin actions.
 */
export interface AuditLogWriteEntry {
  module: unknown;
  action: unknown;
  targetTable?: unknown;
  targetId?: unknown;
  targetCode?: unknown;
  result?: unknown;
  severity?: unknown;
  summary?: unknown;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
  ipAddress?: unknown;
}

/**
 * Best-effort insert of one audit row. Failures are swallowed outside production.
 */
export async function writeAuditLog(context: AuthContext, entry: AuditLogWriteEntry): Promise<void> {
  const actor: JsonObject = context.profile || {};
  const payload = {
    actor_profile_id: actor.id ? actor.id : null,
    actor_name: (typeof actor.full_name === "string" && actor.full_name) || context.authUser?.email || "system",
    actor_role: context.roleCode || "system",
    module: entry.module,
    action: entry.action,
    target_table: entry.targetTable ? entry.targetTable : null,
    target_id: entry.targetId ? entry.targetId : null,
    target_code: entry.targetCode ? entry.targetCode : null,
    result: entry.result ? entry.result : "success",
    severity: entry.severity ? entry.severity : "normal",
    summary: entry.summary ? entry.summary : "",
    before_data: entry.beforeData ? entry.beforeData : null,
    after_data: entry.afterData ? entry.afterData : null,
    metadata: entry.metadata ? entry.metadata : null,
    ip_address: entry.ipAddress ? entry.ipAddress : null
  };

  try {
    await insertRow("audit_logs", payload);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[audit] failed to write audit log", errorMessage(error));
    }
  }
}
