import { enrichAuditLogs, RETURN_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, JsonObject, RequestMeta } from "../types.js";
import { asNumber, asString } from "../types.js";
import { RETURN_OPERATOR_ROLES, RETURN_READER_ROLES, RETURN_STATUSES } from "./return-constants.js";
import type { ReturnRepository } from "./return-repository.js";

/**
 * Auth context plus optional request IP used by return mutations.
 */
type ReturnContext = AuthContext & Partial<RequestMeta>;

/**
 * Admin return / support use-cases consumed by `handleReturnRoute`.
 */
export interface ReturnService {
  listReturns(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  getReturn(context: ReturnContext | undefined, returnId: string): Promise<JsonObject>;
  approveRefund(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  approveExchange(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  reject(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  updateReturnStatus(context: ReturnContext | undefined, returnId: string, body: JsonObject): Promise<JsonObject>;
  listTickets(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  getTicket(context: ReturnContext | undefined, ticketId: string): Promise<JsonObject>;
  assignTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  respondTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  closeTicket(context: ReturnContext | undefined, ticketId: string, body: JsonObject): Promise<unknown>;
  listAuditLogs(context: ReturnContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
}

/**
 * Build the admin return / support service around a PostgREST repository.
 */
export function createReturnService({ repository }: { repository: ReturnRepository }): ReturnService {
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
      const refundAmount = asNumber(body.refundAmount);
      if (refundAmount <= 0) throw new HttpError(422, "VALIDATION_ERROR", "Refund amount must be positive");
      const expectedVersion = asNumber(body.expectedVersion);
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
      if (!RETURN_STATUSES.includes(status)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid return status");
      }
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) {
        throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      }

      const adminNote = body.adminNote;
      const reason = body.reason;
      const refundAmount = body.refundAmount ? asNumber(body.refundAmount) : undefined;
      const trackingReturnCode = body.trackingReturnCode;
      const conditionCheckResult = body.conditionCheckResult;
      const imageProof = body.imageProof;

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
      return repository.respondTicket(ticketId, { response, expectedVersion }, context.accessToken);
    },

    async closeTicket(context, ticketId, body) {
      requireReturnAdmin(context);
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.closeTicket(ticketId, { reason: body.reason, expectedVersion }, context.accessToken);
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
