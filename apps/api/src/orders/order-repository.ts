import { HttpError } from "../http.js";
import { callRpc, quotePostgrestValue, selectOne, selectRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { ORDER_DETAIL_SELECT, ORDER_LIST_SELECT } from "./order-constants.js";

/**
 * PostgREST order repository used by `createOrderService`.
 */
export type OrderRepository = ReturnType<typeof createOrderRepository>;

/** Trần số đơn gom từ view tag khi lọc "Cần xử lý". */
const ATTENTION_CAP = 1000;

/**
 * Create the order PostgREST repository.
 */
export function createOrderRepository() {
  return {
    async list(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = { select: ORDER_LIST_SELECT, order: filters.order, limit: filters.limit, offset: filters.offset };
      const and: string[] = [];
      if (filters.q) and.push(`or(order_code.ilike.*${filters.q}*,shipping_name.ilike.*${filters.q}*,shipping_phone.ilike.*${filters.q}*,tracking_code.ilike.*${filters.q}*)`);
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.paymentMethod) query.payment_method = `eq.${filters.paymentMethod}`;
      if (filters.from) and.push(`order_date.gte.${filters.from}`);
      if (filters.to) and.push(`order_date.lte.${filters.to}`);

      // Lọc theo tag: tag tính trong view `admin_order_tags`, nên lấy danh sách đơn từ
      // view trước rồi lọc bảng đơn theo danh sách đó. Nhờ vậy phân trang và số đếm đúng
      // trên toàn bộ đơn, không chỉ trên trang đang xem.
      if (filters.tag || filters.attention) {
        const ids = await this.orderIdsWithTags(filters.tag ? String(filters.tag) : null, accessToken);
        const idList = ids.map(quotePostgrestValue).join(",");
        if (filters.attention) {
          // "Cần xử lý" = có tag cần chú ý hoặc còn chờ xác nhận.
          and.push(ids.length ? `or(status.eq.pending,order_id.in.(${idList}))` : "status.eq.pending");
        } else {
          if (!ids.length) return { rows: [], count: 0 };
          query.order_id = `in.(${idList})`;
        }
      }
      if (and.length) query.and = `(${and.join(",")})`;
      return withOrderError(() => selectRows("orders", query, authOptions(accessToken)));
    },

    async orderIdsWithTags(tag: string | null, accessToken: string | null): Promise<string[]> {
      const { rows } = await withOrderError(() => selectRows("admin_order_tags", {
        select: "order_id",
        tags: tag ? `cs.{${tag}}` : "neq.{}",
        limit: ATTENTION_CAP
      }, { ...authOptions(accessToken), count: "none" }));
      return rows.map((row) => asString(row.order_id)).filter(Boolean);
    },

    async tagsFor(orderIds: string[], accessToken: string | null): Promise<Record<string, string[]>> {
      if (!orderIds.length) return {};
      const { rows } = await withOrderError(() => selectRows("admin_order_tags", {
        select: "order_id,tags",
        order_id: `in.(${orderIds.map(quotePostgrestValue).join(",")})`,
        limit: orderIds.length
      }, { ...authOptions(accessToken), count: "none" }));
      const map: Record<string, string[]> = {};
      for (const row of rows) map[asString(row.order_id)] = Array.isArray(row.tags) ? row.tags.map(String) : [];
      return map;
    },

    /** Số đơn của từng trạng thái, đếm ở cơ sở dữ liệu (một truy vấn đếm cho mỗi trạng thái). */
    async countByStatus(statuses: readonly string[], accessToken: string | null): Promise<Record<string, number>> {
      const entries = await Promise.all(statuses.map(async (status) => {
        const { count } = await withOrderError(() => selectRows("orders", {
          select: "order_id",
          status: `eq.${status}`,
          limit: 1
        }, authOptions(accessToken)));
        return [status, count ?? 0] as const;
      }));
      return Object.fromEntries(entries);
    },

    async countAttention(accessToken: string | null): Promise<number> {
      const ids = await this.orderIdsWithTags(null, accessToken);
      const idList = ids.map(quotePostgrestValue).join(",");
      const { count } = await withOrderError(() => selectRows("orders", {
        select: "order_id",
        or: ids.length ? `(status.eq.pending,order_id.in.(${idList}))` : "(status.eq.pending)",
        limit: 1
      }, authOptions(accessToken)));
      return count ?? 0;
    },

    findById(orderId: string, accessToken: string | null) {
      return withOrderError(() => selectOne("orders", {
        select: ORDER_DETAIL_SELECT,
        order_id: `eq.${orderId}`
      }, authOptions(accessToken)));
    },

    performAction(orderId: string, input: JsonObject, accessToken: string | null) {
      return rpc("admin_order_action", {
        p_order_id: orderId,
        p_action: input.action,
        p_note: input.note,
        p_payload: input.payload,
        p_expected_version: input.expectedVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    /**
     * Action của System hoặc của khách. Chạy bằng khoá service-role vì hàm chỉ cấp cho
     * service_role; quyền của người gọi đã được kiểm ở tầng dịch vụ.
     */
    serviceAction(orderId: string, input: JsonObject) {
      return withOrderError(() => callRpc("velura_order_service_action", {
        p_order_id: orderId,
        p_action: input.action,
        p_actor_id: input.actorId ?? null,
        p_note: input.note ?? null,
        p_payload: input.payload ?? {},
        p_expected_version: input.expectedVersion ?? null
      }));
    },

    resolvePayment(orderId: string, paymentId: string, input: JsonObject, accessToken: string | null) {
      return rpc("admin_resolve_payment", {
        p_order_id: orderId,
        p_payment_id: paymentId,
        p_decision: input.decision,
        p_reason: input.reason,
        p_expected_order_version: input.expectedOrderVersion,
        p_expected_payment_version: input.expectedPaymentVersion,
        p_ip_address: input.ipAddress
      }, accessToken);
    },

    listAuditLogs(filters: JsonObject, accessToken: string | null) {
      return withOrderError(() => selectRows("audit_log", {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        module: "eq.orders",
        target_id: `eq.${filters.orderId}`,
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      }, authOptions(accessToken)));
    }
  };
}

function authOptions(accessToken: string | null | undefined) {
  return { useAnonKey: true, accessToken };
}

function rpc(name: string, payload: unknown, accessToken: string | null): Promise<unknown> {
  return withOrderError(() => callRpc(name, payload, authOptions(accessToken)));
}

async function withOrderError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = asJsonObject(error.details);
      const code = asString(details.message) || asString(details.code) || "ORDER_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      // Không chuyển nguyên lỗi PostgREST ra ngoài: frontend hiện `details` trước
      // `message`, và lỗi thô lộ cấu trúc CSDL. Mã lỗi đã đủ để nhận biết.
      throw new HttpError(status, code, orderErrorMessage(code));
    }
    throw error;
  }
}

