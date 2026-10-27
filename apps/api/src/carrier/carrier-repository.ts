import { HttpError } from "../http.js";
import { callRpc, insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { carrierErrorMessage, carrierEventNote, carrierEventPayload, type CarrierDeliveryEvent } from "./carrier-contract.js";

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

/** Vận đơn hoàn + phiếu mà webhook cần để áp sự kiện. */
export interface CarrierReturnFacts {
  readonly shipment_id: string;
  readonly return_id: string;
  readonly direction: string;
  readonly carrier: string;
  readonly tracking_code: string;
  readonly handover_code: string;
  readonly return_code: string;
  readonly order_id: string | null;
  readonly return_status: string;
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
        order_code: event.orderCode || null,
        return_code: event.returnCode || null,
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
      if (!orderCode) return null;
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
     * Fallback for carriers that only send an AWB. Two different orders sharing one AWB is a
     * data error; refuse instead of applying the event to the wrong order.
     */
    async findOrderByTracking(trackingCode: string): Promise<CarrierOrderFacts | null> {
      const { rows } = await selectRows("orders", {
        tracking_code: `eq.${trackingCode}`,
        select: "order_id,order_code,status,tracking_code,carrier",
        limit: 2,
      });
      if (rows.length > 1) {
        throw new HttpError(409, "CARRIER_TRACKING_AMBIGUOUS", carrierErrorMessage("CARRIER_TRACKING_AMBIGUOUS"));
      }
      if (!rows.length) return null;
      const row = asJsonObject(rows[0]);
      return {
        order_id: asString(row.order_id),
        order_code: asString(row.order_code),
        status: asString(row.status),
        tracking_code: asString(row.tracking_code),
        carrier: asString(row.carrier),
      };
    },

    /**
     * Resolves a return shipment by internal return code first, then by AWB. The AWB lookup is
     * the practical path because carriers do not know Velura's internal return code.
     */
    async findReturnShipment(trackingCode: string, returnCode?: string): Promise<CarrierReturnFacts | null> {
      let returnRow: JsonObject | null = null;
      let shipment: JsonObject | null = null;

      // AWB first: that is the only identifier the carrier normally forwards.
      const { rows } = await selectRows("return_shipment", {
        tracking_code: `eq.${trackingCode}`,
        limit: 2,
      });
      if (rows.length > 1) {
        throw new HttpError(409, "CARRIER_RETURN_AMBIGUOUS", carrierErrorMessage("CARRIER_RETURN_AMBIGUOUS"));
      }
      if (rows.length === 1) {
        shipment = asJsonObject(rows[0]);
        returnRow = await selectOne("return_exchange", {
          return_id: `eq.${asString(shipment.return_id)}`,
          select: "return_id,return_code,order_id,status",
        });
        if (!returnRow) return null;
        if (returnCode && returnCode !== asString(returnRow.return_code)) {
          throw new HttpError(422, "CARRIER_RETURN_CODE_MISMATCH", carrierErrorMessage("CARRIER_RETURN_CODE_MISMATCH"));
        }
      } else {
        if (!returnCode) return null;
        returnRow = await selectOne("return_exchange", {
          return_code: `eq.${returnCode}`,
          select: "return_id,return_code,order_id,status",
        });
        if (!returnRow) return null;
        shipment = await selectOne("return_shipment", {
          return_id: `eq.${asString(returnRow.return_id)}`,
          direction: "eq.inbound",
        });
        if (!shipment) return null;
        if (asString(shipment.tracking_code) !== trackingCode) {
          throw new HttpError(422, "CARRIER_RETURN_TRACKING_MISMATCH", carrierErrorMessage("CARRIER_RETURN_TRACKING_MISMATCH"));
        }
      }

      return {
        shipment_id: asString(shipment.shipment_id),
        return_id: asString(returnRow.return_id),
        direction: asString(shipment.direction),
        carrier: asString(shipment.carrier),
        tracking_code: asString(shipment.tracking_code),
        handover_code: asString(shipment.handover_code),
        return_code: asString(returnRow.return_code),
        order_id: shipment.order_id ? asString(shipment.order_id) : null,
        return_status: asString(returnRow.status),
      };
    },

    /** Applies a return event in one DB transaction (shipment + return + linked exchange order). */
    async applyReturnEvent(facts: CarrierReturnFacts, event: CarrierDeliveryEvent): Promise<JsonObject> {
      return asJsonObject(await callRpc("velura_apply_return_carrier_event", {
        p_shipment_id: facts.shipment_id,
        p_status: event.status,
        p_note: carrierEventNote(event),
        p_payload: carrierEventPayload(event),
      }));
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

    async markReturnApplied(event: CarrierDeliveryEvent, facts: CarrierReturnFacts, action: string): Promise<void> {
      await updateRows(
        "carrier_delivery_event",
        { provider: `eq.${event.provider}`, provider_event_id: `eq.${event.providerEventId}` },
        {
          return_id: facts.return_id,
          return_shipment_id: facts.shipment_id,
          return_code: facts.return_code || event.returnCode || null,
          direction: facts.direction,
          action,
          applied: true
        },
      );
    },
  };
}

export type CarrierRepository = ReturnType<typeof createCarrierRepository>;
