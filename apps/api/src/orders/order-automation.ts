import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";
import { asJsonObject } from "../types.js";

/** Chu kỳ mặc định: 5 phút. Hai mốc 24 giờ không cần chính xác tới từng phút. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** `off`: không chạy. `dry_run`: chỉ đếm số đơn đến hạn rồi ghi log. `on`: chạy thật. */
export type OrderAutomationMode = "off" | "dry_run" | "on";

/** Đọc chế độ từ `ORDER_AUTOMATION_MODE`; giá trị lạ coi như `off`. */
export function orderAutomationMode(value = process.env.ORDER_AUTOMATION_MODE): OrderAutomationMode {
  return value === "on" || value === "dry_run" ? value : "off";
}

/**
 * Một lượt tác vụ System của đơn hàng (KAN-59), chạy trong cơ sở dữ liệu:
 * - COD dưới 1.000.000đ còn Chờ xác nhận quá 24 giờ thì tự xác nhận (AC-05);
 * - đơn Chờ thanh toán quá 24 giờ thì huỷ, trả kho và lượt mã nếu có (AC-08).
 *
 * Chạy lại nhiều lần vẫn cho cùng kết quả: đơn đã xử lý không còn khớp điều kiện.
 */
export async function runOrderAutomation(dryRun: boolean) {
  return asJsonObject(await callRpc("velura_run_order_automation", { p_dry_run: dryRun }));
}

/**
 * Bật worker nền theo `ORDER_AUTOMATION_MODE`. Mặc định tắt: lần bật đầu trên production
 * sẽ tự xác nhận ngay các đơn COD đã quá hạn, nên phải chạy `dry_run` và đối chiếu số đơn
 * trước.
 *
 * Trả về handle của bộ đếm, hoặc null khi không chạy.
 */
export function startOrderAutomation(mode = orderAutomationMode()): ReturnType<typeof setInterval> | null {
  if (mode === "off" || !config.supabaseServiceRoleKey) return null;

  const intervalMs = Number(process.env.ORDER_AUTOMATION_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  const run = async () => {
    try {
      const result = await runOrderAutomation(mode === "dry_run");
      const touched = mode === "dry_run"
        ? Number(result.auto_confirm_due) + Number(result.payment_expired_due)
        : Number(result.auto_confirmed) + Number(result.payment_expired) + Number(result.failed);
      if (touched > 0) console.warn("[order-automation]", mode, result);
    } catch (error) {
      const code = error instanceof HttpError ? error.code || "UNKNOWN" : "UNKNOWN";
      const status = error instanceof HttpError ? error.status || 500 : 500;
      console.error("[order-automation] run failed", { code, status });
    }
  };

  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