/** Câu báo tiếng Việt cho mã lỗi từ RPC và từ guard phía API (cùng một bộ mã). */
export function orderErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    RBAC_DENIED: "Vai trò hiện tại không được xử lý đơn hàng.",
    ORDER_NOT_FOUND: "Không tìm thấy đơn hàng.",
    PAYMENT_NOT_FOUND: "Không tìm thấy thanh toán của đơn.",
    VERSION_CONFLICT: "Đơn vừa được người khác cập nhật. Tải lại để xem trạng thái mới nhất.",
    PAYMENT_VERSION_CONFLICT: "Thanh toán vừa được cập nhật. Tải lại rồi thử lại.",
    EXPECTED_VERSION_REQUIRED: "Thiếu phiên bản dữ liệu của đơn.",
    UNKNOWN_ORDER_ACTION: "Thao tác không tồn tại.",
    ACTION_NOT_ALLOWED_FOR_ACTOR: "Thao tác này do hệ thống thực hiện, admin không làm bằng tay.",
    INVALID_ORDER_ACTION: "Thao tác không còn hợp lệ với trạng thái hiện tại của đơn.",
    NOTE_REQUIRED: "Cần nhập ghi chú (tối thiểu 5 ký tự).",
    COD_ONLY: "Chỉ đơn COD mới xác nhận bằng tay; đơn online được xác nhận khi thanh toán thành công.",
    ONLINE_ONLY: "Thao tác chỉ áp cho đơn thanh toán online.",
    TRACKING_CODE_REQUIRED: "Cần tạo vận đơn có mã vận đơn trước khi xác nhận bàn giao.",
    SHIPMENT_VOIDED: "Vận đơn đã bị vô hiệu. Tạo lại vận đơn trước khi bàn giao.",
    ORDER_ALREADY_HANDED_OVER: "Đơn đã bàn giao cho đơn vị vận chuyển, không huỷ được nữa.",
    ALREADY_RETURNED_TO_STOCK: "Hàng của đơn này đã được xác nhận hoàn kho.",
    REFUND_NOT_RETRYABLE: "Đơn không có lần hoàn tiền lỗi nào cần thử lại.",
    CALL_RESULT_REQUIRED: "Chọn kết quả cuộc gọi.",
    SHORTAGE_REQUIRED: "Nhập tình trạng thiếu hàng.",
    CANCEL_REASON_REQUIRED: "Chọn hoặc nhập lý do huỷ.",
    NOT_ORDER_OWNER: "Bạn không có quyền với đơn hàng này.",
    ORDER_REASON_REQUIRED: "Cần nhập lý do (tối thiểu 10 ký tự).",
    PAYMENT_REASON_REQUIRED: "Cần nhập lý do (tối thiểu 10 ký tự).",
    INVALID_PAYMENT_DECISION: "Quyết định đối soát không hợp lệ.",
    ORDER_TERMINAL: "Đơn đã kết thúc, không sửa được.",
    PAYMENT_NOT_RESOLVABLE: "Thanh toán này không cần đối soát bằng tay.",
    CARRIER_SIMULATION_DENIED: "Chỉ super_admin được mô phỏng kết quả của đơn vị vận chuyển."
  };
  return messages[code] || "Không xử lý được đơn hàng.";
}
