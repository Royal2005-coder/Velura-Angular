import crypto from "crypto";
import { callRpc, selectOne, selectRows, updateRows, insertRow } from "../supabase.js";
import { RETURN_SELECT, TICKET_SELECT } from "./return-constants.js";
import { HttpError } from "../http.js";

export function createReturnRepository() {
  return {
    async listReturns(filters, accessToken) {
      const query = {
        select: RETURN_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.search) query.or = `(description.ilike.*${filters.search}*)`;
      return selectRows("return_exchange", query, authOptions(accessToken));
    },

    async getReturn(returnId, accessToken) {
      return selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      }, authOptions(accessToken));
    },

    async approveRefund(returnId, input, actorId, actorRole, ipAddress) {
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
      if (current.status !== "pending") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }
      if (!input.refundAmount || input.refundAmount <= 0) {
        throw new HttpError(422, "REFUND_AMOUNT_REQUIRED", "Refund amount must be positive");
      }

      const payload = {
        status: "approved",
        refund_amount: input.refundAmount,
        admin_note: input.adminNote ? input.adminNote.trim() : "",
        resolved_at: new Date().toISOString(),
        version: current.version + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: rows[0].status, version: rows[0].version, refund_amount: rows[0].refund_amount },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return rows[0];
    },

    async approveExchange(returnId, input, actorId, actorRole, ipAddress) {
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
      if (current.status !== "pending") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }

      // Fetch original order details
      const originalOrder = await selectOne("orders", {
        order_id: `eq.${current.order_id}`
      });
      if (!originalOrder) {
        throw new HttpError(404, "ORDER_NOT_FOUND", "Original order not found");
      }

      const newOrderId = crypto.randomUUID();

      // Create the replacement exchange order record first
      await insertRow("orders", {
        order_id: newOrderId,
        user_id: originalOrder.user_id,
        shipping_name: originalOrder.shipping_name,
        shipping_phone: originalOrder.shipping_phone,
        shipping_address: originalOrder.shipping_address,
        shipping_fee: 0,
        subtotal: 0,
        total_amount: 0,
        payment_method: originalOrder.payment_method,
        internal_note: `Đơn đổi hàng cho yêu cầu đổi trả ${returnId}`
      });

      // Fetch returned items to clone them
      const { rows: returnItems } = await selectRows("return_item", {
        return_id: `eq.${returnId}`
      });

      for (const item of returnItems) {
        const origItem = await selectOne("order_item", {
          item_id: `eq.${item.order_item_id}`
        });
        if (origItem) {
          await insertRow("order_item", {
            order_id: newOrderId,
            variant_id: origItem.variant_id,
            product_name: origItem.product_name,
            product_image: origItem.product_image || null,
            quantity: item.quantity,
            unit_price: origItem.unit_price,
            subtotal_item: origItem.unit_price * item.quantity
          });
        }
      }

      const payload = {
        status: "approved",
        exchange_order_id: newOrderId,
        admin_note: input.adminNote ? input.adminNote.trim() : "",
        resolved_at: new Date().toISOString(),
        version: current.version + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: rows[0].status, version: rows[0].version, exchange_order_id: newOrderId },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return rows[0];
    },

    async reject(returnId, input, actorId, actorRole, ipAddress) {
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
      if (current.status !== "pending") {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Return record is not pending");
      }
      if (!input.reason || input.reason.trim().length < 10) {
        throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      }

      const payload = {
        status: "rejected",
        rejection_reason: input.reason.trim(),
        resolved_at: new Date().toISOString(),
        version: current.version + 1,
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

      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: "reject",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: rows[0].status, version: rows[0].version },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return rows[0];
    },

    async updateReturnStatus(returnId, input, actorId, actorRole, ipAddress) {
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

      const payload = {
        status: input.status,
        version: current.version + 1,
        updated_at: new Date().toISOString()
      };
      if (input.adminNote !== undefined) payload.admin_note = input.adminNote;
      if (input.reason !== undefined) payload.rejection_reason = input.reason;
      if (input.refundAmount !== undefined && input.refundAmount !== null) payload.refund_amount = input.refundAmount;
      if (input.trackingReturnCode !== undefined) payload.tracking_return_code = input.trackingReturnCode;
      if (input.conditionCheckResult !== undefined) payload.condition_check_result = input.conditionCheckResult;
      if (input.imageProof !== undefined && input.imageProof !== null) {
        payload.evidence_images = [input.imageProof];
      }
      
      if (["completed", "rejected"].includes(input.status)) {
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
      const auditAction = input.status === "rejected" ? "reject"
        : input.status === "approved" ? "approve"
        : "update";

      await insertRow("audit_log", {
        actor_id: actorId,
        actor_role: actorRole,
        action: auditAction,
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: rows[0].status, version: rows[0].version, transition: `${current.status} → ${input.status}` },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return rows[0];
    },

    async listTickets(filters, accessToken) {
      const query = {
        select: TICKET_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      return selectRows("support_ticket", query, authOptions(accessToken));
    },

    async getTicket(ticketId, accessToken) {
      return selectOne("support_ticket", {
        select: TICKET_SELECT,
        ticket_id: `eq.${ticketId}`
      }, authOptions(accessToken));
    },

    async assignTicket(ticketId, input, accessToken) {
      return callRpc("admin_assign_ticket", {
        p_ticket_id: ticketId,
        p_assigned_to: input.assignedTo,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async respondTicket(ticketId, input, accessToken) {
      return callRpc("admin_respond_ticket", {
        p_ticket_id: ticketId,
        p_response: input.response,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async closeTicket(ticketId, input, accessToken) {
      return callRpc("admin_close_ticket", {
        p_ticket_id: ticketId,
        p_expected_version: input.expectedVersion,
        p_reason: input.reason || ""
      }, { accessToken });
    },

    async listAuditLogs(filters, accessToken) {
      const query = {
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

function authOptions(accessToken) {
  return { useAnonKey: true, accessToken };
}
