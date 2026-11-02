import { config } from "../config.js";
import { HttpError } from "../http.js";
import { callRpc } from "../supabase.js";
import { asJsonObject } from "../types.js";

/** Chu kỳ mặc định: 5 phút. Hai mốc 24 giờ không cần chính xác tới từng phút. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** `off`: không chạy. `dry_run`: chỉ đếm số đơn đến hạn rồi ghi log. `on`: chạy thật. */
export type OrderAutomationMode = "off" | "dry_run" | "on";

/** Hạn tự xử lý của cả hai mốc AD_ORDER_03 và AD_ORDER_08: 24 giờ. */
export const ORDER_AUTOMATION_DUE_MS = 24 * 60 * 60 * 1000;
/** COD từ ngưỡng này trở lên không bao giờ tự xác nhận (AD_ORDER_03). */
export const AUTO_CONFIRM_COD_LIMIT = 1_000_000;

/**
 * Đọc chế độ từ `ORDER_AUTOMATION_MODE`. Chưa đặt hoặc rỗng = `on`, để AD_ORDER_03 và
 * AD_ORDER_08 luôn chạy; muốn tắt phải đặt `off` rõ ràng. Giá trị lạ coi như `off`
 * (không bật nhầm một tác vụ ghi dữ liệu).
 */
export function orderAutomationMode(value = process.env.ORDER_AUTOMATION_MODE): OrderAutomationMode {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "") return "on";
  return mode === "on" || mode === "dry_run" ? mode : "off";
}

/** Dữ kiện tối thiểu của một đơn để quyết định tác vụ System. */
export interface AutomationOrderFacts {
  status: string;
  paymentMethod: string;
  totalAmount: number;
  createdAt: string;
  isPaid: boolean;
  /** Cuộc gọi gần đây ghi nhận khách muốn huỷ đơn. */
  customerRequestsCancel: boolean;
}

/** Đơn COD dưới 1.000.000đ còn Chờ xác nhận quá 24 giờ, khách không xin huỷ (AD_ORDER_03). */
export function isAutoConfirmDue(order: AutomationOrderFacts, now = new Date()): boolean {
  return order.status === "pending"
    && order.paymentMethod === "COD"
    && order.totalAmount < AUTO_CONFIRM_COD_LIMIT
    && !order.customerRequestsCancel
    && now.getTime() - new Date(order.createdAt).getTime() >= ORDER_AUTOMATION_DUE_MS;
}

/** Đơn online Chờ thanh toán quá 24 giờ và chưa có tiền về thì hết hạn (AD_ORDER_08). */
export function isPaymentExpiryDue(order: AutomationOrderFacts, now = new Date()): boolean {
  return order.status === "waiting_payment"
    && order.paymentMethod === "ONLINE_PAYMENT"
    && !order.isPaid
    && now.getTime() - new Date(order.createdAt).getTime() >= ORDER_AUTOMATION_DUE_MS;
}

/** Số đơn một lượt đã chạm tới (dry_run: số đơn đến hạn). Dùng để quyết định có ghi log. */
export function automationTouchedCount(mode: OrderAutomationMode, result: Record<string, unknown>): number {
  return mode === "dry_run"
    ? Number(result.auto_confirm_due) + Number(result.payment_expired_due)
    : Number(result.auto_confirmed) + Number(result.payment_expired) + Number(result.failed);
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
 * Bật worker nền theo `ORDER_AUTOMATION_MODE` (mặc định `on`, `off` để tắt, `dry_run` để chỉ
 * đếm). Mỗi lượt xử lý tối đa 200 đơn mỗi loại trong cơ sở dữ liệu và idempotent.
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
      const touched = automationTouchedCount(mode, result);
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
