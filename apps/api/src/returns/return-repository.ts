import crypto from "crypto";
import { callRpc, selectOne, selectRows, updateRows, insertRow } from "../supabase.js";
import { HttpError } from "../http.js";
import { asJsonObject, asNumber, asString, type JsonObject } from "../types.js";
import { RETURN_SELECT, TICKET_SELECT } from "./return-constants.js";

/**
 * Filters for listing return / exchange records.
 */
export interface ReturnListFilters {
  status?: string;
  search?: string;
  orderId?: string;
  limit: number;
  offset: number;
}

/**
 * Filters for listing support tickets.
 */
export interface TicketListFilters {
  status?: string;
  limit: number;
  offset: number;
}

/**
 * Filters for return / support audit logs.
 */
export interface ReturnAuditFilters {
  targetId?: string;
  limit: number;
  offset: number;
}

/**
 * Input for approving a refund.
 */
export interface ApproveRefundInput {
  refundAmount: number;
  adminNote?: unknown;
  expectedVersion: number;
}

/**
 * Input for approving an exchange.
 */
export interface ApproveExchangeInput {
  adminNote?: unknown;
  expectedVersion: number;
}

/**
 * Input for rejecting a return.
 */
export interface RejectReturnInput {
  reason: string;
  imageProof?: unknown;
  expectedVersion: number;
}

/**
 * Input for a generic return status update.
 */
export interface UpdateReturnStatusInput {
  /** Per-line warehouse QA facts persisted with the receipt state transition. */
  receipts?: unknown;
  status: string;
  adminNote?: unknown;
  reason?: unknown;
  refundAmount?: number;
  trackingReturnCode?: unknown;
  conditionCheckResult?: unknown;
  imageProof?: unknown;
  expectedVersion: number;
}

/**
 * Input for assigning a support ticket.
 */
export interface AssignTicketInput {
  assignedTo: string;
  expectedVersion: number;
}

/**
 * Input for responding to a support ticket.
 */
export interface RespondTicketInput {
  response: string;
  expectedVersion: number;
}

/**
 * Input for closing a support ticket.
 */
export interface CloseTicketInput {
  reason?: unknown;
  expectedVersion: number;
}

/**
 * PostgREST accessors for admin returns, exchanges, and support tickets.
 */
