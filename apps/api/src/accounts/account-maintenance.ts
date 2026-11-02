import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";

type RpcCaller = (name: string, payload: unknown) => Promise<unknown>;

/**
 * Maintenance RPCs run on every tick. Each one is isolated so a failing job never blocks the others:
 *  - expire stale admin role-approval requests;
 *  - auto-unlock expired temporary locks (system audit `AUTO_UNLOCK` + email via the outbox);
 *  - grant referral rewards that were parked as pending (loyalty reconcile).
 */
export const ACCOUNT_MAINTENANCE_JOBS = [
  "velura_expire_admin_requests",
  "velura_auto_unlock_expired_locks",
  "velura_reconcile_referral_rewards"
] as const;

/**
 * Runs every maintenance job once and returns the names of the jobs that failed.
 */
export async function runAccountMaintenanceOnce(
  call: RpcCaller = (name, payload) => callRpc(name, payload)
): Promise<string[]> {
  const failed: string[] = [];
  for (const job of ACCOUNT_MAINTENANCE_JOBS) {
    try {
      await call(job, {});
    } catch (error) {
      failed.push(job);
      const code = error instanceof HttpError ? error.code || "UNKNOWN" : "UNKNOWN";
      const status = error instanceof HttpError ? error.status || 500 : 500;
      console.error("[account-maintenance] job failed", { job, code, status });
    }
  }
  return failed;
}

/**
 * Periodically run account maintenance.
 * Returns the interval handle, or null when maintenance is disabled.
 */
export function startAccountMaintenance(): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey || config.accountMaintenanceIntervalMs <= 0) return null;

  const run = () => void runAccountMaintenanceOnce();
  run();
  const timer = setInterval(run, config.accountMaintenanceIntervalMs);
  timer.unref?.();
  return timer;
}
