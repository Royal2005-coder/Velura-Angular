import { callRpc, selectOne, selectRows } from "../supabase.js";
import { REVIEW_SELECT } from "./review-constants.js";

/**
 * Filters for listing admin reviews.
 */
export interface ReviewListFilters {
  status?: string;
  rating?: string;
  search?: string;
  /** Chỉ lấy đánh giá cần xử lý gấp: bị gắn cờ, hoặc từ 2 sao trở xuống. */
  urgent?: boolean;
  order: string;
  limit: number;
  offset: number;
}

/**
 * Điều kiện "cần xử lý gấp", viết theo cú pháp PostgREST.
 *
 * Định nghĩa này trước đây chỉ nằm trong một `computed` của trang Angular và chạy trên
 * đúng 10 dòng của trang hiện tại, nên con số KPI và tab "Cần xử lý gấp" đều nói về
 * trang chứ không về toàn bộ dữ liệu.
 */
const URGENT_CONDITION = "is_flagged_urgent.eq.true,rating.lte.2";

/**
 * Bọc một giá trị do người dùng gõ vào để PostgREST đọc nó như dữ liệu, không như cú
 * pháp.
 *
 * Dấu phẩy, ngoặc đơn và nháy kép đều có nghĩa trong ngữ pháp lọc của PostgREST. Nối
 * thẳng chuỗi tìm kiếm vào `or=(...)` thì một câu bình thường như `Áo dài, đẹp` sẽ bị
 * tách ở dấu phẩy thành hai mệnh đề méo và máy chủ trả 400 PGRST100 — ô tìm kiếm hỏng
 * với bất kỳ câu nào có dấu phẩy. Đã kiểm chứng trực tiếp trên PostgREST của dự án.
 *
 * Bọc trong nháy kép làm mọi ký tự bên trong thành dữ liệu; bên trong đó chỉ còn dấu
 * chéo ngược và nháy kép cần thoát. Dấu `*` vẫn giữ vai trò ký tự đại diện của `ilike`
 * kể cả khi nằm trong nháy kép.
 */
export function quotePostgrestValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Filters for review-module audit logs.
 */
export interface ReviewAuditFilters {
  targetId?: string;
  limit: number;
  offset: number;
}

/**
 * Input for approving a review.
 */
export interface ReviewApproveInput {
  expectedVersion: number;
  actionNote?: unknown;
}

/**
 * Input for hiding or escalating a review.
 */
export interface ReviewReasonInput {
  reason: string;
  expectedVersion: number;
}

/**
 * Input for posting an admin reply on a review.
 */
export interface ReviewReplyInput {
  reply: string;
  expectedVersion: number;
}

/**
 * PostgREST accessors for admin review moderation.
 */
export function createReviewRepository() {
  return {
    async list(filters: ReviewListFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: REVIEW_SELECT,
        order: filters.order,
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.rating) query.rating = `eq.${filters.rating}`;

      // PostgREST chỉ nhận một tham số `or` cho mỗi truy vấn, nên khi vừa tìm kiếm vừa
      // lọc gấp thì phải gộp hai nhóm vào một `and` lồng nhau thay vì ghi đè lẫn nhau.
      const searchCondition = filters.search
        ? `comment.ilike.${quotePostgrestValue(`*${filters.search}*`)},` +
          `product.name.ilike.${quotePostgrestValue(`*${filters.search}*`)}`
        : "";
      if (searchCondition && filters.urgent) {
        query.and = `(or(${searchCondition}),or(${URGENT_CONDITION}))`;
      } else if (searchCondition) {
        query.or = `(${searchCondition})`;
      } else if (filters.urgent) {
        query.or = `(${URGENT_CONDITION})`;
      }

      return selectRows("review", query, authOptions(accessToken));
    },

    async get(reviewId: string, accessToken: string) {
      return selectOne("review", {
        select: REVIEW_SELECT,
        review_id: `eq.${reviewId}`
      }, authOptions(accessToken));
    },

    async approve(reviewId: string, input: ReviewApproveInput, accessToken: string) {
      return callRpc("admin_approve_review", {
        p_review_id: reviewId,
        p_expected_version: input.expectedVersion,
        p_action_note: input.actionNote || null
      }, { accessToken });
    },

    async hide(reviewId: string, input: ReviewReasonInput, accessToken: string) {
      return callRpc("admin_hide_review", {
        p_review_id: reviewId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async reply(reviewId: string, input: ReviewReplyInput, accessToken: string) {
      return callRpc("admin_reply_review", {
        p_review_id: reviewId,
        p_reply: input.reply,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async escalate(reviewId: string, input: ReviewReasonInput, accessToken: string) {
      return callRpc("admin_escalate_review", {
        p_review_id: reviewId,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async listAuditLogs(filters: ReviewAuditFilters, accessToken: string) {
      const query: Record<string, unknown> = {
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

/**
 * Repository returned by `createReviewRepository`.
 */
export type ReviewRepository = ReturnType<typeof createReviewRepository>;

function authOptions(accessToken: string): { useAnonKey: true; accessToken: string } {
  return { useAnonKey: true, accessToken };
}
