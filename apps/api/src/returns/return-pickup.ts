import type { JsonObject } from "../types.js";
import { asString } from "../types.js";

/**
 * Giờ hẹn ĐVVC lấy hàng sớm nhất trong các phần hàng của một phiếu (`return_item.pickup_scheduled_at`,
 * migration 128). So sánh theo thời điểm thực, bỏ qua giá trị rỗng hoặc không phải ngày hợp lệ.
 * Trả `null` khi chưa phần hàng nào có lịch hẹn.
 */
export function earliestPickupSlot(items: readonly JsonObject[]): string | null {
  let best: { at: number; value: string } | null = null;
  for (const item of items) {
    const value = asString(item.pickup_scheduled_at);
    const at = Date.parse(value);
    if (!value || Number.isNaN(at)) continue;
    if (!best || at < best.at) best = { at, value };
  }
  return best?.value ?? null;
}
