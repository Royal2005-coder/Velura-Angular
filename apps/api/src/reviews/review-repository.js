import { callRpc, selectOne, selectRows } from "../supabase.js";
import { REVIEW_SELECT } from "./review-constants.js";

export function createReviewRepository() {
  return {
    async list(filters, accessToken) {
      const query = {
        select: REVIEW_SELECT,
        order: filters.order,
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.rating) query.rating = `eq.${filters.rating}`;
      if (filters.search) {
        query.or = `(comment.ilike.*${filters.search}*,product.name.ilike.*${filters.search}*)`;
      }
      return selectRows("review", query, authOptions(accessToken));
    },

    async get(reviewId, accessToken) {
      return selectOne("review", {
        select: REVIEW_SELECT,
        review_id: `eq.${reviewId}`
      }, authOptions(accessToken));
    },

    async approve(reviewId, input, accessToken) {
      return callRpc("admin_approve_review", {
        p_review_id: reviewId,
        p_expected_version: input.expectedVersion,
        p_action_note: input.actionNote || null
      }, { accessToken });
    },

    async hide(reviewId, input, accessToken) {
      return callRpc("admin_hide_review", {
        p_review_id: reviewId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async reply(reviewId, input, accessToken) {
      return callRpc("admin_reply_review", {
        p_review_id: reviewId,
        p_reply: input.reply,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async escalate(reviewId, input, accessToken) {
      return callRpc("admin_escalate_review", {
        p_review_id: reviewId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async listAuditLogs(filters, accessToken) {
      const query = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.reviews",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return selectRows("audit_log", query, authOptions(accessToken));
    }
  };
}

function authOptions(accessToken) {
  return { useAnonKey: true, accessToken };
}
