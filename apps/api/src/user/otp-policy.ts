/** AUTH-08 (BA 3.1.1): mỗi mã OTP có hiệu lực 5 phút; UI đếm ngược 05:00 phải khớp backend. */
export const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * Số lần nhập sai tối đa cho một mã OTP.
 *
 * BA mới mô tả AUTH-07 cho phiên OTP đặt hàng, chưa chốt trần cho đăng ký/khôi phục (UAT #747).
 * Chọn 5: đủ cho người gõ nhầm, nhưng không đủ để dò 10^6 mã trong 5 phút hiệu lực.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Kết quả một lần nhập sai OTP.
 *
 * Chạm trần thì `blocked` bật và bộ đếm về 0, vì mã hiện tại sẽ bị huỷ — mã mới (nếu người dùng
 * yêu cầu lại) phải bắt đầu lại từ đầu thay vì bị khoá luôn.
 */
export function nextOtpAttemptFailure(attemptCount: unknown): { attemptCount: number; blocked: boolean } {
  const attempts = Math.max(0, Math.trunc(Number(attemptCount) || 0)) + 1;
  return attempts >= OTP_MAX_ATTEMPTS
    ? { attemptCount: 0, blocked: true }
    : { attemptCount: attempts, blocked: false };
}
