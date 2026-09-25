import test from "node:test";
import assert from "node:assert/strict";
import { createOrderService, validateActionInput } from "../../apps/api/src/orders/order-service.js";

const ORDER_ID = "50000000-0000-4000-8000-000000000001";
const PAYMENT_ID = "60000000-0000-4000-8000-000000000001";

/** Repository giả: ghi lại lệnh action, trả đơn ở trạng thái cho trước. */
function repository(order, extra = {}) {
  const calls = { actions: [], service: [] };
  return {
    calls,
    repo: {
      list: async () => ({ rows: [order], count: 1 }),
      tagsFor: async () => ({ [ORDER_ID]: ["REVIEW_OVERDUE"] }),
      findById: async () => order,
      performAction: async (_id, input) => { calls.actions.push(input); return { order, refund_required: false }; },
      serviceAction: async (_id, input) => { calls.service.push(input); return { order }; },
      countByStatus: async (statuses) => Object.fromEntries(statuses.map((s) => [s, s === "pending" ? 4 : 0])),
      countAttention: async () => 5,
      ...extra
    }
  };
}

const pendingCod = { order_id: ORDER_ID, status: "pending", payment_method: "COD", version: 3, payments: [] };

test("order reader can list production orders; every row carries label, tags and allowed actions", async () => {
  const { repo } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  const result = await service.list(context("admin_operator_donhang"), new URLSearchParams("status=pending&limit=10"));
  const row = result.rows[0];
  assert.equal(row.status_label, "Chờ xác nhận");
  assert.deepEqual(row.tags, [{ code: "REVIEW_OVERDUE", label: "Quá hạn duyệt" }]);
  assert.deepEqual(row.allowed_actions.map((a) => a.code), ["call_confirm", "confirm_cod", "cancel"]);
});

test("customer service reads orders but gets no write action (KAN-60 §1)", async () => {
  const { repo } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  const result = await service.list(context("admin_operator_cskh_dt"), new URLSearchParams());
  assert.deepEqual(result.rows[0].allowed_actions, []);
});

test("unrelated and viewer roles cannot read orders", async () => {
  const { repo } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  for (const role of ["admin_operator_sanpham", "admin_viewer"]) {
    await assert.rejects(
      () => service.list(context(role), new URLSearchParams()),
      (error) => error.status === 403 && error.code === "RBAC_DENIED"
    );
  }
});

test("the old status filter values are rejected", async () => {
  const { repo } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  for (const status of ["preparing", "failed_delivery", "completed"]) {
    await assert.rejects(() => service.list(context("super_admin"), new URLSearchParams(`status=${status}`)), (error) => error.status === 422);
  }
});

test("AC-02: CSKH cannot perform an order action even by calling the API directly", async () => {
  const { repo, calls } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  await assert.rejects(
    () => service.performAction(context("admin_operator_cskh_dt"), ORDER_ID, "confirm_cod", { note: "Xác nhận đơn", expectedVersion: 3 }, meta()),
    (error) => error.status === 403
  );
  assert.equal(calls.actions.length, 0);
});

test("AC-03: an action not valid for the current state is rejected before the RPC", async () => {
  const { repo, calls } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  await assert.rejects(
    () => service.performAction(context("admin_operator_donhang"), ORDER_ID, "confirm_handover", { note: "Đã bàn giao", expectedVersion: 3 }, meta()),
    (error) => error.status === 422 && error.code === "INVALID_ORDER_ACTION"
  );
  assert.equal(calls.actions.length, 0);
});

test("admins cannot trigger system actions such as a delivery result", async () => {
  const { repo, calls } = repository({ ...pendingCod, status: "shipping" });
  const service = createOrderService({ repository: repo });
  await assert.rejects(
    () => service.performAction(context("super_admin"), ORDER_ID, "carrier_delivered", { note: "Đã giao", expectedVersion: 3 }, meta()),
    (error) => error.code === "UNKNOWN_ORDER_ACTION"
  );
  assert.equal(calls.actions.length, 0);
});

test("AC-17: a manual action without a note is rejected", () => {
  assert.throws(() => validateActionInput("confirm_cod", { expectedVersion: 1 }), (error) => error.code === "NOTE_REQUIRED");
});

test("call confirmation needs one of the three results (KAN-60 §3.1)", () => {
  assert.throws(() => validateActionInput("call_confirm", { note: "Đã gọi", callResult: "busy", expectedVersion: 1 }),
    (error) => error.code === "CALL_RESULT_REQUIRED");
  const input = validateActionInput("call_confirm", { note: "Đã gọi", callResult: "no_answer", expectedVersion: 1 });
  assert.deepEqual(input.payload, { call_result: "no_answer" });
});

