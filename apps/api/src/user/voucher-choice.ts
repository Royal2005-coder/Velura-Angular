import type { EvaluatedVoucher } from "./voucher-engine.js";
import type { JsonObject } from "../types.js";

/**
 * Chọn mã nào được áp cho một đơn. Thuần, không I/O.
 *
 * Báo giá (`checkout-quote.ts`) và đặt đơn (`resolveOrderVoucher`) cùng gọi hàm này,
 * nên con số khách thấy ở màn Tóm tắt đơn và con số ghi vào đơn không thể lệch nhau.
 */

/** Lựa chọn mã của khách gửi lên. */
export interface VoucherRequest {
  voucherId: string | null;
  code: string | null;
  /** Khách chủ động bỏ mã. Khi đó không tự áp lại mã nào. */
  decline: boolean;
  /**
   * Mã mà báo giá đã cho khách thấy (`null` = báo giá không có mã). `undefined` = client cũ
   * không gửi, giữ hành vi cũ. Dùng để phát hiện mã tự động tốt nhất đổi giữa báo giá và đặt đơn.
   */
  quoted?: { voucherId: string | null };
}

/** Mã khách chọn không còn dùng được và đã bị thay. */
export interface VoucherChange {
  requestedVoucherId: string | null;
  requestedCode: string | null;
  reasonText: string;
}

/**
 * Chọn mã cho một đơn. Dùng chung cho báo giá và cho đặt đơn.
 *
 * Mã khách chọn còn hợp lệ thì dùng đúng mã đó. Không còn hợp lệ thì thay bằng mã
 * tốt nhất kế tiếp — hoặc không mã — và báo lại lý do (U1-09, quyết định D1). Khách
 * không chọn mã thì tự áp mã tốt nhất. Khách bỏ mã thì không áp gì.
 */
export function chooseOrderVoucher(
  wallet: { items: readonly EvaluatedVoucher[]; best: EvaluatedVoucher | null },
  request: VoucherRequest
): { applied: EvaluatedVoucher | null; change: VoucherChange | null } {
  if (request.decline) return { applied: null, change: null };

  const requested = request.voucherId || request.code;
  if (!requested) {
    // PAY-05: khách không chọn mã (tự áp mã tốt nhất). Nếu mã tốt nhất lúc đặt khác mã đã
    // báo giá thì tổng tiền sẽ đổi âm thầm — báo lại để khách xác nhận (VOUCHER_CHANGED).
    if (request.quoted !== undefined && (wallet.best?.voucherId ?? null) !== request.quoted.voucherId) {
      return {
        applied: wallet.best,
        change: {
          requestedVoucherId: request.quoted.voucherId,
          requestedCode: null,
          reasonText: wallet.best
            ? "Mã giảm giá tốt nhất cho đơn của bạn đã thay đổi. Vui lòng kiểm tra lại tổng tiền."
            : "Mã giảm giá đã báo giá không còn dùng được. Vui lòng kiểm tra lại tổng tiền."
        }
      };
    }
    return { applied: wallet.best, change: null };
  }

  const code = request.code?.trim().toUpperCase() || null;
  const match = wallet.items.find((item) =>
    (request.voucherId && item.voucherId === request.voucherId) ||
    (code && item.code.toUpperCase() === code)
  );
  if (match?.eligible) return { applied: match, change: null };

  return {
    applied: wallet.best,
    change: {
      requestedVoucherId: request.voucherId,
      requestedCode: match?.code || code,
      reasonText: match?.reasonText || "Mã giảm giá không tồn tại hoặc không còn dùng được."
    }
  };
}

/** Đọc lựa chọn mã từ body. Dùng chung cho báo giá và đặt đơn. */
export function readVoucherRequest(body: JsonObject): VoucherRequest {
  const voucherId = body.voucher_id ? String(body.voucher_id) : null;
  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : null;
  const quoted = readQuotedVoucher(body);
  return { voucherId, code, decline: body.decline_voucher === true, ...(quoted ? { quoted } : {}) };
}

/**
 * Đọc `quoted_voucher_id` (mã báo giá khách đã thấy). Khoá vắng mặt = client cũ → `undefined`;
 * khoá có giá trị `null` = báo giá không có mã.
 */
export function readQuotedVoucher(body: JsonObject): { voucherId: string | null } | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "quoted_voucher_id")) return undefined;
  const raw = body.quoted_voucher_id;
  return { voucherId: raw ? String(raw) : null };
}
