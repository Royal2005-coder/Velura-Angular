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
 * Lấy các câu trả lời không rỗng từ JSON của mô hình, kể cả khi bọc trong markdown.
 */
export function readReplySuggestions(payload: unknown): string[] {
  const parsed = unwrapReplyPayload(payload);
  if (!isJsonObject(parsed)) return [];
  const replies = parsed.replies;
  if (!Array.isArray(replies)) return [];
  return replies.map((item) => asString(item).trim()).filter((item) => item.length >= 8).slice(0, 2);
}

function unwrapReplyPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  const fenced = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || payload).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return payload;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return payload;
  }
}

/**
 * Câu dự phòng chỉ nhắc số sao, tên sản phẩm và đúng đoạn khách viết. Không hứa voucher hay hoàn tiền.
 */
export function groundedReviewReply(source: ReviewReplySource): string {
  const product = source.productName || "sản phẩm";
  const comment = source.comment.trim().slice(0, 180);
  const stars = source.rating > 0 ? `${source.rating} sao` : "đánh giá";
  if (source.rating > 0 && source.rating <= 2) {
    return comment
      ? `Chào bạn, Velura rất tiếc vì đánh giá ${stars} cho ${product}. Chúng mình đã ghi nhận đúng góp ý: "${comment}". CSKH sẽ xử lý theo nội dung này.`
      : `Chào bạn, Velura rất tiếc vì đánh giá ${stars} cho ${product}. Bạn mô tả giúp vấn đề cụ thể để CSKH xử lý đúng việc.`;
  }
  if (source.rating >= 4) {
    return comment
      ? `Chào bạn, Velura cảm ơn đánh giá ${stars} cho ${product}. Góp ý của bạn: "${comment}".`
      : `Chào bạn, Velura cảm ơn bạn đã đánh giá ${stars} cho ${product}.`;
  }
  return comment
    ? `Chào bạn, Velura đã nhận đánh giá ${stars} cho ${product}: "${comment}". Bạn cho biết thêm điểm chưa ổn nếu cần CSKH hỗ trợ.`
    : `Chào bạn, Velura đã nhận đánh giá ${stars} cho ${product}. Bạn mô tả thêm giúp để CSKH hỗ trợ đúng việc.`;
}
