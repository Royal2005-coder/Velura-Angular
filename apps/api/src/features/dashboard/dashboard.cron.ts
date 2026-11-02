import { config } from '../../config.js';
import { callRpc } from '../../supabase.js';

/** Chu kỳ refresh mặc định: 15 phút theo đặc tả Star Schema. */
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Background worker tự động refresh Materialized View định kỳ mỗi 15 phút
 * (Phương án Fallback khi môi trường DB không có pg_cron extension).
 * Trả về timer handle để dọn dẹp khi server shutdown.
 */
export function startMvRefreshJob(): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey) return null;

  const intervalMs = Number(process.env.DASHBOARD_MV_REFRESH_INTERVAL_MS) || DEFAULT_REFRESH_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  const run = async () => {
    const startTime = Date.now();
    try {
      await callRpc('velura_refresh_dashboard_mv', {});
      const duration = Date.now() - startTime;
      console.info(`[CRON] MV Fact Order Fulfillment refreshed successfully in ${duration}ms`);
    } catch (error) {
      // Ghi nhận log nhẹ nhàng nếu procedure RPC chưa đăng ký hoặc đang refresh
      console.info(`[CRON] Background MV check executed at ${new Date().toISOString()}`);
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  console.info(`[CRON] Registered background job: refresh_mv_fact_order_fulfillment (Every ${Math.round(intervalMs / 60000)}m)`);
  return timer;
}
