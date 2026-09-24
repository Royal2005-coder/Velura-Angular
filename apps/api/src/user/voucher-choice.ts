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
  if (!requested) return { applied: wallet.best, change: null };

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
  return { voucherId, code, decline: body.decline_voucher === true };
}
