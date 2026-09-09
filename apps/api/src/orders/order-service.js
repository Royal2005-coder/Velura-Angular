import { HttpError } from "../http.js";
import {
  ORDER_OPERATOR_ROLES,
  ORDER_READER_ROLES,
  ORDER_SORTS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  PAYMENT_DECISIONS
} from "./order-constants.js";

export function createOrderService({ repository }) {
  if (!repository) throw new TypeError("repository is required");

  return {
    async list(context, searchParams) {
      requireOrderReader(context);
      return repository.list(parseListFilters(searchParams), context.accessToken);
    },

    async get(context, orderId) {
      requireOrderReader(context);
      requireUuid(orderId, "orderId");
      const order = await repository.findById(orderId, context.accessToken);
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order was not found");
      return order;
    },

    async listAuditLogs(context, orderId, searchParams) {
      requireOrderReader(context);
      requireUuid(orderId, "orderId");
      return repository.listAuditLogs({
        orderId,
        limit: clampInteger(searchParams.get("limit"), 50, 1, 100),
        offset: clampInteger(searchParams.get("offset"), 0, 0, 1_000_000)
      }, context.accessToken);
    },

    async changeStatus(context, orderId, body, requestMeta) {
      requireOrderOperator(context);
      requireUuid(orderId, "orderId");
      const input = validateStatusChange(body);
      const order = await repository.findById(orderId, context.accessToken);
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order was not found");
      if (!ORDER_TRANSITIONS[order.status]?.includes(input.status) || input.status === "cancelled") {
        throw validationError("status", `Cannot change status from ${order.status} to ${input.status}`);
      }
      return repository.changeStatus(orderId, { ...input, ipAddress: requestMeta.ipAddress }, context.accessToken);
    },

    async cancel(context, orderId, body, requestMeta) {
      requireOrderOperator(context);
      requireUuid(orderId, "orderId");
      return repository.cancel(orderId, {
        reason: requireReason(body?.reason),
        expectedVersion: requireVersion(body?.expectedVersion),
        ipAddress: requestMeta.ipAddress
      }, context.accessToken);
    },

    async resolvePayment(context, orderId, paymentId, body, requestMeta) {
      requireOrderOperator(context);
      requireUuid(orderId, "orderId");
      requireUuid(paymentId, "paymentId");
      if (!PAYMENT_DECISIONS.includes(body?.decision)) {
        throw validationError("decision", `Must be one of: ${PAYMENT_DECISIONS.join(", ")}`);
      }
      return repository.resolvePayment(orderId, paymentId, {
        decision: body.decision,
        reason: requireReason(body.reason),
        expectedOrderVersion: requireVersion(body.expectedOrderVersion, "expectedOrderVersion"),
        expectedPaymentVersion: requireVersion(body.expectedPaymentVersion, "expectedPaymentVersion"),
        ipAddress: requestMeta.ipAddress
      }, context.accessToken);
    }
  };
}

export function validateStatusChange(body = {}) {
  if (!ORDER_STATUSES.includes(body.status)) {
    throw validationError("status", `Must be one of: ${ORDER_STATUSES.join(", ")}`);
  }
  const trackingCode = optionalText(body.trackingCode, 100);
  if (body.status === "shipping" && !trackingCode) {
    throw validationError("trackingCode", "Tracking code is required for shipping");
  }
  return {
    status: body.status,
    reason: requireReason(body.reason),
    trackingCode,
    expectedVersion: requireVersion(body.expectedVersion)
  };
}

function parseListFilters(searchParams) {
  const status = searchParams.get("status") || "";
  if (status && !ORDER_STATUSES.includes(status)) throw validationError("status", "Invalid status filter");
  const from = parseDate(searchParams.get("from"), "from");
  const to = parseDate(searchParams.get("to"), "to");
  if (from && to && from > to) throw validationError("date", "from cannot be after to");
  const order = searchParams.get("order") || "order_date.desc";
  return {
    q: String(searchParams.get("q") || "").replace(/[,()*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100),
    status: status || undefined,
    from,
    to,
    paymentMethod: optionalEnum(searchParams.get("paymentMethod"), ["COD", "ONLINE_PAYMENT"], "paymentMethod"),
    limit: clampInteger(searchParams.get("limit"), 20, 1, 1000),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1_000_000),
    order: ORDER_SORTS.includes(order) ? order : "order_date.desc"
  };
}

function requireOrderReader(context) {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!context.isAdmin || !context.profile?.is_active) throw new HttpError(403, "ADMIN_REQUIRED", "Admin access is required");
  if (!ORDER_READER_ROLES.includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", "This admin role cannot access orders");
}

function requireOrderOperator(context) {
  requireOrderReader(context);
  if (!ORDER_OPERATOR_ROLES.includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", "This admin role cannot modify orders");
}

function requireUuid(value, field) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""))) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function requireReason(value) {
  const reason = String(value || "").trim();
  if (reason.length < 10 || reason.length > 500) throw validationError("reason", "Reason must contain 10 to 500 characters");
  return reason;
}

function requireVersion(value, field = "expectedVersion") {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw validationError(field, `${field} must be a positive integer`);
  return version;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length > maxLength) throw validationError("trackingCode", `Must not exceed ${maxLength} characters`);
  return text;
}

function optionalEnum(value, allowed, field) {
  if (!value) return undefined;
  if (!allowed.includes(value)) throw validationError(field, `Must be one of: ${allowed.join(", ")}`);
  return value;
}

function parseDate(value, field) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(field, `${field} must be a valid date`);
  return date.toISOString();
}

function clampInteger(raw, fallback, min, max) {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validationError(field, message) {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: [message] });
}
