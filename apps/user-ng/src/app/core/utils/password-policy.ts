/**
 * AUTH-04 (BA 3.1.1): tối thiểu 8 ký tự, có chữ hoa, chữ thường và số hoặc ký tự đặc biệt.
 * Khớp `validatePassword` ở backend (apps/api/src/user/auth.ts) để lỗi hiện ngay ở Frontend.
 */
export const PASSWORD_POLICY_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W]).+$/;

/** Thông báo chuẩn hiển thị khi mật khẩu không đạt AUTH-04. */
export const PASSWORD_POLICY_MESSAGE =
  'Mật khẩu cần ít nhất 8 ký tự, gồm chữ hoa, chữ thường và số hoặc ký tự đặc biệt.';

/** Trả về true khi mật khẩu thỏa AUTH-04. */
export function meetsPasswordPolicy(password: string): boolean {
  return password.length >= 8 && PASSWORD_POLICY_PATTERN.test(password);
}
