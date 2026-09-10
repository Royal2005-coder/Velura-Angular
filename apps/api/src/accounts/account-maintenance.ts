import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";

/**
 * Periodically expire stale admin role-approval requests.
 * Returns the interval handle, or null when maintenance is disabled.
 */
export function startAccountMaintenance(): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey || config.accountMaintenanceIntervalMs <= 0) return null;

  const run = async () => {
    try {
      await callRpc("velura_expire_admin_requests", {});
    } catch (error) {
      const code = error instanceof HttpError ? error.code || "UNKNOWN" : "UNKNOWN";
      const status = error instanceof HttpError ? error.status || 500 : 500;
      console.error("[account-maintenance] approval expiration failed", {
        code,
        status
      });
    }
  };

  void run();
  const timer = setInterval(run, config.accountMaintenanceIntervalMs);
  timer.unref?.();
  return timer;
}
