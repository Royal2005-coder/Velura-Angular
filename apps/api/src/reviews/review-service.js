import { HttpError } from "../http.js";
import { REVIEW_OPERATOR_ROLES, REVIEW_READER_ROLES } from "./review-constants.js";

export function createReviewService({ repository }) {
  function requireReviewAdmin(context) {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!REVIEW_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only review operator or super admin can manage reviews");
    }
  }

  function requireReviewReader(context) {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!REVIEW_READER_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view reviews");
    }
  }

  return {
    async list(context, searchParams) {
      requireReviewReader(context);
      return repository.list({
        status: searchParams.get("status") || undefined,
        rating: searchParams.get("rating") || undefined,
        search: searchParams.get("q") || undefined,
        order: "submitted_at.desc",
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async get(context, reviewId) {
      requireReviewReader(context);
      const review = await repository.get(reviewId, context.accessToken);
      if (!review) throw new HttpError(404, "REVIEW_NOT_FOUND", "Review not found");
      return review;
    },

    async approve(context, reviewId, body) {
      requireReviewAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.approve(reviewId, { actionNote: body.actionNote, expectedVersion }, context.accessToken);
    },

    async hide(context, reviewId, body) {
      requireReviewAdmin(context);
      const reason = body?.reason || "";
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.hide(reviewId, { reason, expectedVersion }, context.accessToken);
    },

    async reply(context, reviewId, body) {
      requireReviewAdmin(context);
      const reply = body?.reply || "";
      if (reply.length < 1) throw new HttpError(422, "VALIDATION_ERROR", "Reply content required");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.reply(reviewId, { reply, expectedVersion }, context.accessToken);
    },

    async escalate(context, reviewId, body) {
      requireReviewAdmin(context);
      const reason = body?.reason || "";
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.escalate(reviewId, { reason, expectedVersion }, context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requireReviewReader(context);
      return repository.listAuditLogs({
        targetId: searchParams.get("targetId") || undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 1000),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    }
  };
}
