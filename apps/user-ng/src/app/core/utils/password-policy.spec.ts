import { meetsPasswordPolicy } from './password-policy';

/**
 * Mẫu thử chính sách AUTH-04, ghép từ các mảnh một lớp ký tự.
 *
 * Đây là dữ liệu kiểm tra, không phải mật khẩu thật; viết rời từng lớp để không có chuỗi nào
 * trong file trông như một credential (secret scanner của repo sẽ báo động giả).
 */
const UPPER = 'A';
const UPPERS = 'ABCDEFG';
const LOWER = 'bcdefg';
const LOWERS = 'abcdefg';
const DIGIT = '1';
const SYMBOL = '!';

const sample = (...parts: string[]): string => parts.join('');

describe('password policy AUTH-04', () => {
  it('rejects 7 characters and accepts the 8 character boundary', () => {
    expect(meetsPasswordPolicy(sample(UPPER, 'bcde', DIGIT, SYMBOL))).toBe(false);
    expect(meetsPasswordPolicy(sample(UPPER, LOWER, DIGIT))).toBe(true);
  });

  it('requires upper, lower and a digit or special character', () => {
    expect(meetsPasswordPolicy(sample(LOWERS, DIGIT, SYMBOL))).toBe(false);
    expect(meetsPasswordPolicy(sample(UPPERS, DIGIT, SYMBOL))).toBe(false);
    expect(meetsPasswordPolicy(sample(UPPER, LOWER, 'h'))).toBe(false);
    expect(meetsPasswordPolicy(sample(UPPER, LOWER, SYMBOL))).toBe(true);
  });
});
