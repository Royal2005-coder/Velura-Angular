import { enrichAuditLogs, RETURN_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, HttpRequest, JsonObject, RequestMeta } from "../types.js";
import { asJsonObject, asNumber, asString, errorMessage } from "../types.js";
import {
  RETURN_OPERATOR_ROLES,
  RETURN_READER_ROLES,
  SUPPORT_TICKET_TRANSITIONS
} from "./return-constants.js";
import { sendRefundSuccessEmail } from "./return-email.js";
import {
  adminRefundReceiver,
  classifyReturnPayment,
  REFUND_RECEIVER_CLOSED_STATUSES,
  refundFlowFor,
  refundReceiverStatus
} from "./return-refund-receiver.js";
import { listReturnEvidence, resolveEvidenceRef, storeReturnEvidence, type ReturnEvidenceKind } from "./return-evidence.js";
import type { ReturnRepository } from "./return-repository.js";

/**
 * Auth context plus optional request IP used by return mutations.
 */
type ReturnContext = AuthContext & Partial<RequestMeta>;

/**
 * Hoàn tiền qua cổng thanh toán cho đơn hàng gắn với phiếu đổi trả.
 */
export interface ReturnRefundGateway {
  /** Refunds one return part using that part's version; returnItemId is required whenever returnId is supplied. */
  refund(orderId: string, amount?: number, returnId?: string, expectedVersion?: number, returnItemId?: string): Promise<{ status: "refunded" | "requested" | "failed" | "skipped"; message?: string }>;
}

/**
 * Admin return / support use-cases consumed by `handleReturnRoute`.
 */
