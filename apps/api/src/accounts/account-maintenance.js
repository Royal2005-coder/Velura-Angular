import { config } from "../config.js";
import { callRpc } from "../supabase.js";

export function startAccountMaintenance() {
  if (!config.supabaseServiceRoleKey || config.accountMaintenanceIntervalMs <= 0) return null;

  const run = async () => {
    try {
      await callRpc("velura_expire_admin_requests", {});
    } catch (error) {
      console.error("[account-maintenance] approval expiration failed", {
        code: error.code || "UNKNOWN",
        status: error.status || 500
      });
    }
  };

  void run();
  const timer = setInterval(run, config.accountMaintenanceIntervalMs);
  timer.unref?.();
  return timer;
}
