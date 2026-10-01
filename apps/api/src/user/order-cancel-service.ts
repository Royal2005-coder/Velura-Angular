import { HttpError } from "../http.js";
import { callRpc, selectOne } from "../supabase.js";
import { orderErrorMessage } from "../orders/order-repository.js";
import { actionGuard, orderFacts } from "../orders/order-state-machine.js";
import { asJsonObject, asNumber, asString, type JsonObject } from "../types.js";

/**
 * Data an order mutation needs from the caller, kept here instead of the router so the
 * business rule (ownership, status guard, version check) can run against a fake repository
 * in tests without a real Supabase call.
 */
export interface CustomerOrderCancelRepository {
  findOrder(orderId: string): Promise<JsonObject | null>;
  cancel(orderId: string, input: { actorId: string; note: string; expectedVersion: number }): Promise<unknown>;
}

/**
 * Real repository: same RPC the inline handler used to call directly, now behind an
 * interface so `order-cancel-service.test.ts` can substitute a fake.
 */
export function createCustomerOrderCancelRepository(): CustomerOrderCancelRepository {
  return {
    findOrder: (orderId) => selectOne("orders", { order_id: `eq.${orderId}` }),
    cancel: (orderId, input) =>
      callRpc("velura_order_service_action", {
        p_order_id: orderId,
        p_action: "customer_cancel",
        p_actor_id: input.actorId,
        p_note: input.note,
        p_payload: { cancel_reason: input.note },
        p_expected_version: input.expectedVersion
      })
  };
}

export interface CancelOrderInput {
  orderId: string;
  userId: string;
  reason: unknown;
  expectedVersion: unknown;
}

export interface CancelOrderResult {
  order: JsonObject;
  refundRequired: boolean;
  reason: string;
}

/**
 * Hủy đơn cho khách: kiểm quyền sở hữu + chặn sớm bằng `actionGuard` (cùng bảng rule đã có
 * test ở `order-state-machine.test.ts`) trước khi gọi RPC, rồi map lỗi từ RPC (version lệch
 * do đổi ở nơi khác trong lúc chờ) về cùng mã lỗi.
 */
export async function cancelOrderForCustomer(
  repository: CustomerOrderCancelRepository,
  input: CancelOrderInput
): Promise<CancelOrderResult> {
  const expectedVersion = requireExpectedVersion(input.expectedVersion);

  const order = await repository.findOrder(input.orderId);
  if (!order) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy đơn hàng");
  if (order.user_id !== input.userId) {
    throw new HttpError(403, "FORBIDDEN", "Bạn không có quyền cập nhật đơn hàng này");
  }

  // Đơn không có quan hệ `payments` ở đây, nhưng `customer_cancel` chỉ xét status và
  // `handed_over_at` — cả hai đều là cột thẳng trên `orders`, nên facts rút gọn vẫn đúng.
  const blocked = actionGuard("customer_cancel", orderFacts({ ...order, payments: [] }));
  if (blocked) throw cancelActionError(blocked);

  const reason = String(input.reason || "").trim().slice(0, 300) || "Khách hàng tự huỷ";

  let result: JsonObject;
  try {
    result = asJsonObject(
      await repository.cancel(input.orderId, { actorId: input.userId, note: reason, expectedVersion })
    );
  } catch (error: unknown) {
    throw mapCancelRpcError(error);
  }

  return {
    order: asJsonObject(result.order),
    refundRequired: Boolean(result.refund_required),
    reason
  };
}

function requireExpectedVersion(value: unknown): number {
  const version = asNumber(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(422, "EXPECTED_VERSION_REQUIRED", orderErrorMessage("EXPECTED_VERSION_REQUIRED"));
  }
  return version;
}

/** Cùng thông điệp cho khách dù bị chặn trước khi gọi RPC hay bị RPC từ chối (đụng race). */
function cancelActionError(code: string): HttpError {
  if (code === "INVALID_ORDER_ACTION" || code === "ORDER_ALREADY_HANDED_OVER") {
    return new HttpError(
      400,
      code,
      "Đơn hàng đã được chuẩn bị hoặc giao cho đơn vị vận chuyển, không thể tự huỷ. Vui lòng liên hệ CSKH."
    );
  }
  return new HttpError(422, code, orderErrorMessage(code));
}

function mapCancelRpcError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const code = asString(asJsonObject(error.details).message) || error.code;
  if (code === "VERSION_CONFLICT") {
    return new HttpError(
      409,
      "VERSION_CONFLICT",
      "Đơn hàng vừa được cập nhật, vui lòng tải lại trang để xem trạng thái mới nhất."
    );
  }
  if (code === "INVALID_ORDER_ACTION" || code === "ORDER_ALREADY_HANDED_OVER") {
    return cancelActionError(code);
  }
  return error;
}
