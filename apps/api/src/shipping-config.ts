/**
 * Cấu hình phí vận chuyển — MỘT nơi duy nhất.
 *
 * BA 3.1.14 (AD_ORDER_03): miễn phí vận chuyển là NGƯỠNG giá trị đơn, không phải một loại
 * voucher. Loại `free_shipping` trong VOUCHER_TYPES vẫn giữ vì dữ liệu cũ đang dùng; nó không
 * thay thế ngưỡng này. Đổi ngưỡng ở đây, `order-pricing.ts` và báo giá đọc lại từ đây.
 */
export const SHIPPING_CONFIG = {
  /** Đơn có tạm tính từ mức này trở lên được miễn phí ship (đ). */
  freeShipThreshold: 500_000,
  standardFee: 30_000,
  expressFee: 50_000
} as const;
