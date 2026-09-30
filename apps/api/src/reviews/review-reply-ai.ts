import { asString, isJsonObject } from "../types.js";

export interface ReviewReplySource {
  rating: number;
  comment: string;
  productName: string;
}

/**
 * Prompt chỉ chứa nội dung đánh giá thật. Cấm bịa voucher, hoàn tiền hoặc chính sách.
 */
export function reviewReplyPrompt(source: ReviewReplySource): string {
  return [
    "Bạn là CSKH Velura. Viết tối đa 2 câu trả lời tiếng Việt cho đánh giá dưới đây.",
    "Chỉ nhắc những gì có trong đánh giá. Không hứa voucher, phần trăm giảm, hoàn tiền, hoặc gọi điện nếu đánh giá không nói tới.",
    "Không bịa tên khách. Không thêm số liệu.",
    `Sản phẩm: ${source.productName || "không rõ"}`,
    `Số sao: ${source.rating}`,
    `Nội dung: ${source.comment || "(khách không viết chữ, chỉ có số sao)"}`,
    "Trả JSON với khóa replies là mảng 1 hoặc 2 chuỗi."
  ].join("\n");
}

/**
 * Lấy các câu trả lời không rỗng từ JSON của mô hình.
 */
export function readReplySuggestions(payload: unknown): string[] {
  if (!isJsonObject(payload)) return [];
  const replies = payload.replies;
  if (!Array.isArray(replies)) return [];
  return replies.map((item) => asString(item).trim()).filter((item) => item.length >= 8).slice(0, 2);
}
