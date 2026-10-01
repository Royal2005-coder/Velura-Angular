/**
 * Allowed return / exchange statuses.
 */
export const RETURN_STATUSES: readonly string[] = ["pending", "approved", "shipping_back", "received", "completed", "rejected"];

/**
 * Mốc nghiệp vụ map vào enum đang có, không thêm trạng thái mới.
 * Tiếp nhận = pending. Đã duyệt / chờ gửi = approved. Đang gửi về = shipping_back.
 * Đã nhận hàng = received. Hoàn tất = completed. Từ chối hoặc hủy = rejected.
 */
export const OPEN_RETURN_STATUSES: readonly string[] = ["pending", "approved", "shipping_back", "received"];

/**
 * Nhãn tiếng Việt phía khách. Mã tiếng Anh là state machine admin quản lý.
 * `received` chỉ được ghi khi QA xác nhận đúng hàng của shop và admin đã tải ảnh minh chứng.
 */
export const RETURN_STATUS_LABELS_VI: Readonly<Record<string, string>> = {
  pending: "Chờ xử lý",
  approved: "Đã duyệt",
  shipping_back: "Đang gửi hàng về",
  received: "Nhận hàng hoàn trả thành công",
  completed: "Hoàn tất đổi/trả",
  rejected: "Từ chối"
};

/** Lý do đổi trả bắt buộc, dạng mã cố định để gom top lý do trên dashboard. */
export const RETURN_REASONS: readonly { code: string; label: string }[] = [
  { code: "error", label: "Sản phẩm bị lỗi sản xuất" },
  { code: "size", label: "Không vừa kích cỡ" },
  { code: "color", label: "Sai màu sắc" },
  { code: "mismatch", label: "Sản phẩm khác với mô tả" },
  { code: "damaged", label: "Hàng bị hư hỏng trong vận chuyển" },
  { code: "mind_change", label: "Thay đổi ý định mua hàng" },
  { code: "other", label: "Lý do khác" }
];

/** Kết quả QA kho. Chỉ `qa_pass` được chuyển phiếu sang received. */
export const RETURN_QA_PASS = "qa_pass";

/**
 * Nhãn tiếng Việt của một mã lý do. Mã lạ trả chuỗi rỗng.
 */
export function returnReasonLabel(code: string): string {
  return RETURN_REASONS.find((item) => item.code === code)?.label || "";
}

export interface ReturnIntake {
  code: string;
  label: string;
  images: string[];
  description: string;
}

export type ReturnIntakeResult =
  | { ok: true; intake: ReturnIntake }
  | { ok: false; error: "RETURN_REASON_REQUIRED" | "RETURN_EVIDENCE_REQUIRED" | "RETURN_NOTE_REQUIRED"; message: string };

/**
 * Lý do phải là một mã trong dropdown và phải có ít nhất một ảnh minh chứng.
 */
export function normalizeReturnIntake(reasonCode: unknown, images: unknown, note: unknown): ReturnIntakeResult {
  const code = String(reasonCode || "").trim();
  const label = returnReasonLabel(code);
  if (!label) {
    return { ok: false, error: "RETURN_REASON_REQUIRED", message: "Chọn lý do đổi trả trong danh sách. Không được để trống." };
  }
  const list = (Array.isArray(images) ? images : [])
    .map((item) => String(item || "").trim())
    .filter((item) => item.startsWith("data:image/") || item.startsWith("https://") || item.startsWith("http://"))
    .slice(0, 5);
  if (!list.length) {
    return { ok: false, error: "RETURN_EVIDENCE_REQUIRED", message: "Bắt buộc tải ít nhất một hình ảnh minh chứng." };
  }
  const extra = String(note || "").trim();
  if (code === "other" && extra.length < 5) {
    return { ok: false, error: "RETURN_NOTE_REQUIRED", message: "Chọn lý do Khác thì phải ghi chú thêm." };
  }
  return {
    ok: true,
    intake: {
      code,
      label,
      images: list,
      description: extra ? `${label}. ${extra}` : label
    }
  };
}

/**
 * Legal status transitions for return / exchange records.
 */
export const RETURN_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["approved", "rejected"],
  // `approved` sang `rejected` là đường khách tự huỷ yêu cầu sau khi đã được duyệt
  // nhưng chưa gửi hàng đi (`apps/api/src/user/returns.ts`). Đây là hành vi nghiệp vụ
  // có thật và đang chạy, nên bảng này phải công nhận thay vì để code đi vòng.
  approved: ["shipping_back", "rejected"],
  shipping_back: ["received"],
  received: ["completed", "rejected"],
  completed: [],
  rejected: []
};

/**
 * Roles that may read admin returns and support tickets.
 */
export const RETURN_READER_ROLES: readonly string[] = [
  "super_admin",
  "admin_operator_donhang",
  "admin_operator_cskh_dt"
];

/**
 * Roles that may mutate returns and support tickets.
 */
export const RETURN_OPERATOR_ROLES: readonly string[] = [
  "super_admin",
  "admin_operator_cskh_dt"
];

/**
 * Allowed support-ticket statuses.
 */
export const SUPPORT_TICKET_STATUSES: readonly string[] = ["open", "processing", "resolved", "closed"];

/**
 * Legal status transitions for support tickets.
 */
export const SUPPORT_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  open: ["processing", "closed"],
  processing: ["resolved", "closed"],
  resolved: ["closed"],
  closed: []
};

/**
 * PostgREST select list for `return_exchange` rows.
 */
export const RETURN_SELECT = [
  "return_id", "order_id", "user_id", "return_type", "reason", "description",
  "status", "condition_check_result", "admin_note", "rejection_reason",
  "exchange_order_id", "refund_amount", "tracking_return_code",
  "created_at", "resolved_at", "version", "evidence_images"
].join(",");

/**
 * PostgREST select list for `support_ticket` rows.
 */
export const TICKET_SELECT = [
  "ticket_id", "user_id", "guest_phone", "guest_email", "title",
  "description", "priority", "status", "admin_reply", "csat_score",
  "created_at", "resolved_at", "version"
].join(",");
