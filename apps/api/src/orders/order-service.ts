import { HttpError } from "../http.js";
import { asString, type AuthContext, type JsonObject, type RequestMeta } from "../types.js";
import {
  ORDER_OPERATOR_ROLES,
  ORDER_READER_ROLES,
  ORDER_SORTS,
  ORDER_STATUSES,
  PAYMENT_DECISIONS
} from "./order-constants.js";
import type { OrderRepository } from "./order-repository.js";
import { orderErrorMessage } from "./order-repository.js";
import {
  CALL_RESULTS,
  CARRIER_OUTCOMES,
  ORDER_STATUS_LABELS,
  ORDER_TAG_LABELS,
  PAYMENT_STATUS_LABELS,
  actionGuard,
  allowedAdminActions,
  findOrderAction,
  orderFacts,
  orderStatusLabel,
  type OrderStatus
} from "./order-state-machine.js";

/** Hoàn tiền qua cổng thanh toán; tách ra để kiểm thử không gọi Stripe thật. */
export interface OrderRefundGateway {
  refund(orderId: string): Promise<{ status: "refunded" | "requested" | "failed" | "skipped"; message?: string }>;
}

/**
 * Admin order use-cases used by `handleOrderRoute`.
 */
export interface OrderService {
  list(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  summary(context: AuthContext | undefined): Promise<unknown>;
  get(context: AuthContext | undefined, orderId: string): Promise<unknown>;
  listAuditLogs(context: AuthContext | undefined, orderId: string, searchParams: URLSearchParams): Promise<unknown>;
  performAction(context: AuthContext | undefined, orderId: string, action: string, body: JsonObject, requestMeta: RequestMeta): Promise<unknown>;
  simulateCarrier(context: AuthContext | undefined, orderId: string, body: JsonObject): Promise<unknown>;
  resolvePayment(
    context: AuthContext | undefined,
    orderId: string,
    paymentId: string,
    body: JsonObject,
    requestMeta: RequestMeta
  ): Promise<unknown>;
}

/** Lý do huỷ gợi ý cho admin. Chọn "other" thì bắt nhập lý do riêng. */
export const CANCEL_REASONS: Readonly<Record<string, string>> = {
  customer_request: "Khách yêu cầu huỷ",
  out_of_stock: "Hết hàng, không thể giao",
  unreachable: "Không liên hệ được khách",
  suspected_fraud: "Nghi ngờ đơn ảo",
  other: "Lý do khác"
};

/**
 * Create the admin order application service.
 */
export function createOrderService({
  repository,
  refunds = null
}: {
  repository: OrderRepository;
  refunds?: OrderRefundGateway | null;
}): OrderService {
  if (!repository) throw new TypeError("repository is required");

  /** Gắn nhãn, tag và action hợp lệ cho một đơn trước khi trả về frontend. */
  function decorate(order: JsonObject, tags: string[], roleCode: string | undefined): JsonObject {
    const facts = orderFacts(order);
    const payments = Array.isArray(order.payments) ? order.payments as JsonObject[] : [];
    const latestPayment = [...payments].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    return {
      ...order,
      status_label: orderStatusLabel(order.status),
      payment_status: latestPayment?.payment_status ?? null,
      payment_status_label: latestPayment?.payment_status ? PAYMENT_STATUS_LABELS[String(latestPayment.payment_status)] ?? String(latestPayment.payment_status) : null,
      tags: tags.map((code) => ({ code, label: ORDER_TAG_LABELS[code] ?? code })),
      allowed_actions: allowedAdminActions(facts, roleCode),
      can_simulate_carrier: roleCode === "super_admin" && facts.status === "shipping"
    };
  }

  return {
    async list(context, searchParams) {
      requireOrderReader(context);
      const payload = await repository.list(parseListFilters(searchParams), context.accessToken);
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const tags = await repository.tagsFor(rows.map((row) => asString(row.order_id)), context.accessToken);
      return {
        ...payload,
        rows: rows.map((row) => decorate(row, tags[asString(row.order_id)] ?? [], context.roleCode))
      };
    },

    async summary(context) {
      requireOrderReader(context);
      const [byStatus, attention] = await Promise.all([
        repository.countByStatus(ORDER_STATUSES, context.accessToken),
        repository.countAttention(context.accessToken)
      ]);
      return {
        by_status: ORDER_STATUSES.map((status) => ({ status, label: ORDER_STATUS_LABELS[status], count: byStatus[status] ?? 0 })),
        attention
      };
    },

    async get(context, orderId) {
      requireOrderReader(context);
      requireUuid(orderId, "orderId");
      const order = await repository.findById(orderId, context.accessToken);
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", orderErrorMessage("ORDER_NOT_FOUND"));
      const tags = await repository.tagsFor([orderId], context.accessToken);
      return decorate(order, tags[orderId] ?? [], context.roleCode);
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

    async performAction(context, orderId, action, body, requestMeta) {
      requireOrderOperator(context);
      requireUuid(orderId, "orderId");
      const spec = findOrderAction(action);
      if (!spec || spec.actor !== "order_admin") {
        throw new HttpError(422, "UNKNOWN_ORDER_ACTION", orderErrorMessage("UNKNOWN_ORDER_ACTION"));
      }
      const input = validateActionInput(action, body);

      // Kiểm trước bằng cùng bảng quy tắc để trả lỗi rõ ràng mà không tốn một lượt RPC.
      // RPC vẫn kiểm lại theo dữ liệu mới nhất (BR-04, AC-19).
      const current = await repository.findById(orderId, context.accessToken);
      if (!current) throw new HttpError(404, "ORDER_NOT_FOUND", orderErrorMessage("ORDER_NOT_FOUND"));
      const blocked = actionGuard(action, orderFacts(current));
      if (blocked) throw new HttpError(422, blocked, orderErrorMessage(blocked));

      const result = await repository.performAction(orderId, {
        action,
        note: input.note,
        payload: input.payload,
        expectedVersion: input.expectedVersion,
        ipAddress: requestMeta.ipAddress
      }, context.accessToken) as JsonObject;

      const refund = result?.refund_required && refunds ? await refunds.refund(orderId) : null;
      const fresh = await this.get(context, orderId);
      return { order: fresh, refund };
    },

    async simulateCarrier(context, orderId, body) {
      requireOrderReader(context);
      if (context.roleCode !== "super_admin") {
        throw new HttpError(403, "CARRIER_SIMULATION_DENIED", orderErrorMessage("CARRIER_SIMULATION_DENIED"));
      }
      requireUuid(orderId, "orderId");
      const outcome = String(body?.outcome || "");
      const action = CARRIER_OUTCOMES[outcome];
      if (!action) {
        throw validationError("outcome", `Must be one of: ${Object.keys(CARRIER_OUTCOMES).join(", ")}`);
      }
      const note = optionalText(body?.note, 500, "note") || `Mô phỏng ĐVVC: ${outcome}`;
      await repository.serviceAction(orderId, { action, note, payload: { simulated_by: context.profile?.user_id ?? null } });
      return this.get(context, orderId);
    },

    async resolvePayment(context, orderId, paymentId, body, requestMeta) {
      requireOrderOperator(context);
      requireUuid(orderId, "orderId");
      requireUuid(paymentId, "paymentId");
      if (!PAYMENT_DECISIONS.includes(body?.decision as string)) {
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

/**
 * Kiểm body của một action thủ công theo các trường KAN-60 quy định cho action đó.
 */
export function validateActionInput(action: string, body: JsonObject = {}) {
  const spec = findOrderAction(action);
  if (!spec) throw new HttpError(422, "UNKNOWN_ORDER_ACTION", orderErrorMessage("UNKNOWN_ORDER_ACTION"));
  const note = optionalText(body.note, 1000, "note");
  if (spec.requiresNote && (!note || note.length < 5)) {
    throw new HttpError(422, "NOTE_REQUIRED", orderErrorMessage("NOTE_REQUIRED"), { note: [orderErrorMessage("NOTE_REQUIRED")] });
  }
  const payload: JsonObject = {};
  if (spec.fields.includes("call_result")) {
    const value = String(body.callResult || "");
    if (!CALL_RESULTS[value]) throw new HttpError(422, "CALL_RESULT_REQUIRED", orderErrorMessage("CALL_RESULT_REQUIRED"));
    payload.call_result = value;
  }
  if (spec.fields.includes("shortage")) {
    const value = optionalText(body.shortage, 500, "shortage");
    if (!value) throw new HttpError(422, "SHORTAGE_REQUIRED", orderErrorMessage("SHORTAGE_REQUIRED"));
    payload.shortage = value;
  }
  if (spec.fields.includes("shipment") || spec.fields.includes("tracking")) {
    const trackingCode = optionalText(body.trackingCode, 60, "trackingCode");
    if (!trackingCode) throw new HttpError(422, "TRACKING_CODE_REQUIRED", orderErrorMessage("TRACKING_CODE_REQUIRED"));
    payload.tracking_code = trackingCode;
    const carrier = optionalText(body.carrier, 80, "carrier");
    if (spec.fields.includes("shipment") && !carrier) throw validationError("carrier", "Chọn đơn vị vận chuyển");
    if (carrier) payload.carrier = carrier;
    const trackingUrl = optionalText(body.trackingUrl, 500, "trackingUrl");
    if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) throw validationError("trackingUrl", "Link tracking phải bắt đầu bằng https://");
    if (trackingUrl) payload.tracking_url = trackingUrl;
  }
  if (spec.fields.includes("cancel_reason")) {
    const code = String(body.cancelReason || "");
    if (!CANCEL_REASONS[code]) throw new HttpError(422, "CANCEL_REASON_REQUIRED", orderErrorMessage("CANCEL_REASON_REQUIRED"));
    payload.cancel_reason = code === "other" ? (note || CANCEL_REASONS.other) : CANCEL_REASONS[code];
    payload.cancel_reason_code = code;
  }
  return { note, payload, expectedVersion: requireVersion(body.expectedVersion) };
}

function parseListFilters(searchParams: URLSearchParams): JsonObject {
  const status = searchParams.get("status") || "";
  if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) throw validationError("status", "Invalid status filter");
  const tag = searchParams.get("tag") || "";
  if (tag && !ORDER_TAG_LABELS[tag]) throw validationError("tag", "Invalid tag filter");
  const from = parseDate(searchParams.get("from"), "from");
  const to = parseDate(searchParams.get("to"), "to");
  if (from && to && from > to) throw validationError("date", "from cannot be after to");
  const order = searchParams.get("order") || "order_date.desc";
  return {
    q: String(searchParams.get("q") || "").replace(/[,()*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100),
    status: (status as OrderStatus) || undefined,
    tag: tag || undefined,
    attention: searchParams.get("attention") === "true",
    from,
    to,
    paymentMethod: optionalEnum(searchParams.get("paymentMethod"), ["COD", "ONLINE_PAYMENT"], "paymentMethod"),
    limit: clampInteger(searchParams.get("limit"), 20, 1, 1000),
    offset: clampInteger(searchParams.get("offset"), 0, 0, 1_000_000),
    order: ORDER_SORTS.includes(order) ? order : "order_date.desc"
  };
}

function requireOrderReader(context: AuthContext | undefined): asserts context is AuthContext {
  if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  if (!context.isAdmin || !context.profile?.is_active) throw new HttpError(403, "ADMIN_REQUIRED", "Admin access is required");
  if (!ORDER_READER_ROLES.includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", orderErrorMessage("RBAC_DENIED"));
}

function requireOrderOperator(context: AuthContext | undefined): asserts context is AuthContext {
  requireOrderReader(context);
  if (!ORDER_OPERATOR_ROLES.includes(context.roleCode)) throw new HttpError(403, "RBAC_DENIED", orderErrorMessage("RBAC_DENIED"));
}

function requireUuid(value: unknown, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""))) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function requireReason(value: unknown): string {
  const reason = String(value || "").trim();
  if (reason.length < 10 || reason.length > 500) throw validationError("reason", "Reason must contain 10 to 500 characters");
  return reason;
}

function requireVersion(value: unknown, field = "expectedVersion"): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw validationError(field, `${field} must be a positive integer`);
  return version;
}

function optionalText(value: unknown, maxLength: number, field: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) throw validationError(field, `Must not exceed ${maxLength} characters`);
  return text;
}

function optionalEnum(value: string | null, allowed: string[], field: string): string | undefined {
  if (!value) return undefined;
  if (!allowed.includes(value)) throw validationError(field, `Must be one of: ${allowed.join(", ")}`);
  return value;
}

function parseDate(value: string | null, field: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(field, `${field} must be a valid date`);
  return date.toISOString();
}

function clampInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validationError(field: string, message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request validation failed", { [field]: [message] });
}
