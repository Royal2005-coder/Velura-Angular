import { insertRow } from "./supabase.js";
import { recordAuditWrite } from "./audit-metrics.js";

/**
 * Canonical columns accepted by public.audit_log.
 *
 * The API writes audits with the service role; callers decide whether a failure
 * is best-effort (sign-out) or part of the business operation (admin mutations).
 */
export interface AuditLogRow {
  actor_id?: string | null;
  actor_role?: string | null;
  action: string;
  module: string;
  target_id?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  ip_address?: string | null;
  timestamp?: string;
}

/**
 * Inserts one canonical audit row and records its result in the metrics registry.
 * Throws on failure so each caller can preserve its own transaction semantics.
 */
export async function writeAuditLog(row: AuditLogRow): Promise<void> {
  try {
    await insertRow("audit_log", {
      actor_id: row.actor_id ?? null,
      actor_role: row.actor_role ?? "system",
      action: row.action,
      module: row.module,
      target_id: row.target_id ?? null,
      old_value: row.old_value ?? null,
      new_value: row.new_value ?? null,
      ip_address: row.ip_address ?? null,
      timestamp: row.timestamp ?? new Date().toISOString()
    });
    recordAuditWrite(row.module, "success");
  } catch (error) {
    recordAuditWrite(row.module, "failure");
    throw error;
  }
}
