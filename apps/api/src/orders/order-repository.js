import { HttpError } from "../http.js";
import { callRpc, selectOne, selectRows } from "../supabase.js";
import { ORDER_DETAIL_SELECT, ORDER_LIST_SELECT } from "./order-constants.js";

export function createOrderRepository() {
  return {
    list(filters, accessToken) {
      const query = { select: ORDER_LIST_SELECT, order: filters.order, limit: filters.limit, offset: filters.offset };
      if (filters.q) query.or = `(shipping_name.ilike.*${filters.q}*,shipping_phone.ilike.*${filters.q}*,tracking_code.ilike.*${filters.q}*)`;
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.paymentMethod) query.payment_method = `eq.${filters.paymentMethod}`;
      if (filters.from && filters.to) query.and = `(order_date.gte.${filters.from},order_date.lte.${filters.to})`;
      else if (filters.from) query.order_date = `gte.${filters.from}`;
      else if (filters.to) query.order_date = `lte.${filters.to}`;
      return withOrderError(() => selectRows("orders", query, authOptions(accessToken)));
    },

    findById(orderId, accessToken) {
      return withOrderError(() => selectOne("orders", {
        select: ORDER_DETAIL_SELECT,
        order_id: `eq.${orderId}`
      }, authOptions(accessToken)));
    },

    changeStatus(orderId, input, accessToken) {
      return rpc("admin_change_order_status", {
        p_order_id: orderId,
        p_new_status: input.status,
        p_reason: input.reason,
        p_tracking_code: input.trackingCode,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    cancel(orderId, input, accessToken) {
      return rpc("admin_cancel_order", {
        p_order_id: orderId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    resolvePayment(orderId, paymentId, input, accessToken) {
      return rpc("admin_resolve_payment", {
        p_order_id: orderId,
        p_payment_id: paymentId,
        p_decision: input.decision,
        p_reason: input.reason,
        p_expected_order_version: input.expectedOrderVersion,
        p_expected_payment_version: input.expectedPaymentVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    listAuditLogs(filters, accessToken) {
      return withOrderError(() => selectRows("audit_log", {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.orders",
        target_id: `eq.${filters.orderId}`,
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      }, authOptions(accessToken)));
    }
  };
}

function authOptions(accessToken) {
  return { useAnonKey: true, accessToken };
}

function rpc(name, payload, accessToken) {
  return withOrderError(() => callRpc(name, payload, authOptions(accessToken)));
}

async function withOrderError(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const code = error.details?.message || error.details?.code || "ORDER_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, code, databaseMessage(code), error.details);
    }
    throw error;
  }
}

function databaseMessage(code) {
  const messages = {
    RBAC_DENIED: "You do not have permission to manage orders",
    ORDER_NOT_FOUND: "Order was not found",
    PAYMENT_NOT_FOUND: "Payment was not found",
    VERSION_CONFLICT: "Order data changed; reload before trying again",
    PAYMENT_VERSION_CONFLICT: "Payment data changed; reload before trying again",
    INVALID_ORDER_TRANSITION: "The requested order status transition is not allowed",
    ORDER_CANNOT_CANCEL: "The order can no longer be cancelled",
    ORDER_TERMINAL: "A terminal order cannot be modified",
    PAYMENT_NOT_RESOLVABLE: "This payment does not require manual resolution"
  };
  return messages[code] || "Order database operation failed";
}
