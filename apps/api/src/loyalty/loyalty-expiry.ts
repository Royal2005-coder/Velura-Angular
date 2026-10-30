import { config } from "../config.js";
import { callRpc } from "../supabase.js";

/**
 * Expires every due loyalty lot through the database RPC. The RPC is idempotent:
 * lots are retired and an `expired` ledger row is written once.
 */
export async function expireLoyaltyPoints(): Promise<{ users: number; expired_milli: number }> {
  const value = await callRpc("velura_expire_all_loyalty_lots", {});
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    users: Number(result.users) || 0,
    expired_milli: Number(result.expired_milli) || 0
  };
}

/** Runs loyalty expiry on a six-hour cadence; no-op without a service credential. */
export function startLoyaltyExpiry(
  intervalMs = Number(process.env.LOYALTY_EXPIRY_INTERVAL_MS) || 6 * 60 * 60 * 1000
): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey || intervalMs <= 0) return null;
  const run = () => {
    void expireLoyaltyPoints().then((result) => {
      if (result.expired_milli > 0) console.warn("[LOYALTY EXPIRY]", result);
    }).catch((error: unknown) => {
      console.error("[LOYALTY EXPIRY] run failed", { code: (error as { code?: string })?.code || "UNKNOWN" });
    });
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
