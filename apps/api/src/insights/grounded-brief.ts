import type { VoiceInsights } from "../insights.js";

const NUMBER_PATTERN = /\d+(?:[.,]\d+)?/g;

/**
 * Các câu chỉ chứa số đã có trong bản tóm tắt kỳ. Câu nào thêm số mới thì bỏ.
 */
export function keepGroundedSentences(text: string, brief: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const line of brief) {
    for (const match of line.match(NUMBER_PATTERN) || []) {
      allowed.add(match);
      allowed.add(match.replace(",", "."));
    }
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      if (!sentence) return false;
      const numbers = sentence.match(NUMBER_PATTERN) || [];
      return numbers.every((value) => allowed.has(value) || allowed.has(value.replace(",", ".")));
    });
}

/**
 * Tóm tắt đúng các số đã tính từ đơn, đánh giá, đổi trả và phiếu hỗ trợ.
 */
export function buildGroundedBrief(voice: VoiceInsights): string[] {
  const lines = [
    `Kỳ ${voice.periodLabel}.`,
    `Đơn đã giao: ${voice.coverage.deliveredOrders}.`,
    `Đơn có đánh giá: ${voice.coverage.reviewedOrders}.`,
    `Đơn giao không có đánh giá: ${voice.coverage.silentOrders}.`,
    `Tỷ lệ có đánh giá: ${voice.coverage.coveragePct}%.`,
    `Số đánh giá: ${voice.productReaction.reviewCount}.`,
    `Phiếu hỗ trợ: ${voice.serviceQuality.tickets}.`,
    `Phiếu đã đóng chưa có CSAT: ${voice.serviceQuality.ticketsWithoutCsat}.`,
    `Phiếu đổi trả: ${voice.serviceQuality.returns}.`,
    `Tỷ lệ đổi trả trên đơn đã giao: ${voice.serviceQuality.returnRatePct}%.`,
    `Đơn đã hủy: ${voice.orderFriction.cancelledOrders}.`,
    `Giao không thành công: ${voice.orderFriction.failedDelivery}.`
  ];
  if (voice.productReaction.avgRating !== null) {
    lines.push(`Điểm đánh giá trung bình: ${voice.productReaction.avgRating}.`);
  }
  if (voice.serviceQuality.csatAvg !== null) {
    lines.push(`CSAT trung bình: ${voice.serviceQuality.csatAvg} trên ${voice.serviceQuality.csatCount} phiếu.`);
  }
  const topReturn = voice.serviceQuality.returnReasons[0];
  if (topReturn) {
    lines.push(`Lý do đổi trả đứng đầu: ${topReturn.reason} với ${topReturn.count} phiếu.`);
  }
  if (voice.truncated) {
    lines.push("Số liệu kỳ này bị cắt trần đọc, chưa phải toàn bộ giao dịch.");
  }
  return lines;
}
