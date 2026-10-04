import { enrichAuditLogs, RETURN_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, JsonObject, RequestMeta } from "../types.js";
import { asJsonObject, asNumber, asString, errorMessage } from "../types.js";
import {
  RETURN_OPERATOR_ROLES,
  RETURN_QA_PASS,
  RETURN_READER_ROLES,
  RETURN_STATUSES,
  RETURN_TRANSITIONS,
  SUPPORT_TICKET_TRANSITIONS
} from "./return-constants.js";
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
  approveRefund(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  /** Records non-Stripe refund only with transfer proof after warehouse QA. */
  recordManualRefund(context: ReturnContext | undefined, returnId:string, body:JsonObject):Promise<JsonObject>;
  triggerStripeRefund(context: ReturnContext | undefined, returnId: string, body?: JsonObject): Promise<JsonObject>;
  approveExchange(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  reject(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  updateReturnStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
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
    const ticket = await repository.getTicket(ticketId, context.accessToken);
    if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Không tìm thấy phiếu hỗ trợ");
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
      return repository.listReturns({
        status: searchParams.get("status") || undefined,
        search: searchParams.get("q") || undefined,
        orderId: searchParams.get("order_id") || undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async getReturn(context, returnId) {
      requireReturnReader(context);
      const ret = await repository.getReturn(returnId, context.accessToken);
      if (!ret) throw new HttpError(404, "RETURN_NOT_FOUND", "Return not found");
      // Kèm giá trị hoàn được để form duyệt hoàn tiền điền sẵn đúng số, không bắt gõ tay.
      const refundableAmount = await repository.getRefundableAmount(returnId, context.accessToken);
      const payment = ret.order_id && repository.getPaymentByOrderId
        ? await repository.getPaymentByOrderId(asString(ret.order_id), context.accessToken)
        : null;
      const lines = await repository.listReturnLines(returnId, context.accessToken);
      return { ...ret, refundable_amount: refundableAmount, payment, lines: lines.rows };
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

    async approveRefund(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");

      // Giá trị hoàn lấy từ chính các món khách gửi trả. CSKH không phải gõ tay, và
      // nếu có gõ thì cũng không vượt quá giá trị hàng đã bán (UAT ADM-RET-01).
      const refundable = await repository.getRefundableAmount(returnId, context.accessToken);
      const requested = body.refundAmount === undefined || body.refundAmount === null || body.refundAmount === ""
        ? refundable
        : asNumber(body.refundAmount);

      if (requested <= 0) {
        throw new HttpError(422, "VALIDATION_ERROR", "Refund amount must be positive");
      }
      if (refundable > 0 && requested > refundable) {
        throw new HttpError(422, "REFUND_EXCEEDS_ITEM_VALUE", `Số tiền hoàn vượt quá giá trị hàng trả (tối đa ${refundable})`, {
          refundAmount: [`Tối đa ${refundable}`]
        });
      }

      const updated = await repository.approveRefund(
        returnId,
        { refundAmount: requested, adminNote: body.adminNote, expectedVersion },
        context.profile?.user_id || context.authUser.id,
        context.roleCode,
        context.ipAddress
      );

      // Kích hoạt hoàn tiền Stripe nếu đơn hàng thanh toán qua Stripe
      return {...updated,refund:null};
    },

    async triggerStripeRefund(context, returnId, body = {}) {
      requireReturnAdmin(context);
      const current = await repository.getReturn(returnId, context.accessToken);
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Phiếu đổi trả không tồn tại");
      const orderId = asString(current.order_id);
      if (!orderId) throw new HttpError(422, "MISSING_ORDER_ID", "Phiếu không có mã đơn hàng hợp lệ");
      if (!refunds) throw new HttpError(503, "GATEWAY_UNAVAILABLE", "Cổng hoàn tiền Stripe chưa sẵn sàng");
      const version = asNumber(body.expectedVersion);
      if (!Number.isInteger(version) || version !== Number(current.version)) throw new HttpError(409,"VERSION_CONFLICT","Return changed");
      if (!["RECEIVED","REFUND_PROCESSING"].includes(asString(current.status)) || current.condition_check_result !== RETURN_QA_PASS || current.return_type === "exchange") throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Warehouse QA must pass before refund");
      const amount = await repository.getRefundableAmount(returnId, context.accessToken);
      if (amount <= 0) throw new HttpError(422,"NOTHING_TO_REFUND","No refundable balance");
      const payment = await repository.getPaymentByOrderId(orderId,context.accessToken);
      if (payment?.payment_provider !== "stripe") throw new HttpError(422,"STRIPE_PAYMENT_REQUIRED","Use the verified manual refund operation for non-Stripe payments");
      const result = await refunds.refund(orderId, amount, returnId, version);
      return { success: true, refund: result };
    },

    async recordManualRefund(context,returnId,body) {
      requireReturnAdmin(context);
      const current = await repository.getReturn(returnId,context.accessToken);
      if (!current) throw new HttpError(404,"RETURN_NOT_FOUND","Return not found");
      if (Number(body.expectedVersion) !== Number(current.version)) throw new HttpError(409,"VERSION_CONFLICT","Return changed");
      if (!["RECEIVED","REFUND_PROCESSING"].includes(asString(current.status)) || current.condition_check_result !== RETURN_QA_PASS) throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Warehouse QA must pass");
      const payment = await repository.getPaymentByOrderId(asString(current.order_id),context.accessToken);
      if (!payment || payment.payment_provider === "stripe" || !["paid","refund_pending"].includes(asString(payment.payment_status))) throw new HttpError(422,"CAPTURED_NON_STRIPE_REQUIRED","A captured non-Stripe payment is required");
      const reference = asString(body.transferReference).trim();
      const proof = asString(body.imageProof);
      if (reference.length < 6 || (!proof.startsWith("https://") && !proof.startsWith("data:image/"))) throw new HttpError(422,"TRANSFER_PROOF_REQUIRED","Transfer reference and proof image are required");
      return repository.recordManualRefund(returnId,Number(body.expectedVersion),reference,proof,context.profile?.user_id || context.authUser.id);
    },
    async approveExchange(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.approveExchange(
        returnId,
        { adminNote: body.adminNote, expectedVersion },
        context.profile?.user_id || context.authUser.id,
        context.roleCode,
        context.ipAddress
      );
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
      if (status === "RECEIVED") {
        const qa = asString(body.conditionCheckResult);
        const proof = asString(body.imageProof);
        const confirmedItemId = asString(body.confirmedItemId);
        const receivedQuantity = asNumber(body.receivedQuantity);
        if (qa !== RETURN_QA_PASS) {
          throw new HttpError(422, "QA_REQUIRED", "Nhận hàng hoàn trả thành công chỉ khi xác nhận đúng hàng của shop.");
        }
        if (!proof.startsWith("data:image/") && !proof.startsWith("http://") && !proof.startsWith("https://")) {
          throw new HttpError(422, "PROOF_REQUIRED", "Phải tải ảnh minh chứng đã kiểm hàng.");
        }
        const lines = await repository.listReturnLines(returnId, context.accessToken);
        const receipts = Array.isArray(body.items) ? body.items.map(asJsonObject) : lines.rows.length === 1 ? [{orderItemId:confirmedItemId,receivedQuantity,matchesProduct:true}] : [];
        if (!lines.rows.length || receipts.length !== lines.rows.length || new Set(receipts.map(row => asString(row.orderItemId))).size !== lines.rows.length) throw new HttpError(422,"ITEM_ID_MISMATCH","Confirm every returned line exactly once");
        body.items = receipts;
        for (const line of lines.rows) {
          const receipt = receipts.find(row => row.orderItemId === line.order_item_id);
          if (!receipt || receipt.matchesProduct !== true) throw new HttpError(422,"ITEM_ID_MISMATCH","Returned product does not match");
          const qty = Number(receipt.receivedQuantity);
          if (!Number.isInteger(qty) || qty < 1 || qty !== Number(line.quantity)) throw new HttpError(422,"QTY_MISMATCH","Received quantity does not match the registered line");
        }
      }
      if (["REFUND_PROCESSING","REFUNDED"].includes(status)) throw new HttpError(422,"GATEWAY_STATE_REQUIRED","Refund states are advanced by payment gateway evidence");
      let refundAmount = body.refundAmount ? asNumber(body.refundAmount) : undefined;
      if (status === "COMPLETED" && currentReturn.return_type === "refund" && from !== "REFUNDED") throw new HttpError(422,"REFUND_REQUIRED","Gateway must confirm the refund before completion");
      if (["RETURN_IN_TRANSIT","EXCHANGE_SHIPPING"].includes(status) && !asString(body.trackingReturnCode)) throw new HttpError(422,"TRACKING_REQUIRED","Shipment tracking is required");
      if (status === "EXCHANGE_PREPARING") {
        if (currentReturn.return_type !== "exchange" || currentReturn.condition_check_result !== RETURN_QA_PASS) throw new HttpError(422,"WAREHOUSE_QA_REQUIRED","Exchange requires warehouse QA");
        return repository.prepareExchange(returnId,expectedVersion,context.profile?.user_id || context.authUser.id);
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
        imageProof,
        receipts: status === "RECEIVED" ? body.items : undefined,
        expectedVersion
      }, context.profile?.user_id || context.authUser.id, context.roleCode, context.ipAddress);

      return updated;
    },

    async listTickets(context, searchParams) {
      requireReturnReader(context);
      return repository.listTickets({
        status: searchParams.get("status") || undefined,
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
