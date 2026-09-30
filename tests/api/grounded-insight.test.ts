import test from "node:test";
import assert from "node:assert/strict";
import { keepGroundedSentences } from "../../apps/api/src/insights/grounded-brief.ts";
import { readReplySuggestions } from "../../apps/api/src/reviews/review-reply-ai.ts";

test("khuyến nghị bị loại nếu thêm số không có trong bản tóm tắt", () => {
  const brief = ["Phiếu đổi trả: 4.", "Tỷ lệ đổi trả trên đơn đã giao: 12%."];
  const kept = keepGroundedSentences(
    "Có 4 phiếu đổi trả, tỷ lệ 12%. Nên thêm ngân sách 50000000 đồng.",
    brief
  );
  assert.deepEqual(kept, ["Có 4 phiếu đổi trả, tỷ lệ 12%."]);
});

test("gợi ý phản hồi review chỉ nhận chuỗi đủ dài từ JSON", () => {
  assert.deepEqual(readReplySuggestions({ replies: ["Xin lỗi vì áo bị lỗi chỉ.", ""] }), ["Xin lỗi vì áo bị lỗi chỉ."]);
  assert.deepEqual(readReplySuggestions({ replies: "không phải mảng" }), []);
});
