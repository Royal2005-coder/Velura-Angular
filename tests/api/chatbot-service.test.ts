import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ASSISTANT_GREETING } from "../../apps/api/src/chatbot/chatbot-constants.js";
import { createFallbackReply, detectHandoffIntent, getFallbackReply } from "../../apps/api/src/chatbot/chatbot-service.js";


test("default chatbot greeting introduces Velura Stylist capabilities", () => {
  assert.match(DEFAULT_ASSISTANT_GREETING, /Velura Stylist/);
  assert.match(DEFAULT_ASSISTANT_GREETING, /Gợi ý outfit/);
  assert.match(DEFAULT_ASSISTANT_GREETING, /Tạo ticket/);
  assert.match(DEFAULT_ASSISTANT_GREETING, /CSKH/);
});

test("greeting fallback returns the branded onboarding message", () => {
  assert.equal(createFallbackReply("Xin chào"), DEFAULT_ASSISTANT_GREETING);
});

test("handoff detection accepts direct CSKH and ticket requests", () => {
  assert.equal(detectHandoffIntent("Mình muốn gặp CSKH"), true);
  assert.equal(detectHandoffIntent("Tạo ticket hỗ trợ đơn hàng giúp mình"), true);
  assert.equal(detectHandoffIntent("Tôi cần phản ánh về giao hàng"), true);
});

test("policy query fallback explains return policy rules", async () => {
  const mockRepository = {
    async searchPolicies() {
      return {
        rows: [{
          title: "Chính sách đổi trả",
          summary: "Khách hàng gửi yêu cầu đổi trả trong vòng 48 giờ kể từ khi đơn hàng được giao thành công.",
          content: [
            {
              heading: "Thời hạn nghiêm ngặt",
              items: [
                "Khách hàng phải gửi yêu cầu trong vòng tối đa 2 ngày (48 giờ) kể từ lúc trạng thái đơn hàng cập nhật thành Đã giao thành công.",
                "Sau 48 giờ, hệ thống tự động khóa tính năng gửi yêu cầu đổi trả cho đơn hàng đó."
              ]
            }
          ]
        }]
      };
    }
  };
  const reply = await getFallbackReply("Chính sách đổi trả", [], mockRepository);
  assert.match(reply, /48 giờ/);
  assert.match(reply, /Đã giao thành công/);
});

test("handoff detection handles CSKH escalation triggers correctly", () => {
  assert.equal(detectHandoffIntent("CSKH"), true);
  assert.equal(detectHandoffIntent("gặp nhân viên hỗ trợ"), true);
  assert.equal(detectHandoffIntent("tôi muốn mua váy"), false);
});