export function createReturnRepository() {
  return {
    /** Creates one real replacement order atomically after warehouse QA. */
    /** Commits audited transfer evidence and server-authoritative net refund ledger. */
    async recordManualRefund(returnId:string,expectedVersion:number,reference:string,proof:string,actorId:string) {return asJsonObject(await callRpc("velura_record_manual_return_refund",{p_return_id:returnId,p_expected_version:expectedVersion,p_reference:reference,p_proof:proof,p_actor_id:actorId}));},
    async prepareExchange(returnId:string,expectedVersion:number,actorId:string) { return asJsonObject(await callRpc("velura_prepare_exchange",{p_return_id:returnId,p_expected_version:expectedVersion,p_actor_id:actorId})); },
    async listReturns(filters: ReturnListFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: RETURN_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.orderId) query.order_id = `eq.${filters.orderId}`;
      if (filters.search) query.or = `(description.ilike.*${filters.search}*)`;
      return selectRows("return_exchange", query, authOptions(accessToken));
    },

    async listReturnLines(returnId: string, accessToken: string) {
      return selectRows("return_item", {
        select: "return_item_id,order_item_id,quantity",
        return_id: `eq.${returnId}`,
        limit: 50
      }, authOptions(accessToken));
    },

    async getReturn(returnId: string, accessToken: string) {
      return selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      }, authOptions(accessToken));
    },

    /**
     * Thông tin thanh toán mới nhất của đơn hàng gắn với phiếu đổi trả.
     */
    async getPaymentByOrderId(orderId: string, accessToken?: string): Promise<JsonObject | null> {
      const options = accessToken ? authOptions(accessToken) : undefined;
      const result = await selectRows("payment", {
        select: "payment_id,payment_method,payment_provider,amount,payment_status,gateway_transaction_ref,refund_at,refund_amount,gateway_response_code,created_at,refunded_amount",
        order_id: `eq.${orderId}`,
        order: "created_at.desc",
        limit: 1
      }, options);
      return result.rows[0] ? asJsonObject(result.rows[0]) : null;
    },

    /**
     * Giá trị hoàn được của một phiếu: tổng tiền đúng những món khách gửi trả.
     *
     * UAT ADM-RET-01 chốt "tự động điền tiền hoàn đúng số tiền của hàng thay vì bắt tự
     * nhập". Số đó không phải tổng đơn — một đơn bốn món mà khách chỉ trả một món thì
     * hoàn cả đơn là thất thoát; và cũng không thể để CSKH gõ tay, vì gõ tay thì con số
     * phụ thuộc trí nhớ của người trực.
     *
     * Đọc qua `return_item` (phiếu ↔ dòng đơn) nhân với đơn giá đã bán tại thời điểm
     * đặt, chứ không lấy giá hiện hành của sản phẩm.
     */
    async getRefundableAmount(returnId: string, accessToken: string): Promise<number> {
      return asNumber(await callRpc("velura_return_refundable_amount", {p_return_id:returnId}, {accessToken}));
    },

    async approveRefund(returnId: string, input: ApproveRefundInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      if (current.status !== "CONTACTING") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }
      if (!input.refundAmount || input.refundAmount <= 0) {
        throw new HttpError(422, "REFUND_AMOUNT_REQUIRED", "Refund amount must be positive");
      }

      const note = typeof input.adminNote === "string" ? input.adminNote.trim() : "";
      const contacted = /\[CSKH(?:\s|\])/.test(asString(current.admin_note));
      if (!contacted && note.length < 10) {
        throw new HttpError(422, "CONTACT_OR_REASON_REQUIRED", "Chưa ghi nhận liên hệ CSKH. Duyệt khi chưa liên hệ phải có lý do ít nhất 10 ký tự.");
      }
      const payload: JsonObject = {
        status: "WAITING_RETURN",
        refund_amount: input.refundAmount,
        admin_note: note || asString(current.admin_note),
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version, refund_amount: updated.refund_amount },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async approveExchange(returnId: string, input: ApproveExchangeInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      if (current.status !== "REQUESTED") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }

      const payload: JsonObject = {
        status: "WAITING_RETURN",
        admin_note: typeof input.adminNote === "string" ? input.adminNote.trim() : "",
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async reject(returnId: string, input: RejectReturnInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      if (current.status !== "REQUESTED") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }
      if (!input.reason || input.reason.trim().length < 10) {
        throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      }

      const payload: JsonObject = {
        status: "CANCELLED",
        rejection_reason: input.reason.trim(),
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };
      if (input.imageProof) {
        payload.evidence_images = [input.imageProof];
      }

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "reject",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async updateReturnStatus(returnId: string, input: UpdateReturnStatusInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }

      const payload: JsonObject = {
        status: input.status,
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };
      if (input.adminNote !== undefined) payload.admin_note = input.adminNote;
      if (input.reason !== undefined) payload.rejection_reason = input.reason;
      if (input.refundAmount !== undefined && input.refundAmount !== null) payload.refund_amount = input.refundAmount;
      if (input.trackingReturnCode !== undefined) payload.tracking_return_code = input.trackingReturnCode;
      if (input.receipts !== undefined) payload.qa_item_receipts = input.receipts;
      if (input.imageProof !== undefined && input.status === "RECEIVED") payload.warehouse_proof = input.imageProof;
      if (input.trackingReturnCode !== undefined && input.status === "EXCHANGE_SHIPPING") payload.exchange_tracking_code = input.trackingReturnCode;
      if (input.conditionCheckResult !== undefined) payload.condition_check_result = input.conditionCheckResult;
      if (input.imageProof !== undefined && input.imageProof !== null) {
        const existing = Array.isArray(current.evidence_images) ? current.evidence_images.map(String) : [];
        payload.evidence_images = [...existing, String(input.imageProof)];
      }

      if (["COMPLETED", "CANCELLED"].includes(input.status)) {
        payload.resolved_at = new Date().toISOString();
      }

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      // Map status to a valid audit_action enum value
      // Valid values: create, update, delete, approve, reject, lock, unlock
      const auditAction = input.status === "CANCELLED" ? "reject"
        : input.status === "WAITING_RETURN" ? "approve"
        : "update";

      const updated = asJsonObject(rows[0]);
      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: auditAction,
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version, transition: `${current.status} → ${input.status}` },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async listTickets(filters: TicketListFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: TICKET_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      return selectRows("support_ticket", query, authOptions(accessToken));
    },

    async getTicket(ticketId: string, accessToken: string) {
      return selectOne("support_ticket", {
        select: TICKET_SELECT,
        ticket_id: `eq.${ticketId}`
      }, authOptions(accessToken));
    },

    async assignTicket(ticketId: string, input: AssignTicketInput, accessToken: string) {
      return callRpc("admin_assign_ticket", {
        p_ticket_id: ticketId,
        p_assigned_to: input.assignedTo,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async respondTicket(ticketId: string, input: RespondTicketInput, accessToken: string) {
      return callRpc("admin_respond_ticket", {
        p_ticket_id: ticketId,
        p_response: input.response,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async closeTicket(ticketId: string, input: CloseTicketInput, accessToken: string) {
      return callRpc("admin_close_ticket", {
        p_ticket_id: ticketId,
        p_expected_version: input.expectedVersion,
        p_reason: input.reason || ""
      }, { accessToken });
    },

    async updateTicketStatus(
      ticketId: string,
      input: { status: string; adminNote?: string; expectedVersion: number },
      accessToken: string
    ) {
      if (input.status !== "resolved") {
        throw new HttpError(422, "VALIDATION_ERROR", "Chỉ hỗ trợ đánh dấu phiếu đã giải quyết");
      }
      return callRpc("admin_resolve_ticket", {
        p_ticket_id: ticketId,
        p_expected_version: input.expectedVersion,
        p_admin_note: input.adminNote || ""
      }, { accessToken });
    },

    async recordContact(returnId: string, input: { result: string; note: string; expectedVersion: number }, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", { select: RETURN_SELECT, return_id: `eq.${returnId}` });
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      const stamp = new Date().toISOString();
      const line = `[CSKH ${stamp}] ${input.result}: ${input.note}`;
      const adminNote = [asString(current.admin_note), line].filter(Boolean).join("\n");
      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, {
        status: ["REQUESTED","NEEDS_SUPPORT"].includes(asString(current.status)) ? "CONTACTING" : current.status,
        admin_note: adminNote,
        version: asNumber(current.version) + 1,
        updated_at: stamp
      });
      if (!rows.length) throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "update",
        module: "returns",
        target_id: returnId,
        old_value: { version: current.version },
        new_value: { result: input.result, note: input.note },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: stamp
      });
      return asJsonObject(rows[0]);
    },

    async listAuditLogs(filters: ReturnAuditFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset,
        or: "(module.eq.returns,module.eq.support)"
      };
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return selectRows("audit_log", query, authOptions(accessToken));
    }
  };
}

/**
 * Repository returned by `createReturnRepository`.
 */
export type ReturnRepository = ReturnType<typeof createReturnRepository>;

function authOptions(accessToken: string): { useAnonKey: true; accessToken: string } {
  return { useAnonKey: true, accessToken };
}
