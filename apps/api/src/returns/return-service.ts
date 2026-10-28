import { enrichAuditLogs, RETURN_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, HttpRequest, JsonObject, RequestMeta } from "../types.js";
import { asJsonObject, asNumber, asString, errorMessage } from "../types.js";
import {
  RETURN_OPERATOR_ROLES,
  RETURN_QA_PASS,
  RETURN_READER_ROLES,
  RETURN_STATUSES,
  RETURN_TRANSITIONS,
  SUPPORT_TICKET_TRANSITIONS
} from "./return-constants.js";
import {
  sendRefundSuccessEmail,
  sendExchangeShippingEmail,
  sendExchangeCompletedEmail
} from "./return-email.js";
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
  refund(orderId: string, amount?: number, returnId?: string, expectedVersion?: number): Promise<{ status: "refunded" | "requested" | "failed" | "skipped"; message?: string }>;
}

/**
 * Admin return / support use-cases consumed by `handleReturnRoute`.
 */
export interface ReturnService {
  listReturns(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  getReturn(context: ReturnContext | undefined, returnId: string): Promise<JsonObject>;
  recordContact(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<unknown>;
  /** Records non-Stripe refund only with transfer proof after warehouse QA. */
  recordManualRefund(context: ReturnContext | undefined, returnId:string, body:JsonObject):Promise<JsonObject>;
  /** CSKH asks the customer to supplement the COD receiving account; the refund stays blocked and the stage unchanged. */
  requestRefundInfo(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  triggerStripeRefund(context: ReturnContext | undefined, returnId: string, body?: JsonObject): Promise<JsonObject>;
  reject(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  updateReturnStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Creates the inbound carrier label the customer will attach to the parcel. */
  createReturnShipment(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Records carrier pickup photos/video and moves the return to RETURN_IN_TRANSIT. */
  confirmReturnPickup(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Records an inbound carrier status update without receiving goods. */
  updateReturnShipmentStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Ships the linked replacement order and moves the return to EXCHANGE_SHIPPING. */
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

  return {
    async listReturns(context, searchParams) {
      requireReturnReader(context);
      const paymentKindParam = searchParams.get("payment_kind");
      if (paymentKindParam && paymentKindParam !== "cod" && paymentKindParam !== "online") {
        throw new HttpError(422, "VALIDATION_ERROR", "Bộ lọc thanh toán chỉ nhận cod hoặc online.");
      }
      const paymentKind = paymentKindParam === "cod" || paymentKindParam === "online" ? paymentKindParam : undefined;
      return repository.listReturns({
        status: searchParams.get("status") || undefined,
        search: searchParams.get("q") || undefined,
        orderId: searchParams.get("order_id") || undefined,
        paymentKind,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
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
      const flow = refundFlowFor(ret.return_type, kind);
      const receiverRequired = flow === "cod_manual";
      const [receiver, manualRefund, exchangeOrder] = await Promise.all([
        receiverRequired ? repository.getRefundReceiver(returnId) : Promise.resolve(null),
        flow === "cod_manual" || flow === "manual_transfer" ? repository.getManualRefund(returnId) : Promise.resolve(null),
        ret.exchange_order_id && repository.getExchangeOrder
          ? repository.getExchangeOrder(asString(ret.exchange_order_id))
          : Promise.resolve(null)
      ]);
      const resolvedShipments: JsonObject[] = await Promise.all(shipments.map(async (row): Promise<JsonObject> => ({
        ...row,
        pickup_photo_urls: (await Promise.all(
          (Array.isArray(row.pickup_photo_urls) ? row.pickup_photo_urls : []).map((ref) => resolveEvidenceRef(ref))
        )).filter(Boolean),
        package_video_url: row.package_video_url ? await resolveEvidenceRef(row.package_video_url) : null
      })));
      const inbound = resolvedShipments.find((row) => row.direction === "inbound") || null;
      const outbound = resolvedShipments.find((row) => row.direction === "outbound") || null;
      return {
        ...ret,
        refundable_amount: refundableAmount,
        payment,
        lines: lines.rows,
        payment_kind: kind,
        refund_flow: flow,
        refund_receiver_status: refundReceiverStatus(receiverRequired, receiver),
        refund_receiver: adminRefundReceiver(receiverRequired, receiver),
        manual_refund: manualRefund,
        shipments: resolvedShipments,
        shipment: inbound,
        exchange_shipment: outbound,
        events,
        evidence,
        exchange_order: exchangeOrder
      };
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
      const labels: Record<string, string> = {
        reached: "Liên hệ được",
        no_answer: "Không liên hệ được",
        waiting_customer: "Chờ khách bổ sung"
      };
      return repository.recordContact(returnId, {
        result: labels[result],
        note,
        expectedVersion
      }, context.profile?.user_id || context.authUser.id, context.roleCode, context.ipAddress);
    },

    async triggerStripeRefund(context, returnId, body = {}) {
      requireReturnAdmin(context);
      const current = await repository.getReturn(returnId, context.accessToken);
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Phiếu đổi trả không tồn tại");
      const orderId = asString(current.order_id);
      if (!orderId) throw new HttpError(422, "MISSING_ORDER_ID", "Phiếu không có mã đơn hàng hợp lệ");
      if (!refunds) throw new HttpError(503, "GATEWAY_UNAVAILABLE", "Cổng hoàn tiền Stripe chưa sẵn sàng");
      const version = body.expectedVersion != null ? asNumber(body.expectedVersion) : Number(current.version);
      if (!Number.isInteger(version) || version !== Number(current.version)) throw new HttpError(409,"VERSION_CONFLICT","Dữ liệu yêu cầu đổi/trả đã bị thay đổi bởi thao tác khác. Vui lòng tải lại trang.");
      if (!["RECEIVED","REFUND_PROCESSING"].includes(asString(current.status)) || current.condition_check_result !== RETURN_QA_PASS || current.return_type === "exchange") throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Hàng hoàn trả phải được kho tiếp nhận và kiểm tra đạt yêu cầu (QA Pass) trước khi hoàn tiền.");
      const amount = await repository.getRefundableAmount(returnId, context.accessToken);
      if (amount <= 0) throw new HttpError(422,"NOTHING_TO_REFUND","Đơn hàng không có số dư hợp lệ để thực hiện hoàn tiền.");
      const payment = await repository.getPaymentByOrderId(orderId,context.accessToken);
      if (payment?.payment_provider !== "stripe") throw new HttpError(422,"STRIPE_PAYMENT_REQUIRED","Chỉ đơn hàng thanh toán qua Stripe mới có thể hoàn tiền trực tuyến qua Stripe. Đơn hàng hiện tại vui lòng dùng tính năng Ghi nhận chuyển khoản hoàn tiền.");
      const result = await refunds.refund(orderId, amount, returnId, version);
      if (result.status === "refunded") {
        void sendRefundSuccessEmail(returnId, { method: "stripe" });
      } else if (result.status === "failed") {
        throw new HttpError(422, "STRIPE_REFUND_FAILED", result.message || "Hoàn tiền qua Stripe thất bại. Vui lòng kiểm tra lại giao dịch thanh toán trên Stripe.");
      } else if (result.status === "skipped") {
        throw new HttpError(422, "STRIPE_PAYMENT_REQUIRED", result.message || "Không tìm thấy giao dịch thanh toán Stripe hợp lệ để hoàn tiền.");
      }
      return { success: true, refund: result };
    },

    async recordManualRefund(context,returnId,body) {
      requireReturnAdmin(context);
      const current = await repository.getReturn(returnId,context.accessToken);
      if (!current) throw new HttpError(404,"RETURN_NOT_FOUND","Không tìm thấy yêu cầu đổi/trả tương ứng");
      if (Number(body.expectedVersion) !== Number(current.version)) throw new HttpError(409,"VERSION_CONFLICT","Dữ liệu yêu cầu đổi/trả đã bị thay đổi bởi thao tác khác. Vui lòng tải lại trang.");
      if (!["RECEIVED","REFUND_PROCESSING"].includes(asString(current.status)) || current.condition_check_result !== RETURN_QA_PASS) throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Hàng hoàn trả phải được kho tiếp nhận và kiểm tra đạt yêu cầu (QA Pass) trước khi ghi nhận hoàn tiền.");
      const orderId = asString(current.order_id);
      const payment = await repository.getPaymentByOrderId(orderId,context.accessToken);
      const pendingCod = Boolean(
        payment &&
        asString(payment.payment_status) === "pending" &&
        asString(payment.payment_method).toUpperCase() === "COD"
      );

      if (!payment || payment.payment_provider === "stripe" || (!pendingCod && !["paid","refund_pending"].includes(asString(payment.payment_status)))) throw new HttpError(422,"CAPTURED_NON_STRIPE_REQUIRED","Chỉ áp dụng ghi nhận chuyển khoản cho đơn hàng thanh toán ngoài Stripe (COD, MoMo, VNPay) đã thanh toán thành công.");

      // COD: the refund is a manual transfer to the customer's own account, so it cannot continue while that account
      // is empty, invalid or CSKH is still waiting for a supplement. The same rule is enforced again by the database.
      if (classifyReturnPayment(current.payment_method ?? payment.payment_method, payment.payment_provider) === "cod") {
        const receiverStatus = refundReceiverStatus(true, await repository.getRefundReceiver(returnId));
        if (receiverStatus !== "valid") {
          throw new HttpError(422, "REFUND_RECEIVER_REQUIRED", "Chưa có thông tin nhận hoàn tiền hợp lệ của khách. Hãy yêu cầu khách bổ sung trước khi tiếp tục hoàn tiền.", { refund_receiver_status: receiverStatus });
        }
      }

      const reference = asString(body.transferReference).trim();
      const proof = asString(body.imageProof);
      const adminNote = asString(body.adminNote).trim();
      const amount = asNumber(body.amount);
      const transferredAt = new Date(asString(body.transferredAt));
      if (reference.length < 6) throw new HttpError(422,"TRANSFER_REFERENCE_REQUIRED","Mã giao dịch chuyển tiền phải có ít nhất 6 ký tự.");
      if (!proof.startsWith("https://") && !proof.startsWith("data:image/") && !proof.startsWith("http://")) throw new HttpError(422,"TRANSFER_PROOF_REQUIRED","Vui lòng tải lên ảnh chụp chứng từ chuyển khoản thành công.");
      if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(422,"REFUND_AMOUNT_MISMATCH","Số tiền đã chuyển phải lớn hơn 0 và khớp số tiền hoàn của hàng đã nhận.");
      if (Number.isNaN(transferredAt.getTime()) || transferredAt.getTime() > Date.now() + 5 * 60 * 1000) throw new HttpError(422,"TRANSFER_TIME_INVALID","Thời điểm chuyển tiền không hợp lệ: không được để trống hoặc ở tương lai.");

      // Only now that every refund fact is valid do we sync the stale COD capture; a rejected
      // refund must not leave the order marked paid as a side effect.
      if (pendingCod) {
        await repository.markPaymentPaid(asString(payment.payment_id));
      }

      const updated = await repository.recordManualRefund(
        returnId,
        Number(body.expectedVersion),
        { reference, amount, transferredAt: transferredAt.toISOString(), proof, note: adminNote || undefined },
        context.profile?.user_id || context.authUser.id
      );
      void sendRefundSuccessEmail(returnId, { method: "manual", reference });
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
      if (refundFlowFor(current.return_type, kind) !== "cod_manual") {
        throw new HttpError(422, "REFUND_RECEIVER_NOT_APPLICABLE", "Chỉ đơn COD có yêu cầu hoàn tiền mới cần thông tin nhận tiền.");
      }
      const saved = await repository.requestRefundReceiverSupplement(returnId, expectedVersion, message, context.profile?.user_id || context.authUser.id);
      return { return_id: returnId, refund_receiver: adminRefundReceiver(true, { ...(await repository.getRefundReceiver(returnId)), supplement_request: saved.supplement_request, supplement_requested_at: saved.supplement_requested_at }) };
    },
    async reject(context, returnId, body) {
      requireReturnAdmin(context);
      const reason = asString(body.reason);
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.reject(
        returnId,
        { reason, imageProof: body.imageProof, expectedVersion },
        context.profile?.user_id || context.authUser.id,
        context.roleCode,
        context.ipAddress
      );
    },

    async updateReturnStatus(context, returnId, body) {
      requireReturnAdmin(context);
      const status = asString(body.status);
      if (!RETURN_STATUSES.some(code => code === status)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid return status");
      }
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) {
        throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      }

      // `RETURN_TRANSITIONS` khai báo từ đầu nhưng chưa nơi nào đọc, nên endpoint này
      // cho phép nhảy thẳng từ `pending` sang `completed`, bỏ qua cả bước nhận hàng và
      // kiểm tra tình trạng. Chốt tính hợp lệ của bước chuyển ngay tại đây.
      const currentReturn = await repository.getReturn(returnId, context.accessToken);
      if (!currentReturn) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return not found");
      }
      if (Number(currentReturn.version) !== expectedVersion) throw new HttpError(409,"VERSION_CONFLICT","Return changed");
      const from = asString(currentReturn.status);
      const allowed = RETURN_TRANSITIONS[from] || [];
      if (!allowed.includes(status)) {
        throw new HttpError(422, "INVALID_TRANSITION", `Không thể chuyển phiếu từ "${from}" sang "${status}"`, {
          status: [`Từ "${from}" chỉ được chuyển sang: ${allowed.join(", ") || "không trạng thái nào"}`]
        });
      }
      if (status === "NEEDS_SUPPORT" && (!asString(body.imageProof) || asString(body.reason).trim().length < 10)) throw new HttpError(422,"QA_FAILURE_EVIDENCE_REQUIRED","Evidence image and reason are required for QA failure");
      if (status === "CANCELLED" && asString(body.reason).trim().length < 10) throw new HttpError(422,"CANCEL_REASON_REQUIRED","Phải ghi rõ lý do (ít nhất 10 ký tự) khi từ chối hoặc hủy yêu cầu để khách hàng được thông báo.");
      if (status === "RECEIVED") {
        const qa = asString(body.conditionCheckResult);
        const proof = asString(body.imageProof);
        if (qa !== RETURN_QA_PASS) {
          throw new HttpError(422, "QA_REQUIRED", "Nhận hàng hoàn trả thành công chỉ khi xác nhận đúng hàng của shop.");
        }
        if (body.packageMatch !== true || body.sealIntact !== true) {
          throw new HttpError(422, "PACKAGE_CHAIN_REQUIRED", "Phải xác nhận niêm phong nguyên vẹn và kiện hàng khớp với bằng chứng khách/ĐVVC gửi.");
        }
        if (!proof.startsWith("data:image/") && !proof.startsWith("http://") && !proof.startsWith("https://")) {
          throw new HttpError(422, "PROOF_REQUIRED", "Phải tải ảnh minh chứng đã kiểm hàng.");
        }
        const lines = await repository.listReturnLines(returnId, context.accessToken);
        // Every returned line must arrive with its own disposition. A single-line shortcut would
        // reach the loop without `disposition` and always fail, so the request must carry `items`.
        const receipts = Array.isArray(body.items) ? body.items.map(asJsonObject) : [];
        if (!lines.rows.length || receipts.length !== lines.rows.length || new Set(receipts.map(row => asString(row.orderItemId))).size !== lines.rows.length) throw new HttpError(422,"ITEM_ID_MISMATCH","Confirm every returned line exactly once");
        for (const line of lines.rows) {
          const receipt = receipts.find(row => row.orderItemId === line.order_item_id);
          if (!receipt || receipt.matchesProduct !== true) throw new HttpError(422,"ITEM_ID_MISMATCH","Returned product does not match");
          const qty = Number(receipt.receivedQuantity);
          if (!Number.isInteger(qty) || qty < 1 || qty !== Number(line.quantity)) throw new HttpError(422,"QTY_MISMATCH","Received quantity does not match the registered line");
          if (!["restock","repair","scrap","return_supplier"].includes(asString(receipt.disposition))) {
            throw new HttpError(422, "RETURN_DISPOSITION_REQUIRED", "Mỗi dòng hàng phải chọn hướng xử lý (nhập lại kho, sửa chữa, hủy hoặc trả NCC).");
          }
        }
        return repository.receiveReturn(returnId, expectedVersion, {
          receipts,
          packageMatch: true,
          sealIntact: true,
          warehouseProof: proof,
          qaNote: asString(body.qaNote) || undefined
        }, context.profile?.user_id || context.authUser.id);
      }
      if (["REFUND_PROCESSING","REFUNDED"].includes(status)) throw new HttpError(422,"GATEWAY_STATE_REQUIRED","Refund states are advanced by payment gateway evidence");
      let refundAmount = body.refundAmount ? asNumber(body.refundAmount) : undefined;
      if (status === "COMPLETED" && currentReturn.return_type === "refund" && from !== "REFUNDED") throw new HttpError(422,"REFUND_REQUIRED","Gateway must confirm the refund before completion");
      if (["RETURN_IN_TRANSIT","EXCHANGE_SHIPPING"].includes(status) && !asString(body.trackingReturnCode)) throw new HttpError(422,"TRACKING_REQUIRED","Shipment tracking is required");
      if (status === "EXCHANGE_PREPARING") {
        if (currentReturn.return_type !== "exchange" || currentReturn.condition_check_result !== RETURN_QA_PASS) throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Exchange requires warehouse QA");
        return repository.prepareExchange(returnId,expectedVersion,context.profile?.user_id || context.authUser.id);
      }
      if (status === "COMPLETED" && currentReturn.return_type === "exchange") {
        if (from !== "EXCHANGE_SHIPPING") throw new HttpError(422, "INVALID_TRANSITION", "Chỉ hoàn tất đổi hàng sau khi hàng đổi đã giao.");
        const completed = await repository.completeExchange(
          returnId,
          expectedVersion,
          context.profile?.user_id || context.authUser.id
        );
        void sendExchangeCompletedEmail(returnId);
        return completed;
      }

      const adminNote = body.adminNote;
      const reason = body.reason;
      const trackingReturnCode = body.trackingReturnCode;
      const conditionCheckResult = body.conditionCheckResult;
      const imageProof = body.imageProof;

      const updated = await repository.updateReturnStatus(returnId, {
        status,
        adminNote,
        reason,
        refundAmount,
        trackingReturnCode,
        conditionCheckResult,
        packageMatch: status === "RECEIVED" ? body.packageMatch === true : undefined,
        sealIntact: status === "RECEIVED" ? body.sealIntact === true : undefined,
        qaNote: status === "RECEIVED" ? body.qaNote : undefined,
        imageProof,
        receipts: status === "RECEIVED" ? body.items : undefined,
        expectedVersion
      }, context.profile?.user_id || context.authUser.id, context.roleCode, context.ipAddress);

      if (status === "EXCHANGE_SHIPPING") {
        void sendExchangeShippingEmail(returnId, asString(trackingReturnCode) || undefined);
      }

      if (status === "COMPLETED") {
        if (currentReturn.return_type === "refund") {
          void sendRefundSuccessEmail(returnId, { method: "completed" });
        } else if (currentReturn.return_type === "exchange") {
          void sendExchangeCompletedEmail(returnId);
        }
      }

      return updated;
    },

    async createReturnShipment(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      const carrier = asString(body.carrier).trim();
      const trackingCode = asString(body.trackingCode).trim();
      if (carrier.length < 2) throw new HttpError(422, "CARRIER_REQUIRED", "Chọn đơn vị vận chuyển cho chiều hoàn.");
      if (trackingCode.length < 6) throw new HttpError(422, "TRACKING_REQUIRED", "Mã vận đơn hoàn phải có ít nhất 6 ký tự.");
      return repository.createReturnShipment(returnId, expectedVersion, {
        carrier,
        trackingCode,
        trackingUrl: asString(body.trackingUrl).trim() || undefined,
        labelUrl: asString(body.labelUrl).trim() || undefined
      }, context.profile?.user_id || context.authUser.id);
    },

    async confirmReturnPickup(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      const photoUrls = (Array.isArray(body.photoUrls) ? body.photoUrls : [])
        .map((value) => asString(value).trim())
        .filter((value) => value.startsWith("https://") || value.startsWith("http://") || value.startsWith("storage://"));
      if (!photoUrls.length) throw new HttpError(422, "PICKUP_PHOTO_REQUIRED", "Cần ít nhất một ảnh ĐVVC lấy hàng/niêm phong.");
      const videoUrl = asString(body.videoUrl).trim();
      return repository.confirmReturnPickup(returnId, expectedVersion, {
        photoUrls,
        videoUrl: videoUrl || undefined,
        note: asString(body.note).trim() || undefined
      }, context.profile?.user_id || context.authUser.id);
    },

    async updateReturnShipmentStatus(context, returnId, body) {
      requireReturnAdmin(context);
      const status = asString(body.status).trim();
      if (!["in_transit", "delivered", "failed"].includes(status)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Trạng thái vận đơn không hợp lệ.");
      }
      return repository.updateReturnShipmentStatus(
        returnId,
        status,
        asString(body.note).trim() || undefined,
        context.profile?.user_id || context.authUser.id
      );
    },

    async shipExchange(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      const carrier = asString(body.carrier).trim();
      const trackingCode = asString(body.trackingCode).trim();
      if (carrier.length < 2) throw new HttpError(422, "CARRIER_REQUIRED", "Chọn đơn vị vận chuyển cho hàng đổi.");
      if (trackingCode.length < 6) throw new HttpError(422, "TRACKING_REQUIRED", "Mã vận đơn hàng đổi phải có ít nhất 6 ký tự.");
      const result = await repository.shipExchange(returnId, expectedVersion, {
        carrier,
        trackingCode,
        trackingUrl: asString(body.trackingUrl).trim() || undefined,
        labelUrl: asString(body.labelUrl).trim() || undefined
      }, context.profile?.user_id || context.authUser.id);
      void sendExchangeShippingEmail(returnId, trackingCode);
      return result;
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
