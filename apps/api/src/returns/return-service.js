import { HttpError } from "../http.js";
import { RETURN_OPERATOR_ROLES, RETURN_READER_ROLES, RETURN_STATUSES, RETURN_TRANSITIONS } from "./return-constants.js";

export function createReturnService({ repository }) {
  function requireReturnAdmin(context) {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!RETURN_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only CSKH operator or super admin can manage returns");
    }
  }

  function requireReturnReader(context) {
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
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async getReturn(context, returnId) {
      requireReturnReader(context);
      const ret = await repository.getReturn(returnId, context.accessToken);
      if (!ret) throw new HttpError(404, "RETURN_NOT_FOUND", "Return not found");
      return ret;
    },

    async approveRefund(context, returnId, body) {
      requireReturnAdmin(context);
      const refundAmount = parseFloat(body?.refundAmount || "0");
      if (refundAmount <= 0) throw new HttpError(422, "VALIDATION_ERROR", "Refund amount must be positive");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.approveRefund(
        returnId,
        { refundAmount, adminNote: body.adminNote, expectedVersion },
        context.profile?.user_id || context.authUser.id,
        context.roleCode,
        context.ipAddress
      );
    },

    async approveExchange(context, returnId, body) {
      requireReturnAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
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
      const reason = body?.reason || "";
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
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
      const status = body?.status;
      if (!RETURN_STATUSES.includes(status)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid return status");
      }
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) {
        throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      }

      const adminNote = body?.adminNote;
      const reason = body?.reason;
      const refundAmount = body?.refundAmount ? parseFloat(body.refundAmount) : undefined;
      const trackingReturnCode = body?.trackingReturnCode;
      const conditionCheckResult = body?.conditionCheckResult;
      const imageProof = body?.imageProof;

      return repository.updateReturnStatus(returnId, {
        status,
        adminNote,
        reason,
        refundAmount,
        trackingReturnCode,
        conditionCheckResult,
        imageProof,
        expectedVersion
      }, context.profile?.user_id || context.authUser.id, context.roleCode, context.ipAddress);
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
      const assignedTo = body?.assignedTo || "";
      if (!assignedTo) throw new HttpError(422, "VALIDATION_ERROR", "assignedTo required");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.assignTicket(ticketId, { assignedTo, expectedVersion }, context.accessToken);
    },

    async respondTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const response = body?.response || "";
      if (response.length < 1) throw new HttpError(422, "VALIDATION_ERROR", "Response content required");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.respondTicket(ticketId, { response, expectedVersion }, context.accessToken);
    },

    async closeTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.closeTicket(ticketId, { reason: body.reason, expectedVersion }, context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requireReturnReader(context);
      return repository.listAuditLogs({
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: Math.max(parseInt(searchParams.get("offset") || "0"), 0),
        targetId: searchParams.get("targetId") || undefined
      }, context.accessToken);
    }
  };
}
