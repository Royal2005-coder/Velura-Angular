/**
 * Hạn hiển thị của một mã OTP trên storefront, tính bằng giây.
 *
 * AUTH-08 (BA 3.1.1) chốt mọi mã OTP sống 5 phút và `otp-policy.ts` phía API là nguồn duy nhất;
 * UI đếm đúng con số đó để khách không nhập mã vào lúc đồng hồ còn chạy mà server đã hết hạn.
 */
export const OTP_COUNTDOWN_SECONDS = 300;
