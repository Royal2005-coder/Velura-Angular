/**
 * Lỗi từ API, giữ lại mã lỗi và phần chi tiết.
 *
 * Kế thừa `Error` nên mọi chỗ đang đọc `error.message` vẫn chạy nguyên. Chỗ nào cần
 * phân biệt từng loại lỗi — ví dụ `VOUCHER_CHANGED` lúc đặt đơn — thì đọc thêm
 * `code` và `details`.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}
