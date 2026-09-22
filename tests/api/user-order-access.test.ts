import test from "node:test";
import assert from "node:assert/strict";
import { assertOrderVisibleTo } from "../../apps/api/src/user/orders.js";

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
    (error) => error.status === 403
  );
});

test("a signed-in member cannot read an unowned guest order", () => {
  assert.throws(
    () => assertOrderVisibleTo({ order_id: "o4", user_id: null }, STRANGER),
    (error) => error.status === 403
  );
});

test("the owner reads their own order", () => {
  assertOrderVisibleTo({ order_id: "o5", user_id: OWNER.user_id }, OWNER);
});
