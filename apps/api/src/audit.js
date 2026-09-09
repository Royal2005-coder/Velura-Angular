import { insertRow } from "./supabase.js";

export async function writeAuditLog(context, entry) {
  const actor = context.profile || {};
  const payload = {
    actor_profile_id: actor.id || null,
    actor_name: actor.full_name || context.authUser?.email || "system",
    actor_role: context.roleCode || "system",
    module: entry.module,
    action: entry.action,
    target_table: entry.targetTable || null,
    target_id: entry.targetId || null,
    target_code: entry.targetCode || null,
    result: entry.result || "success",
    severity: entry.severity || "normal",
    summary: entry.summary || "",
    before_data: entry.beforeData || null,
    after_data: entry.afterData || null,
    metadata: entry.metadata || null,
    ip_address: entry.ipAddress || null
  };

  try {
    await insertRow("audit_logs", payload);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[audit] failed to write audit log", error.message);
    }
  }
}
