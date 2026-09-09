import test from "node:test";
import assert from "node:assert/strict";
import { createOrderService, validateStatusChange } from "../../apps/api/src/orders/order-service.js";

const ORDER_ID = "50000000-0000-4000-8000-000000000001";
const PAYMENT_ID = "60000000-0000-4000-8000-000000000001";

test("order reader can list production orders", async () => {
  let received;
  const service = createOrderService({ repository: { list: async (filters) => { received = filters; return { rows: [], count: 0 }; } } });
  await service.list(context("admin_operator_cskh_dt"), new URLSearchParams("status=pending&limit=10"));
  assert.equal(received.status, "pending");
  assert.equal(received.limit, 10);
});

test("unrelated and viewer roles cannot read orders", async () => {
  const service = createOrderService({ repository: { list: async () => ({ rows: [] }) } });
  for (const role of ["admin_operator_sanpham", "admin_viewer"]) {
    await assert.rejects(
      () => service.list(context(role), new URLSearchParams()),
      (error) => error.status === 403 && error.code === "RBAC_DENIED"
    );
  }
});

test("status validation requires tracking code for shipping", () => {
  assert.throws(
    () => validateStatusChange({ status: "shipping", reason: "Ban giao don hang cho don vi van chuyen", expectedVersion: 2 }),
    (error) => error.status === 422 && error.details.trackingCode.length === 1
  );
});

test("status transition is checked before mutation", async () => {
  let mutated = false;
  const service = createOrderService({ repository: {
    findById: async () => ({ order_id: ORDER_ID, status: "pending" }),
    changeStatus: async () => { mutated = true; }
  } });
  await assert.rejects(
    () => service.changeStatus(context("admin_operator_donhang"), ORDER_ID, {
      status: "shipping", reason: "Chuyen thang trang thai khong hop le", trackingCode: "GHN-1", expectedVersion: 1
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422
  );
  assert.equal(mutated, false);
});

test("order operator can change a valid status", async () => {
  let payload;
  const service = createOrderService({ repository: {
    findById: async () => ({ order_id: ORDER_ID, status: "confirmed" }),
    changeStatus: async (_id, input) => { payload = input; return { order_id: ORDER_ID, status: "preparing" }; }
  } });
  const result = await service.changeStatus(context("admin_operator_donhang"), ORDER_ID, {
    status: "preparing", reason: "Kho dang dong goi don hang nay", expectedVersion: 3
  }, { ipAddress: "127.0.0.1" });
  assert.equal(result.status, "preparing");
  assert.equal(payload.expectedVersion, 3);
});

test("CSKH can read but cannot cancel orders", async () => {
  const service = createOrderService({ repository: { cancel: async () => ({}) } });
  await assert.rejects(
    () => service.cancel(context("admin_operator_cskh_dt"), ORDER_ID, {
      reason: "Khach hang yeu cau huy don qua hotline", expectedVersion: 1
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 403 && error.code === "RBAC_DENIED"
  );
});

test("payment resolution validates versions and decision", async () => {
  const service = createOrderService({ repository: { resolvePayment: async () => ({}) } });
  await assert.rejects(
    () => service.resolvePayment(context("super_admin"), ORDER_ID, PAYMENT_ID, {
      decision: "refund", reason: "Doi soat giao dich thanh toan thu cong", expectedOrderVersion: 1, expectedPaymentVersion: 1
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.details.decision.length === 1
  );
  await assert.rejects(
    () => service.resolvePayment(context("super_admin"), ORDER_ID, PAYMENT_ID, {
      decision: "mark_paid", reason: "Doi soat giao dich thanh toan thu cong", expectedOrderVersion: 0, expectedPaymentVersion: 1
    }, { ipAddress: "127.0.0.1" }),
    (error) => error.status === 422 && error.details.expectedOrderVersion.length === 1
  );
});

function context(roleCode) {
  return {
    authUser: { id: "auth-1" },
    profile: { user_id: "actor-1", is_active: true },
    isAdmin: true,
    roleCode,
    accessToken: "valid-token"
  };
}
