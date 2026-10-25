import { HttpError } from "../http.js";
import {
  CARRIER_STATUS_ACTIONS,
  carrierErrorMessage,
  carrierEventNote,
  carrierEventPayload,
  type CarrierDeliveryEvent,
} from "./carrier-contract.js";
import type { CarrierRepository } from "./carrier-repository.js";

/**
 * Action của state machine mà webhook được phép chạy, tách thành dependency để nghiệp vụ test được
 * mà không cần Supabase.
 */
export interface CarrierOrderActions {
  serviceAction(orderId: string, input: { action: string; note?: string; payload?: unknown }): Promise<unknown>;
}

/** Kết quả xử lý một sự kiện vận tải, đủ để nhà vận chuyển biết có cần gửi lại hay không. */
export interface CarrierEventOutcome {
  received: true;
  duplicate: boolean;
  orderCode: string;
  action: string;
}

/**
 * Nghiệp vụ webhook vận tải: ghi bằng chứng trước, chỉ đổi trạng thái đơn khi sự kiện là mới và
 * khớp đúng vận đơn đã bàn giao.
 *
 * Thứ tự này có chủ đích. Bảng `carrier_delivery_event` (migration 075) chặn trùng theo
 * (provider, provider_event_id), nên một lần giao hàng chỉ đi qua state machine một lần, dù nhà
 * vận chuyển retry bao nhiêu lượt. Sự kiện bị từ chối vẫn nằm lại ledger với `applied = false`,
 * đủ dấu vết để đối chiếu với nhà vận chuyển mà không cần đoán lại từ log.
 */
export function createCarrierService({ repository, orders }: { repository: CarrierRepository; orders: CarrierOrderActions }) {
  return {
    async handleEvent(event: CarrierDeliveryEvent): Promise<CarrierEventOutcome> {
      const fresh = await repository.record(event);
      if (!fresh) {
        return { received: true, duplicate: true, orderCode: event.orderCode, action: "" };
      }

      const order = await repository.findOrder(event.orderCode);
      if (!order || !order.order_id) {
        throw new HttpError(404, "CARRIER_ORDER_NOT_FOUND", carrierErrorMessage("CARRIER_ORDER_NOT_FOUND"));
      }
      // Không cho phép một sự kiện lệch vận đơn đẩy đơn khác sang trạng thái cuối: vận đơn là bằng
      // chứng duy nhất nối nhà vận chuyển với đúng đơn đã bàn giao.
      if (order.tracking_code && order.tracking_code !== event.trackingCode) {
        throw new HttpError(422, "CARRIER_TRACKING_MISMATCH", carrierErrorMessage("CARRIER_TRACKING_MISMATCH"));
      }

      const action = CARRIER_STATUS_ACTIONS[event.status];
      await orders.serviceAction(order.order_id, {
        action,
        note: carrierEventNote(event),
        payload: carrierEventPayload(event),
      });
      await repository.markApplied(event, order.order_id, action);

      return { received: true, duplicate: false, orderCode: order.order_code, action };
    },
  };
}

export type CarrierService = ReturnType<typeof createCarrierService>;
