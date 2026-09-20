/**
 * Một nguồn duy nhất trả lời câu hỏi "chiến dịch này đang ở trạng thái nào".
 *
 * Trước đây mỗi nơi tự suy ra một kiểu: badge trên bảng tính theo khung ngày, còn nút
 * thao tác cạnh nó lại chỉ đọc `is_active`. Kết quả là một dòng hiện "Đã kết thúc"
 * nhưng vẫn mời bấm "Kích hoạt", và bấm vào thì RPC trả `OUTSIDE_DATE_RANGE`. Trang ưu
 * đãi bên khách lại lọc theo một bộ điều kiện thứ ba.
 *
 * Tính ở API, trả kèm mỗi dòng, để ba chỗ đó không thể lệch nhau nữa. Thuần, không I/O,
 * nên test thẳng được.
 */

export type PromotionLifecycle =
  | "scheduled"
  | "running"
  | "paused"
  | "ended"
  | "budget_exhausted";

/** Mức độ của một cảnh báo, dùng để chọn màu nhãn trên bảng. */
export type PromotionWarningLevel = "info" | "warning" | "danger";

export interface PromotionWarning {
  code: string;
  level: PromotionWarningLevel;
  message: string;
}

/** Các trường của `promotion` mà vòng đời phụ thuộc vào. */
export interface PromotionLifecycleInput {
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  /** Khác null nghĩa là một admin đã tắt tay, không phải bộ lịch tắt. */
  pausedAt: string | null;
  /** 0 nghĩa là không đặt trần — không phải "ngân sách bằng 0". */
  budgetLimit: number;
  totalDiscountIssued: number;
  /** Số mã thuộc chiến dịch, và số mã còn hiệu lực. */
  voucherCount?: number;
  activeVoucherCount?: number;
}

const LIFECYCLE_LABELS: Readonly<Record<PromotionLifecycle, string>> = {
  scheduled: "Chờ tới ngày",
  running: "Đang chạy",
  paused: "Tạm dừng",
  ended: "Đã kết thúc",
  budget_exhausted: "Hết ngân sách"
};

/** Ngưỡng bắt đầu cảnh báo sắp cạn ngân sách. */
const BUDGET_WARNING_RATIO = 0.8;

/** Số ngày trước khi kết thúc thì nhắc admin. */
const ENDING_SOON_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trạng thái vòng đời của một chiến dịch tại thời điểm `now`.
 *
 * Thứ tự xét có chủ đích: hết hạn là sự thật áp đảo, một chiến dịch quá ngày kết thúc
 * thì dù có bị tắt tay hay cạn ngân sách cũng vẫn là "đã kết thúc".
 */
export function promotionLifecycle(input: PromotionLifecycleInput, now: Date): PromotionLifecycle {
  const nowIso = now.toISOString();
  if (input.endDate && input.endDate < nowIso) return "ended";
  if (input.budgetLimit > 0 && input.totalDiscountIssued >= input.budgetLimit) {
    return "budget_exhausted";
  }
  if (input.pausedAt) return "paused";
  if (input.startDate && input.startDate > nowIso) return "scheduled";
  return input.isActive ? "running" : "paused";
}

/** Nhãn tiếng Việt của một trạng thái vòng đời. */
export function promotionLifecycleLabel(lifecycle: PromotionLifecycle): string {
  return LIFECYCLE_LABELS[lifecycle];
}

/**
 * Chiến dịch có bật lại được không.
 *
 * Nút "Kích hoạt" chỉ nên hiện khi RPC thật sự chấp nhận: `admin_activate_promotion`
 * từ chối cả trường hợp ngoài khung ngày lẫn trường hợp đã cạn ngân sách.
 */
export function canActivatePromotion(lifecycle: PromotionLifecycle): boolean {
  return lifecycle === "paused";
}

/** Chiến dịch có tạm dừng được không — chỉ khi đang thật sự chạy. */
export function canPausePromotion(lifecycle: PromotionLifecycle): boolean {
  return lifecycle === "running";
}

/**
 * Các cảnh báo cần đập vào mắt người vận hành ngay trên bảng danh sách.
 *
 * Không có chỗ này thì ngân sách cạn dần, chiến dịch sắp hết hạn hay đang bị tắt tay
 * đều chỉ lộ ra khi có người tình cờ mở đúng dòng đó.
 */
export function promotionWarnings(input: PromotionLifecycleInput, now: Date): PromotionWarning[] {
  const lifecycle = promotionLifecycle(input, now);
  const warnings: PromotionWarning[] = [];

  if (lifecycle === "ended") return warnings;

  if (lifecycle === "budget_exhausted") {
    warnings.push({
      code: "BUDGET_EXHAUSTED",
      level: "danger",
      message: "Đã dùng hết ngân sách — chiến dịch không còn giảm giá cho khách."
    });
  } else if (input.budgetLimit > 0) {
    const ratio = input.totalDiscountIssued / input.budgetLimit;
    if (ratio >= BUDGET_WARNING_RATIO) {
      warnings.push({
        code: "BUDGET_NEARLY_EXHAUSTED",
        level: "warning",
        message: `Đã dùng ${Math.round(ratio * 100)}% ngân sách.`
      });
    }
  }

  if (lifecycle === "paused") {
    warnings.push({
      code: "PAUSED",
      level: "info",
      message: input.pausedAt
        ? "Đang tạm dừng thủ công — voucher của chiến dịch cũng đã ngừng."
        : "Đang tắt."
    });
  }

  // Ngân sách chỉ tăng khi có người dùng mã của chiến dịch. Đặt trần cho một chiến dịch
  // chưa phát mã nào thì con số đó không bao giờ nhúc nhích — nói thẳng thay vì vẽ một
  // thanh tiến độ đứng yên.
  if (input.voucherCount !== undefined) {
    if (input.budgetLimit > 0 && input.voucherCount === 0) {
      warnings.push({
        code: "BUDGET_NOT_TRACKED",
        level: "warning",
        message: "Chiến dịch chưa có mã nào nên ngân sách không được theo dõi."
      });
    }
    if (lifecycle === "running" && input.voucherCount > 0 && input.activeVoucherCount === 0) {
      warnings.push({
        code: "NO_ACTIVE_VOUCHER",
        level: "danger",
        message: "Đang chạy nhưng không mã nào còn hiệu lực — khách không dùng được gì."
      });
    }
  }

  if (lifecycle === "running" && input.endDate) {
    const daysLeft = Math.ceil((Date.parse(input.endDate) - now.getTime()) / DAY_MS);
    if (Number.isFinite(daysLeft) && daysLeft >= 0 && daysLeft <= ENDING_SOON_DAYS) {
      warnings.push({
        code: "ENDING_SOON",
        level: "warning",
        message: daysLeft === 0 ? "Kết thúc hôm nay." : `Còn ${daysLeft} ngày là kết thúc.`
      });
    }
  }

  return warnings;
}

/**
 * Đọc một dòng `promotion` thô từ PostgREST thành đầu vào của vòng đời.
 */
export function toLifecycleInput(row: Record<string, unknown>): PromotionLifecycleInput {
  return {
    isActive: row.is_active !== false,
    startDate: row.start_date ? String(row.start_date) : null,
    endDate: row.end_date ? String(row.end_date) : null,
    pausedAt: row.paused_at ? String(row.paused_at) : null,
    budgetLimit: Number(row.budget_limit || 0),
    totalDiscountIssued: Number(row.total_discount_issued || 0)
  };
}