test("shipment needs a carrier and a waybill code; tracking links must be https", () => {
  assert.throws(() => validateActionInput("upsert_shipment", { note: "Tạo vận đơn", carrier: "GHN", expectedVersion: 1 }),
    (error) => error.code === "TRACKING_CODE_REQUIRED");
  assert.throws(() => validateActionInput("upsert_shipment", { note: "Tạo vận đơn", trackingCode: "GHN1", expectedVersion: 1 }),
    (error) => error.status === 422);
  assert.throws(() => validateActionInput("upsert_shipment", { note: "Tạo vận đơn", carrier: "GHN", trackingCode: "GHN1", trackingUrl: "javascript:alert(1)", expectedVersion: 1 }),
    (error) => error.status === 422);
  const ok = validateActionInput("upsert_shipment", { note: "Tạo vận đơn", carrier: "GHN", trackingCode: "GHN1", trackingUrl: "https://ghn.vn/t/GHN1", expectedVersion: 1 });
  assert.deepEqual(ok.payload, { tracking_code: "GHN1", carrier: "GHN", tracking_url: "https://ghn.vn/t/GHN1" });
});

test("cancel needs a listed reason; 'other' takes the note as the reason", () => {
  assert.throws(() => validateActionInput("cancel", { note: "Huỷ đơn", expectedVersion: 1 }), (error) => error.code === "CANCEL_REASON_REQUIRED");
  const other = validateActionInput("cancel", { note: "Khách gọi báo đặt nhầm size", cancelReason: "other", expectedVersion: 1 });
  assert.equal(other.payload.cancel_reason, "Khách gọi báo đặt nhầm size");
});

test("a valid action goes to the RPC with note, payload and the expected version", async () => {
  const { repo, calls } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  const result = await service.performAction(context("admin_operator_donhang"), ORDER_ID, "call_confirm",
    { note: "Khách xác nhận địa chỉ", callResult: "reached", expectedVersion: 3 }, meta());
  assert.equal(calls.actions[0].action, "call_confirm");
  assert.equal(calls.actions[0].expectedVersion, 3);
  assert.deepEqual(calls.actions[0].payload, { call_result: "reached" });
  assert.equal(result.refund, null);
});

test("cancelling a paid order asks the refund gateway once", async () => {
  let refunds = 0;
  const { repo } = repository(pendingCod, {
    performAction: async () => ({ order: pendingCod, refund_required: true })
  });
  const service = createOrderService({ repository: repo, refunds: { refund: async () => { refunds += 1; return { status: "requested" }; } } });
  const result = await service.performAction(context("super_admin"), ORDER_ID, "cancel",
    { note: "Khách yêu cầu huỷ", cancelReason: "customer_request", expectedVersion: 3 }, meta());
  assert.equal(refunds, 1);
  assert.deepEqual(result.refund, { status: "requested" });
});

test("carrier simulation is super_admin only and maps outcomes to system actions", async () => {
  const shipping = { ...pendingCod, status: "shipping", tracking_code: "GHN1", handed_over_at: "2026-09-25" };
  const { repo, calls } = repository(shipping);
  const service = createOrderService({ repository: repo });
  await assert.rejects(() => service.simulateCarrier(context("admin_operator_donhang"), ORDER_ID, { outcome: "delivered" }),
    (error) => error.code === "CARRIER_SIMULATION_DENIED");
  await assert.rejects(() => service.simulateCarrier(context("super_admin"), ORDER_ID, { outcome: "lost" }), (error) => error.status === 422);
  await service.simulateCarrier(context("super_admin"), ORDER_ID, { outcome: "failed_retrying" });
  assert.equal(calls.service[0].action, "carrier_failed_retrying");
});

test("summary counts come from the database for all eight states", async () => {
  const { repo } = repository(pendingCod);
  const service = createOrderService({ repository: repo });
  const summary = await service.summary(context("admin_operator_cskh_dt"));
  assert.equal(summary.by_status.length, 8);
  assert.equal(summary.by_status.find((row) => row.status === "pending").count, 4);
  assert.equal(summary.attention, 5);
});

test("payment resolution validates versions and decision", async () => {
  const { repo } = repository(pendingCod, { resolvePayment: async () => ({}) });
  const service = createOrderService({ repository: repo });
  await assert.rejects(
    () => service.resolvePayment(context("super_admin"), ORDER_ID, PAYMENT_ID, {
      decision: "refund", reason: "Doi soat giao dich thanh toan thu cong", expectedOrderVersion: 1, expectedPaymentVersion: 1
    }, meta()),
    (error) => error.status === 422 && error.details.decision.length === 1
  );
  await assert.rejects(
    () => service.resolvePayment(context("super_admin"), ORDER_ID, PAYMENT_ID, {
      decision: "mark_paid", reason: "Doi soat giao dich thanh toan thu cong", expectedOrderVersion: 0, expectedPaymentVersion: 1
    }, meta()),
    (error) => error.status === 422 && error.details.expectedOrderVersion.length === 1
  );
});

function meta() {
  return { ipAddress: "127.0.0.1" };
}

function context(roleCode) {
  return {
    authUser: { id: "auth-1" },
    profile: { user_id: "actor-1", is_active: true },
    isAdmin: true,
    roleCode,
    accessToken: "valid-token"
  };
}
