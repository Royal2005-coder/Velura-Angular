import test from "node:test";
import assert from "node:assert/strict";
import { assertOrderVisibleTo, hasOpenStripeSession, presentOrderForCustomer } from "../../apps/api/src/user/orders.js";

const OWNER = { user_id: "11111111-1111-4111-8111-111111111111" };
const STRANGER = { user_id: "22222222-2222-4222-8222-222222222222" };

test("a guest cannot read an order just by knowing its tracking code", () => {
  // Đây là lỗ hổng thật: điều kiện cũ chỉ chặn khi có `profile`, nên người chưa đăng
  // nhập đi thẳng qua và đọc được họ tên, số điện thoại, địa chỉ giao. Mã vận đơn sinh
  // từ tám chữ số cuối của một mốc mili giây nên dò được.
  assert.throws(
    () => assertOrderVisibleTo({ order_id: "o1", user_id: OWNER.user_id }, null),
    (error) => error.status === 401
  );
});

test("a guest cannot read a guest order either", () => {
  // Đơn của khách vãng lai có `user_id` bằng null. Không được để chúng thành cửa mở
  // chỉ vì không có chủ: tra cứu cho khách vãng lai phải đi qua số điện thoại và OTP.
  assert.throws(
    () => assertOrderVisibleTo({ order_id: "o2", user_id: null }, null),
    (error) => error.status === 401
  );
});

test("a signed-in member cannot read another member's order", () => {
  assert.throws(
    () => assertOrderVisibleTo({ order_id: "o3", user_id: OWNER.user_id }, STRANGER),
    (error) => error.status === 404
  );
});

test("a signed-in member cannot read an unowned guest order", () => {
  assert.throws(
    () => assertOrderVisibleTo({ order_id: "o4", user_id: null }, STRANGER),
    (error) => error.status === 404
  );
});

test("the owner reads their own order", () => {
  assertOrderVisibleTo({ order_id: "o5", user_id: OWNER.user_id }, OWNER);
});

test("the customer view drops admin-only columns", () => {
  const view = presentOrderForCustomer({
    order_id: "o5",
    order_code: "VLR1A2B3C4D5",
    status: "confirmed",
    internal_note: "Khách khó tính, gọi trước",
    ai_source: "chatbot",
    version: 7,
    stock_committed_at: "2026-09-25 01:00:00",
    total_amount: 500000
  }, [], []);
  assert.equal(view.order_code, "VLR1A2B3C4D5");
  assert.equal(view.status_label, "Đã xác nhận");
  for (const hidden of ["internal_note", "ai_source", "version", "stock_committed_at"]) {
    assert.equal(hidden in view, false, `${hidden} must not reach the storefront`);
  }
});

test("a voided waybill is not shown to the customer", () => {
  const view = presentOrderForCustomer({
    order_id: "o6", status: "processing", tracking_code: "GHN1", tracking_url: "https://ghn.vn/t/GHN1", shipment_voided_at: "2026-09-25 02:00:00"
  }, [], []);
  assert.equal(view.tracking_code, null);
  assert.equal(view.tracking_url, null);
});

test("timeline follows the stored history in time order", () => {
  const view = presentOrderForCustomer({ order_id: "o7", status: "shipping" }, [], [
    { new_status: "shipping", changed_at: "2026-09-25 03:00:00" },
    { new_status: "pending", changed_at: "2026-09-24 03:00:00" },
    { new_status: "confirmed", changed_at: "2026-09-24 09:00:00" }
  ]);
  assert.deepEqual((view.timeline as Array<{ status: string }>).map((row) => row.status), ["pending", "confirmed", "shipping"]);
});

test("customers may cancel until processing starts (BR-03)", () => {
  const can = (status: string) => presentOrderForCustomer({ order_id: "o8", status, payment_method: "COD" }, [], []).can_cancel;
  assert.equal(can("pending"), true);
  assert.equal(can("confirmed"), true);
  assert.equal(can("processing"), false);
  assert.equal(can("shipping"), false);
});

test("pay again is offered only within 24 hours of an online order waiting for payment", () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const view = (created_at: string, status = "waiting_payment") =>
    presentOrderForCustomer({ order_id: "o9", status, payment_method: "ONLINE_PAYMENT", created_at }, [], []);
  assert.equal(view(recent).can_pay_again, true);
  assert.equal(view(old).can_pay_again, false);
  assert.equal(view(recent, "confirmed").can_pay_again, false);
});

test("a Stripe session younger than its lifetime blocks a second one", () => {
  const now = Date.parse("2026-09-25T10:00:00Z");
  assert.equal(hasOpenStripeSession([{ created_at: "2026-09-25 09:50:00" }], now), true);
  assert.equal(hasOpenStripeSession([{ created_at: "2026-09-25 09:00:00" }], now), false);
  assert.equal(hasOpenStripeSession([], now), false);
});
