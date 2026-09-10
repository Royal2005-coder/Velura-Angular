import { HttpError } from "../http.js";
import type { AuthContext, AuthUser, JsonObject } from "../types.js";
import { asNumber, asString } from "../types.js";
import { REVIEW_OPERATOR_ROLES, REVIEW_READER_ROLES } from "./review-constants.js";
import type { ReviewRepository } from "./review-repository.js";

/**
 * Admin review use-cases consumed by `handleReviewRoute`.
 */
export interface ReviewService {
  list(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
  get(context: AuthContext | undefined, reviewId: string): Promise<JsonObject>;
  approve(context: AuthContext | undefined, reviewId: string, body: JsonObject): Promise<unknown>;
  hide(context: AuthContext | undefined, reviewId: string, body: JsonObject): Promise<unknown>;
  reply(context: AuthContext | undefined, reviewId: string, body: JsonObject): Promise<unknown>;
  escalate(context: AuthContext | undefined, reviewId: string, body: JsonObject): Promise<unknown>;
  listAuditLogs(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<{ rows: JsonObject[]; count: number | undefined }>;
}

/**
 * Build the admin review service around a PostgREST repository.
 */
export function createReviewService({ repository }: { repository: ReviewRepository }): ReviewService {
  function requireReviewAdmin(context: AuthContext | undefined): asserts context is AuthContext & { authUser: AuthUser } {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!REVIEW_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only review operator or super admin can manage reviews");
    }
  }

  function requireReviewReader(context: AuthContext | undefined): asserts context is AuthContext & { authUser: AuthUser } {
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
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.approve(reviewId, { actionNote: body.actionNote, expectedVersion }, context.accessToken);
    },

    async hide(context, reviewId, body) {
      requireReviewAdmin(context);
      const reason = asString(body.reason);
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.hide(reviewId, { reason, expectedVersion }, context.accessToken);
    },

    async reply(context, reviewId, body) {
      requireReviewAdmin(context);
      const reply = asString(body.reply);
      if (reply.length < 1) throw new HttpError(422, "VALIDATION_ERROR", "Reply content required");
      const expectedVersion = asNumber(body.expectedVersion);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.reply(reviewId, { reply, expectedVersion }, context.accessToken);
    },

    async escalate(context, reviewId, body) {
      requireReviewAdmin(context);
      const reason = asString(body.reason);
      if (reason.length < 10) throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      const expectedVersion = asNumber(body.expectedVersion);
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