export interface ReturnService {
  listReturns(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  getReturn(context: ReturnContext | undefined, returnId: string): Promise<JsonObject>;
  /** Applies one versioned line action; optional quantity splits only that line in the database transaction. */
  actOnItem(context: ReturnContext | undefined, returnId: string, returnItemId: string, body: JsonObject): Promise<JsonObject>;
  recordContact(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<unknown>;
  /** Records a COD refund with an actor-owned private transfer proof after line receipt. */
  recordManualRefund(context: ReturnContext | undefined, returnId:string, body:JsonObject):Promise<JsonObject>;
  /** CSKH asks the customer to supplement the COD receiving account; the refund stays blocked and the stage unchanged. */
  requestRefundInfo(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  triggerStripeRefund(context: ReturnContext | undefined, returnId: string, body?: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level decisions; use actOnItem. */
  reject(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level stage changes; use actOnItem. */
  updateReturnStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level labels; item pickup owns shipment facts. */
  createReturnShipment(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level pickup; use actOnItem. */
  confirmReturnPickup(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level carrier progression; use actOnItem. */
  updateReturnShipmentStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Refuses obsolete request-level exchange shipping; use actOnItem. */
  shipExchange(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Stores one admin evidence file (pickup/QA/refund proof) in the private bucket. */
  addReturnEvidence(context: ReturnContext | undefined, returnId: string, kind: string, note: string, req: HttpRequest): Promise<JsonObject>;
  listTickets(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  getTicket(context: ReturnContext | undefined, ticketId: string): Promise<JsonObject>;
  assignTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  respondTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  closeTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  resolveTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  listAuditLogs(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
}

/**
 * Build the admin return / support service around a PostgREST repository and optional payment refund gateway.
 */
export function createReturnService({
  repository,
  refunds
}: {
  repository: ReturnRepository;
  refunds?: ReturnRefundGateway;
}): ReturnService {
  /** Linked chatbot cases use exclusive ownership, filtered replies and audited lifecycle actions. */
  async function requireStandaloneTicket(
    context: ReturnContext & { authUser: AuthUser },
    ticketId: string
  ): Promise<JsonObject> {
    const ticket = await repository.getTicket(ticketId, context.accessToken);
    if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Không tìm thấy phiếu hỗ trợ");
    if (ticket.chat_session_id) {
      throw new HttpError(409, "CHAT_TICKET_GOVERNED", "Mở hội thoại để xử lý phiếu chatbot qua nội dung đã lọc");
    }
    return ticket;
  }

  /**
   * Chặn bước chuyển trạng thái phiếu hỗ trợ không có trong `SUPPORT_TICKET_TRANSITIONS`.
   *
   * Bảng chuyển trạng thái này được khai báo từ đầu nhưng chưa nơi nào đọc, nên mọi
   * endpoint đều ghi thẳng trạng thái mới bất kể phiếu đang ở đâu.
   */
  async function requireTicketTransition(
    context: ReturnContext & { authUser: AuthUser },
    ticketId: string,
    target: string
  ): Promise<void> {
    const ticket = await requireStandaloneTicket(context, ticketId);
    const from = asString(ticket.status);
    // Ghi lại chính trạng thái đang có không phải là bước chuyển, luôn hợp lệ.
    if (from === target) return;
    const allowed = SUPPORT_TICKET_TRANSITIONS[from] || [];
    if (!allowed.includes(target)) {
      throw new HttpError(422, "INVALID_TRANSITION", `Không thể chuyển phiếu từ "${from}" sang "${target}"`, {
        status: [`Từ "${from}" chỉ được chuyển sang: ${allowed.join(", ") || "không trạng thái nào"}`]
      });
    }
  }

  function requireReturnAdmin(context: ReturnContext | undefined): asserts context is ReturnContext & { authUser: AuthUser } {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!RETURN_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only CSKH operator or super admin can manage returns");
    }
  }

  function requireReturnReader(context: ReturnContext | undefined): asserts context is ReturnContext & { authUser: AuthUser } {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!RETURN_READER_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view returns");
    }
  }

  async function requireRefundItem(context: ReturnContext & { authUser: AuthUser }, returnId: string, body: JsonObject) {
    const returnItemId = asString(body.returnItemId).trim();
    if (!returnItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "Chọn phần hàng cần hoàn tiền.");
    const version = requireExpectedVersion(body.expectedVersion);
    const current = await repository.getReturn(returnId, context.accessToken);
    if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Không tìm thấy yêu cầu đổi/trả.");
    const { rows } = await repository.listReturnLines(returnId, context.accessToken);
    const item = rows.find(row => row.return_item_id === returnItemId);
    if (!item) throw new HttpError(404, "RETURN_ITEM_NOT_FOUND", "Phần hàng không thuộc yêu cầu đổi/trả.");
    if (version !== Number(item.version)) throw new HttpError(409, "VERSION_CONFLICT", "Phần hàng đã thay đổi. Vui lòng tải lại trang.");
    if (item.resolution_type !== "refund" || item.decision_status !== "approved") {
      throw new HttpError(422, "REFUND_RESOLUTION_REQUIRED", "Phần hàng phải được duyệt hoàn tiền.");
    }
    if (!["RECEIVED", "REFUND_PENDING"].includes(asString(item.item_status)) ||
        Number(item.received_quantity) !== Number(item.quantity) ||
        !["matches_product", "tags_intact", "condition_acceptable", "package_match"].every(key => item[key] === true)) {
      throw new HttpError(422, "WAREHOUSE_QA_REQUIRED", "Phần hàng phải được nhận và kiểm tra trước khi hoàn tiền.");
    }
    return { current, item, returnItemId, version };
  }

  return {
    async listReturns(context, searchParams) {
      requireReturnReader(context);
      const paymentKindParam = searchParams.get("payment_kind");
      if (paymentKindParam && paymentKindParam !== "cod" && paymentKindParam !== "online") {
        throw new HttpError(422, "VALIDATION_ERROR", "Bộ lọc thanh toán chỉ nhận cod hoặc online.");
      }
      const paymentKind = paymentKindParam === "cod" || paymentKindParam === "online" ? paymentKindParam : undefined;
      const result = await repository.listReturns({
        status: searchParams.get("status") || undefined,
        search: searchParams.get("q") || undefined,
        orderId: searchParams.get("order_id") || undefined,
        paymentKind,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
      return RETURN_OPERATOR_ROLES.includes(context.roleCode) ? result : { ...result, rows: result.rows.map(maskBankFields) };
    },

    async getReturn(context, returnId) {
      requireReturnReader(context);
      const ret = await repository.getReturn(returnId, context.accessToken);
      if (!ret) throw new HttpError(404, "RETURN_NOT_FOUND", "Return not found");
      // Kèm giá trị hoàn được để form duyệt hoàn tiền điền sẵn đúng số, không bắt gõ tay.
      // Các phép đọc độc lập chạy song song; mỗi phép là một PostgREST round-trip.
      const [refundableAmount, payment, lines, shipments, events, evidence] = await Promise.all([
        repository.getRefundableAmount(returnId, context.accessToken),
        ret.order_id && repository.getPaymentByOrderId
          ? repository.getPaymentByOrderId(asString(ret.order_id), context.accessToken)
          : Promise.resolve(null),
        repository.listReturnLines(returnId, context.accessToken),
        repository.listReturnShipments ? repository.listReturnShipments(returnId).catch(() => []) : Promise.resolve([]),
        repository.listReturnEvents ? repository.listReturnEvents(returnId).catch(() => []) : Promise.resolve([]),
        listReturnEvidence(returnId).catch(() => [])
      ]);
      // COD vs Stripe decides the whole refund screen: receiving account + manual transfer, or the automatic gateway refund.
      const kind = classifyReturnPayment(ret.payment_method ?? payment?.payment_method, payment?.payment_provider);
      const flow = refundFlowFor(lines.rows.some(line => line.resolution_type === "refund") ? "refund" : ret.return_type, kind);
      const receiverRequired = flow === "cod_manual";
      const [receiver, manualRefund, exchangeOrder] = await Promise.all([
        receiverRequired ? repository.getRefundReceiver(returnId) : Promise.resolve(null),
        flow === "cod_manual" || flow === "manual_transfer" ? repository.getManualRefund(returnId) : Promise.resolve(null),
        ret.exchange_order_id && repository.getExchangeOrder
          ? repository.getExchangeOrder(asString(ret.exchange_order_id))
          : Promise.resolve(null)
      ]);
      const orderItemIds = lines.rows.map(line => asString(line.order_item_id)).filter(Boolean);
      const productMetaMap: Record<string, JsonObject> = repository.getOrderItemProductMeta
        ? await repository.getOrderItemProductMeta(orderItemIds, context.accessToken).catch(() => ({}))
        : {};
      const enrichedLines = await Promise.all(lines.rows.map(async line => {
        const meta = productMetaMap[asString(line.order_item_id)] || {};
        return {
          ...line,
          product_id: meta.product_id || null,
          current_variant_id: meta.variant_id || null,
          product_name: meta.product_name || null,
          manual_refund: line.resolution_type === "refund" && kind === "cod" ? await repository.getManualRefund(returnId, asString(line.return_item_id)) : null,
          refundable_amount: await repository.getItemRefundableAmount(asString(line.return_item_id)),
          exchange_order: line.exchange_order_id ? await repository.getExchangeOrder(asString(line.exchange_order_id)) : null
        };
      }));
      const resolvedShipments: JsonObject[] = await Promise.all(shipments.map(async (row): Promise<JsonObject> => ({
        ...row,
        pickup_photo_urls: (await Promise.all(
          (Array.isArray(row.pickup_photo_urls) ? row.pickup_photo_urls : []).map((ref) => resolveEvidenceRef(ref))
        )).filter(Boolean),
        package_video_url: row.package_video_url ? await resolveEvidenceRef(row.package_video_url) : null
      })));
      const inbound = resolvedShipments.find((row) => row.direction === "inbound") || null;
      const outbound = resolvedShipments.find((row) => row.direction === "outbound") || null;
      const detail: JsonObject = {
        ...ret,
        refundable_amount: refundableAmount,
        payment,
        lines: enrichedLines,
        payment_kind: kind,
        refund_flow: flow,
        refund_receiver_status: refundReceiverStatus(receiverRequired, receiver),
        refund_receiver: adminRefundReceiver(receiverRequired, receiver),
        manual_refund: manualRefund,
        shipments: resolvedShipments,
        shipment: inbound,
        exchange_shipment: outbound,
        events,
        evidence: RETURN_OPERATOR_ROLES.includes(context.roleCode) ? evidence : evidence.filter(row => row.kind !== "refund_proof"),
        exchange_order: exchangeOrder
      };
      return RETURN_OPERATOR_ROLES.includes(context.roleCode) ? detail : maskBankFields(detail);
    },

    async actOnItem(context, returnId, returnItemId, body) {
      requireReturnAdmin(context);
      const action = asString(body.action);
      if (!ITEM_ACTIONS.includes(action)) throw new HttpError(422, "INVALID_ITEM_ACTION", "Thao tác phần hàng không hợp lệ.");
      if (["approve", "reject"].includes(action) && context.roleCode !== "super_admin") {
        throw new HttpError(403, "RBAC_DENIED", "Chỉ super admin được duyệt hoặc từ chối phần hàng.");
      }
      const expectedVersion = requireExpectedVersion(body.expectedVersion);
      if (!returnItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "Chọn phần hàng cần xử lý.");
      if (body.payload !== undefined) throw new HttpError(422, "FLAT_ITEM_FACTS_REQUIRED", "Gửi dữ kiện trực tiếp trong nội dung yêu cầu.");
      if (body.quantity !== undefined && (typeof body.quantity !== "number" || !Number.isInteger(body.quantity) || body.quantity < 1)) {
        throw new HttpError(422, "QTY_MISMATCH", "Số lượng xử lý phải là số nguyên dương.");
      }
      if (["approve", "reject", "needs_support", "resolve", "stop", "convert_refund", "change_variant"].includes(action) &&
          asString(body.reason).trim().length < 10) {
        throw new HttpError(422, "REASON_REQUIRED", "Ghi rõ lý do xử lý (ít nhất 10 ký tự).");
      }
      if (["convert_refund", "change_variant"].includes(action) && body.customerConsent !== true) {
        throw new HttpError(422, "CUSTOMER_CONSENT_REQUIRED", "Cần sự đồng ý của khách hàng.");
      }
      if (["pickup", "ship_exchange"].includes(action) &&
          (!asString(body.carrier).trim() || !asString(body.trackingNumber).trim())) {
        throw new HttpError(422, "TRACKING_REQUIRED", "Ghi nhận đơn vị vận chuyển và mã vận đơn.");
      }
      if (action === "pickup") {
        const pickedUpAt = asString(body.pickedUpAt);
        const pickupTime = Date.parse(pickedUpAt);
        if (!asString(body.pickedUpBy).trim() || !/^\d{4}-\d{2}-\d{2}T/.test(pickedUpAt) ||
            !Number.isFinite(pickupTime) || pickupTime > Date.now()) {
          throw new HttpError(422, "PICKUP_FACTS_REQUIRED", "Ghi nhận người nhận bàn giao và thời điểm lấy hàng hợp lệ trong quá khứ.");
        }
        if (!Array.isArray(body.photoUrls) || !body.photoUrls.length || !body.photoUrls.every(isPrivateEvidenceRef) ||
            (body.videoUrl !== undefined && body.videoUrl !== "" && !isPrivateEvidenceRef(body.videoUrl))) {
          throw new HttpError(422, "PICKUP_PROOF_REQUIRED", "Tải lên bằng chứng bàn giao riêng tư.");
        }
      }
      if (action === "receive") {
        if (!["matchesProduct", "tagsIntact", "conditionAcceptable", "packageMatch", "sealIntact"].every(key => typeof body[key] === "boolean")) {
          throw new HttpError(422, "RECEIPT_FACTS_REQUIRED", "Ghi nhận đầy đủ kết quả kiểm hàng, kể cả khi không đạt.");
        }
        if (typeof body.receivedQuantity !== "number" || !Number.isInteger(body.receivedQuantity) || body.receivedQuantity < 1) {
          throw new HttpError(422, "QTY_MISMATCH", "Số lượng nhận phải là số nguyên dương.");
        }
        if (!["restock", "repair", "scrap", "return_supplier"].includes(asString(body.disposition))) {
          throw new HttpError(422, "RETURN_DISPOSITION_REQUIRED", "Chọn hướng xử lý phần hàng đã nhận.");
        }
        if (!isPrivateEvidenceRef(body.receiptProofRef)) throw new HttpError(422, "PROOF_REQUIRED", "Tải lên bằng chứng kiểm hàng riêng tư.");
      }
      const { action: _action, expectedVersion: _version, ...facts } = body;
      return repository.actOnItem(returnId, returnItemId, action, facts, expectedVersion,
        context.profile?.user_id || context.authUser.id, context.ipAddress);
    },
    async recordContact(context, returnId, body) {
      requireReturnAdmin(context);
      const result = asString(body.result);
      const note = asString(body.note);
      const allowed = ["reached", "no_answer", "waiting_customer"];
      if (!allowed.includes(result)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Kết quả liên hệ không hợp lệ.");
      }
      if (note.length < 10) {
        throw new HttpError(422, "VALIDATION_ERROR", "Nội dung liên hệ phải có ít nhất 10 ký tự.");
      }
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.recordContact(returnId, {
        result,
        note,
        expectedVersion
      }, context.profile?.user_id || context.authUser.id, context.roleCode, context.ipAddress);
    },

    async triggerStripeRefund(context, returnId, body = {}) {
      requireReturnAdmin(context);
      const requestedItemId = asString(body.returnItemId).trim();
      if (!requestedItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "Chọn phần hàng cần hoàn tiền.");
      const priorOperation = await repository.getRefundOperation(requestedItemId);
      if (priorOperation && asString(priorOperation.status) === "succeeded" &&
          !asString(priorOperation.provider_ref).startsWith("manual:")) {
        return { success: true, return_item_id: requestedItemId, refund: { status: "refunded" }, idempotent: true };
      }
      const { current, returnItemId, version } = await requireRefundItem(context, returnId, body);
      const orderId = asString(current.order_id);
      if (!orderId) throw new HttpError(422, "MISSING_ORDER_ID", "Phiếu không có mã đơn hàng hợp lệ.");
      if (!refunds) throw new HttpError(503, "GATEWAY_UNAVAILABLE", "Cổng hoàn tiền Stripe chưa sẵn sàng.");
      const amount = await repository.getItemRefundableAmount(returnItemId);
      if (amount <= 0) throw new HttpError(422, "NOTHING_TO_REFUND", "Phần hàng không còn số dư để hoàn tiền.");
      const payment = await repository.getPaymentByOrderId(orderId, context.accessToken);
      if (payment?.payment_provider !== "stripe") throw new HttpError(422, "STRIPE_PAYMENT_REQUIRED", "Chỉ thanh toán Stripe được hoàn qua cổng Stripe.");
      const result = await refunds.refund(orderId, amount, returnId, version, returnItemId);
      if (result.status === "refunded") {
        void sendRefundSuccessEmail(returnId, { method: "stripe", returnItemId });
      } else if (result.status === "failed") {
        throw new HttpError(422, "STRIPE_REFUND_FAILED", result.message || "Hoàn tiền qua Stripe thất bại.");
      } else if (result.status === "skipped") {
        throw new HttpError(422, "STRIPE_PAYMENT_REQUIRED", result.message || "Không tìm thấy thanh toán Stripe hợp lệ.");
      }
      return { success: true, return_item_id: returnItemId, refund: result };
    },

    async recordManualRefund(context, returnId, body) {
      requireReturnAdmin(context);
      const requestedItemId = asString(body.returnItemId).trim();
      if (!requestedItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "Chọn phần hàng cần hoàn tiền.");
      const priorRefund = await repository.getManualRefund(returnId, requestedItemId);
      if (priorRefund) {
        const sameTransfer = asString(priorRefund.reference).trim().toUpperCase() === asString(body.transferReference).trim().toUpperCase();
        if (sameTransfer && Number(priorRefund.amount) === asNumber(body.amount)) {
          return { ...priorRefund, idempotent: true };
        }
        throw new HttpError(409, "REFUND_ALREADY_REQUESTED", "Phần hàng đã được ghi nhận hoàn tiền với giao dịch khác.");
      }
      const { current, returnItemId, version } = await requireRefundItem(context, returnId, body);
      const payment = await repository.getPaymentByOrderId(asString(current.order_id), context.accessToken);
      const orderPaymentMethod = await repository.getOrderPaymentMethod(asString(current.order_id));
      const paymentMethod = current.payment_method ?? payment?.payment_method ?? orderPaymentMethod;
      if (asString(paymentMethod).toUpperCase() !== "COD" ||
          classifyReturnPayment(paymentMethod, payment?.payment_provider) !== "cod") {
        throw new HttpError(422, "COD_PAYMENT_REQUIRED", "Chỉ đơn COD được ghi nhận chuyển khoản hoàn tiền.");
      }
      const receiverStatus = refundReceiverStatus(true, await repository.getRefundReceiver(returnId));
      if (receiverStatus !== "valid") throw new HttpError(422, "REFUND_RECEIVER_REQUIRED", "Cần thông tin nhận hoàn tiền hợp lệ.", { refund_receiver_status: receiverStatus });
      const reference = asString(body.transferReference).trim();
      const proof = asString(body.imageProof).trim();
      const amount = asNumber(body.amount);
      const transferredAt = new Date(asString(body.transferredAt));
      if (reference.length < 6) throw new HttpError(422, "TRANSFER_REFERENCE_REQUIRED", "Mã giao dịch phải có ít nhất 6 ký tự.");
      if (!isPrivateEvidenceRef(proof)) throw new HttpError(422, "TRANSFER_PROOF_REQUIRED", "Tải lên chứng từ chuyển khoản riêng tư.");
      if (amount <= 0) throw new HttpError(422, "REFUND_AMOUNT_MISMATCH", "Số tiền hoàn phải lớn hơn 0.");
      if (Number.isNaN(transferredAt.getTime()) || transferredAt.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new HttpError(422, "TRANSFER_TIME_INVALID", "Thời điểm chuyển tiền không hợp lệ.");
      }
      // The RPC owns proof ownership, COD capture, receiver snapshot and line completion atomically.
      const updated = await repository.recordManualRefund(returnId, version, {
        reference, amount, transferredAt: transferredAt.toISOString(), proof, note: asString(body.adminNote).trim() || undefined
      }, context.profile?.user_id || context.authUser.id, context.ipAddress, returnItemId);
      void sendRefundSuccessEmail(returnId, { method: "manual", reference, returnItemId });
      return updated;
    },

    async requestRefundInfo(context, returnId, body) {
      requireReturnAdmin(context);
      const message = asString(body.message).trim();
      if (message.length < 10) throw new HttpError(422, "SUPPLEMENT_MESSAGE_REQUIRED", "Nội dung yêu cầu bổ sung phải có ít nhất 10 ký tự.");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      const current = await repository.getReturn(returnId, context.accessToken);
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Không tìm thấy yêu cầu đổi/trả tương ứng");
      if (Number(current.version) !== expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Dữ liệu yêu cầu đổi/trả đã bị thay đổi bởi thao tác khác. Vui lòng tải lại trang.");
      if (REFUND_RECEIVER_CLOSED_STATUSES.includes(asString(current.status))) throw new HttpError(422, "RETURN_CLOSED", "Yêu cầu đổi/trả đã kết thúc, không thể yêu cầu bổ sung thông tin nhận hoàn tiền.");
      const payment = current.order_id ? await repository.getPaymentByOrderId(asString(current.order_id), context.accessToken) : null;
      const kind = classifyReturnPayment(current.payment_method ?? payment?.payment_method, payment?.payment_provider);
      const hasRefundLine = current.return_type === "refund" ||
        (await repository.listReturnLines(returnId, context.accessToken)).rows.some(line => line.resolution_type === "refund");
      if (refundFlowFor(hasRefundLine ? "refund" : "exchange", kind) !== "cod_manual") {
        throw new HttpError(422, "REFUND_RECEIVER_NOT_APPLICABLE", "Chỉ đơn COD có yêu cầu hoàn tiền mới cần thông tin nhận tiền.");
      }
      const saved = await repository.requestRefundReceiverSupplement(returnId, expectedVersion, message, context.profile?.user_id || context.authUser.id);
      return { return_id: returnId, refund_receiver: adminRefundReceiver(true, { ...(await repository.getRefundReceiver(returnId)), supplement_request: saved.supplement_request, supplement_requested_at: saved.supplement_requested_at }) };
    },
    async reject(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async updateReturnStatus(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async createReturnShipment(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async confirmReturnPickup(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async updateReturnShipmentStatus(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async shipExchange(context, _returnId, _body) {
      requireReturnAdmin(context);
      throw itemActionRequired();
    },

    async addReturnEvidence(context, returnId, kind, note, req) {
      requireReturnAdmin(context);
      const current = await repository.getReturn(returnId, context.accessToken);
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Không tìm thấy phiếu đổi trả.");
      return storeReturnEvidence({
        returnId,
        kind: kind as ReturnEvidenceKind,
        role: "admin",
        actorId: context.profile?.user_id || context.authUser.id,
        note: note || null,
        req
      });
    },

    async listTickets(context, searchParams) {
      requireReturnReader(context);
      const userId = searchParams.get("user_id") || "";
      return repository.listTickets({
        status: searchParams.get("status") || undefined,
        search: searchParams.get("q")?.trim() || undefined,
        // Chỉ nhận uuid: giá trị tự do sẽ lọt vào bộ lọc PostgREST dưới dạng chuỗi so khớp.
        userId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ? userId : undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async getTicket(context, ticketId) {
      requireReturnReader(context);
      const ticket = await repository.getTicket(ticketId, context.accessToken);
      if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      return ticket;
    },

    async assignTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const assignedTo = asString(body.assignedTo);
      if (!assignedTo) throw new HttpError(422, "VALIDATION_ERROR", "assignedTo required");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      await requireStandaloneTicket(context, ticketId);
      return repository.assignTicket(ticketId, { assignedTo, expectedVersion }, context.accessToken);
    },

    async respondTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const response = asString(body.response);
      if (response.length < 1) throw new HttpError(422, "VALIDATION_ERROR", "Response content required");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      // RPC phản hồi đặt phiếu về `processing`. Trên phiếu đã `resolved` thì đó là bước
      // lùi không có trong máy trạng thái: phiếu đã giải quyết bỗng quay lại đang xử lý.
      await requireTicketTransition(context, ticketId, "processing");
      return repository.respondTicket(ticketId, { response, expectedVersion }, context.accessToken);
    },

    async closeTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      await requireTicketTransition(context, ticketId, "closed");
      return repository.closeTicket(ticketId, { reason: body.reason, expectedVersion }, context.accessToken);
    },

    async resolveTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      // `resolved` có trong máy trạng thái và có nhãn trên giao diện nhưng trước đây
      // không đường nào ghi được, nên "Đã giải quyết" là nhãn chết và CSKH chỉ còn cách
      // đóng thẳng phiếu. Đây là đường vào của trạng thái đó.
      await requireTicketTransition(context, ticketId, "resolved");
      return repository.updateTicketStatus(
        ticketId,
        { status: "resolved", adminNote: asString(body.adminNote), expectedVersion },
        context.accessToken
      );
    },

    async listAuditLogs(context, searchParams) {
      requireReturnReader(context);
      const payload = await repository.listAuditLogs({
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: Math.max(parseInt(searchParams.get("offset") || "0"), 0),
        targetId: searchParams.get("targetId") || undefined
      }, context.accessToken);
      return enrichAuditLogs(payload, RETURN_AUDIT);
    }
  };
}

const ITEM_ACTIONS: readonly string[] = [
  "approve", "reject", "wait_return", "pickup", "receive", "needs_support", "resolve", "stop",
  "convert_refund", "change_variant", "prepare_exchange", "ship_exchange", "complete_exchange"
];

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion phải là phiên bản nguyên của phần hàng.");
  }
  return value;
}

function isPrivateEvidenceRef(value: unknown): boolean {
  return /^storage:\/\/[^/]+\/returns\/[^/]+\/.+/.test(asString(value));
}

function itemActionRequired(): HttpError {
  return new HttpError(409, "ITEM_ACTION_REQUIRED", "Xử lý từng phần hàng qua thao tác phần hàng, không chuyển trạng thái cả phiếu.");
}

/** Removes receiving-bank fields from every legacy header, event and manual-refund snapshot for order readers. */
function maskBankFields(row: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (/bank|account_number|account_holder|account_name|account_no|^proof$|transfer_proof|refund_proof/i.test(key)) return [key, null];
    if (Array.isArray(value)) return [key, value.map(entry => entry && typeof entry === "object" ? maskBankFields(asJsonObject(entry)) : entry)];
    if (value && typeof value === "object") return [key, maskBankFields(asJsonObject(value))];
    return [key, value];
  }));
}
