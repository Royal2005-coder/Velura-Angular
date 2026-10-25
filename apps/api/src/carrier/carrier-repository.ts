import { HttpError } from "../http.js";
import { insertRow, selectOne, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import type { CarrierDeliveryEvent } from "./carrier-contract.js";

/**
 * Truy cập bảng bằng chứng vận tải (migration 075) và tra đơn theo mã nhà vận chuyển gửi tới.
 *
 * Webhook đến từ nhà vận chuyển nên không có token người dùng: mọi câu lệnh chạy bằng khoá
 * service-role, và bảng được RLS chặn hoàn toàn với `anon`/`authenticated`.
 */

/** Phần tử đơn hàng mà webhook cần để quyết định có được áp sự kiện hay không. */
export interface CarrierOrderFacts {
  readonly order_id: string;
  readonly order_code: string;
  readonly status: string;
  readonly tracking_code: string;
  readonly carrier: string;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.code === "SUPABASE_ERROR" &&
    asString(asJsonObject(error.details).code) === "23505"
  );
}

export function createCarrierRepository() {
  return {
    /**
     * Ghi một sự kiện vừa nhận. Trả `false` khi (provider, provider_event_id) đã có: nhà vận chuyển
     * gửi lại sau timeout, không phải một lần giao hàng mới.
     */
    async record(event: CarrierDeliveryEvent): Promise<boolean> {
      const row: JsonObject = {
        provider: event.provider,
        provider_event_id: event.providerEventId,
        order_code: event.orderCode,
        tracking_code: event.trackingCode,
        status: event.status,
        occurred_at: event.occurredAt,
        detail: event.detail || null,
        payload: event.raw,
        applied: false,
      };
      try {
        await insertRow("carrier_delivery_event", row);
        return true;
      } catch (error: unknown) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },

    /**
     * Đơn đang chờ sự kiện, theo đúng mã nhà vận chuyển báo về.
     */
    async findOrder(orderCode: string): Promise<CarrierOrderFacts | null> {
      const row = await selectOne("orders", {
        order_code: `eq.${orderCode}`,
        select: "order_id,order_code,status,tracking_code,carrier",
      });
      if (!row) return null;
      return {
        order_id: asString(row.order_id),
        order_code: asString(row.order_code),
        status: asString(row.status),
        tracking_code: asString(row.tracking_code),
        carrier: asString(row.carrier),
      };
    },

    /**
     * Đánh dấu sự kiện đã đi vào đơn, kèm order_id và action đã chạy để tra lại sau.
     */
    async markApplied(event: CarrierDeliveryEvent, orderId: string, action: string): Promise<void> {
      await updateRows(
        "carrier_delivery_event",
        { provider: `eq.${event.provider}`, provider_event_id: `eq.${event.providerEventId}` },
        { order_id: orderId, action, applied: true },
      );
    },
  };
}

export type CarrierRepository = ReturnType<typeof createCarrierRepository>;
