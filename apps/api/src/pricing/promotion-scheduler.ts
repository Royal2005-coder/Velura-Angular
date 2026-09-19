import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";

/** Chu kỳ mặc định: 5 phút. Đủ nhanh để chiến dịch flash sale bật đúng giờ. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tự bật và tắt chiến dịch khuyến mãi theo ngày bắt đầu / kết thúc.
 *
 * Trước đây chiến dịch chỉ được bật tắt bằng tay, nên một chiến dịch đã hết hạn vẫn
 * hiển thị "Đang hoạt động" trên màn admin mãi mãi — dù mã của nó đã bị từ chối ở
 * bước thanh toán. Hai nơi nói hai chuyện khác nhau về cùng một chiến dịch.
 *
 * Trả về handle của bộ đếm, hoặc null khi chưa cấu hình khóa service role.
 */
export function startPromotionScheduler(): ReturnType<typeof setInterval> | null {
  if (!config.supabaseServiceRoleKey) return null;

  const intervalMs = Number(process.env.PROMOTION_SCHEDULER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  const run = async () => {
    try {
      await callRpc("velura_sync_promotion_schedule", {});
    } catch (error) {
      const code = error instanceof HttpError ? error.code || "UNKNOWN" : "UNKNOWN";
      const status = error instanceof HttpError ? error.status || 500 : 500;
      console.error("[promotion-scheduler] schedule sync failed", { code, status });
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
