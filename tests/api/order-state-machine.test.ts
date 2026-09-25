import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  customerOrderSteps,
  ORDER_ACTIONS,
  ORDER_STATUSES,
  actionGuard,
  allowedAdminActions,
  customerCanCancel,
  orderFacts
} from "../../apps/api/src/orders/order-state-machine.js";

function facts(overrides = {}) {
  return {
    status: "pending",
    paymentMethod: "COD",
    trackingCode: null,
    shipmentVoidedAt: null,
    handedOverAt: null,
    returnedToStockAt: null,
    paymentStatus: null,
    refundFailed: false,
    ...overrides
  };
}

const codes = (list) => list.map((action) => action.code);

test("the SQL rule table in migration 038 matches ORDER_ACTIONS exactly", async () => {
  // RPC kiểm lại quy tắc trong cơ sở dữ liệu. Hai bản phải là một, nếu không admin sẽ
  // thấy nút mà bấm vào lại bị từ chối, hoặc ngược lại.
  const sql = await readFile(new URL("../../database/migrations/038_order_actions.sql", import.meta.url), "utf8");
  const match = sql.match(/select '(\[[\s\S]*?\])'::jsonb\s*\$rules\$/);
  assert.ok(match, "không tìm thấy bảng quy tắc trong 038");
  const rules = JSON.parse(match[1]);
  const fromTs = ORDER_ACTIONS.map((a) => ({ code: a.code, actor: a.actor, from: [...a.from], to: a.to, requiresNote: a.requiresNote }));
  assert.deepEqual(rules, fromTs);
});

test("every state in the table is one of the eight KAN-59 states", () => {
  for (const action of ORDER_ACTIONS) {
    for (const from of action.from) assert.ok(ORDER_STATUSES.includes(from), `${action.code} from ${from}`);
    if (action.to) assert.ok(ORDER_STATUSES.includes(action.to), `${action.code} to ${action.to}`);
  }
  assert.equal(ORDER_STATUSES.length, 8);
  assert.ok(!ORDER_STATUSES.includes("completed"));
});

test("KAN-59 pending COD: call, confirm, cancel — and call never changes state", () => {
  const actions = allowedAdminActions(facts(), "admin_operator_donhang");
  assert.deepEqual(codes(actions), ["call_confirm", "confirm_cod", "cancel"]);
  assert.equal(actions.find((a) => a.code === "call_confirm").to_status, null);
  assert.equal(actions.find((a) => a.code === "cancel").destructive, true);
});

test("FR-04: an online order cannot be confirmed with the COD action", () => {
  assert.equal(actionGuard("confirm_cod", facts({ paymentMethod: "ONLINE_PAYMENT" })), "COD_ONLY");
  // Đơn online Chờ thanh toán: admin chỉ còn Huỷ; xác nhận là việc của System.
  assert.deepEqual(codes(allowedAdminActions(facts({ status: "waiting_payment", paymentMethod: "ONLINE_PAYMENT" }), "super_admin")), ["cancel"]);
});

test("KAN-59 confirmed and processing: preparation steps and handover guard (AC-11/12)", () => {
  assert.deepEqual(codes(allowedAdminActions(facts({ status: "confirmed" }), "super_admin")), ["start_processing", "cancel"]);
  const noShipment = codes(allowedAdminActions(facts({ status: "processing" }), "super_admin"));
  assert.deepEqual(noShipment, ["record_shortage", "upsert_shipment", "cancel"]);
  assert.equal(actionGuard("confirm_handover", facts({ status: "processing" })), "TRACKING_CODE_REQUIRED");
  const withShipment = codes(allowedAdminActions(facts({ status: "processing", trackingCode: "GHN123" }), "super_admin"));
  assert.deepEqual(withShipment, ["record_shortage", "upsert_shipment", "confirm_handover", "cancel"]);
  assert.equal(actionGuard("confirm_handover", facts({ status: "processing", trackingCode: "GHN123", shipmentVoidedAt: "2026-09-25" })), "SHIPMENT_VOIDED");
});

test("KAN-59 shipping: only notes and tracking, no cancel, no manual delivery result (AC-13, FR-07)", () => {
  const actions = codes(allowedAdminActions(facts({ status: "shipping", trackingCode: "GHN123", handedOverAt: "2026-09-25" }), "super_admin"));
  assert.deepEqual(actions, ["carrier_note", "update_tracking"]);
  assert.equal(actionGuard("cancel", facts({ status: "shipping" })), "INVALID_ORDER_ACTION");
  assert.equal(actionGuard("cancel", facts({ status: "processing", handedOverAt: "2026-09-25" })), "ORDER_ALREADY_HANDED_OVER");
});

test("OPEN-03: delivery_failed offers failure reason and a one-time return to stock", () => {
  assert.deepEqual(codes(allowedAdminActions(facts({ status: "delivery_failed" }), "super_admin")),
    ["record_failure_reason", "confirm_return_to_stock"]);
  assert.deepEqual(codes(allowedAdminActions(facts({ status: "delivery_failed", returnedToStockAt: "2026-09-25" }), "super_admin")),
    ["record_failure_reason"]);
});

test("delivered and cancelled have no state-changing action; OPEN-02 retry only after a failed refund", () => {
  assert.deepEqual(allowedAdminActions(facts({ status: "delivered" }), "super_admin"), []);
  assert.deepEqual(allowedAdminActions(facts({ status: "cancelled" }), "super_admin"), []);
  assert.deepEqual(codes(allowedAdminActions(facts({ status: "cancelled", paymentStatus: "refund_pending", refundFailed: true }), "super_admin")),
    ["retry_refund"]);
});

test("KAN-60 §1: customer service and viewers see no write action at all", () => {
  assert.deepEqual(allowedAdminActions(facts(), "admin_operator_cskh_dt"), []);
  assert.deepEqual(allowedAdminActions(facts(), "admin_viewer"), []);
  assert.deepEqual(allowedAdminActions(facts(), undefined), []);
});

test("BR-03: the customer may cancel up to confirmed, never from processing", () => {
  assert.equal(customerCanCancel(facts({ status: "pending" })), true);
  assert.equal(customerCanCancel(facts({ status: "waiting_payment", paymentMethod: "ONLINE_PAYMENT" })), true);
  assert.equal(customerCanCancel(facts({ status: "confirmed" })), true);
  assert.equal(customerCanCancel(facts({ status: "processing" })), false);
  assert.equal(customerCanCancel(facts({ status: "shipping" })), false);
});

test("system-only actions are never offered to an admin", () => {
  const systemCodes = ORDER_ACTIONS.filter((a) => a.actor !== "order_admin").map((a) => a.code);
  for (const status of ORDER_STATUSES) {
    const offered = codes(allowedAdminActions(facts({ status, trackingCode: "X" }), "super_admin"));
    for (const code of systemCodes) assert.ok(!offered.includes(code), `${code} offered at ${status}`);
  }
});

test("orderFacts reads the latest payment and the REFUND_FAILED marker", () => {
  const read = orderFacts({
    status: "cancelled",
    payment_method: "ONLINE_PAYMENT",
    payments: [
      { payment_status: "failed", created_at: "2026-09-20T00:00:00Z" },
      { payment_status: "refund_pending", gateway_response_code: "REFUND_FAILED", created_at: "2026-09-24T00:00:00Z" }
    ]
  });
  assert.equal(read.paymentStatus, "refund_pending");
  assert.equal(read.refundFailed, true);
});

test("customer steps: passed milestones from history, then the rest of the normal path", () => {
  const steps = customerOrderSteps("confirmed", "COD", [
    { status: "pending", at: "2026-09-24 03:00:00" },
    { status: "confirmed", at: "2026-09-24 09:00:00" }
  ]);
  assert.deepEqual(steps.map((step) => [step.status, step.state]), [
    ["pending", "done"],
    ["confirmed", "current"],
    ["processing", "upcoming"],
    ["shipping", "upcoming"],
    ["delivered", "upcoming"]
  ]);
});

test("customer steps: online orders start at waiting for payment", () => {
  const steps = customerOrderSteps("waiting_payment", "ONLINE_PAYMENT", []);
  assert.equal(steps[0].status, "waiting_payment");
  assert.equal(steps[0].state, "current");
  assert.equal(steps[1].status, "confirmed");
});

test("customer steps: a cancelled order shows what happened and nothing after it", () => {
  const steps = customerOrderSteps("cancelled", "COD", [
    { status: "pending", at: "2026-09-24 03:00:00" },
    { status: "cancelled", at: "2026-09-24 05:00:00" }
  ]);
  assert.deepEqual(steps.map((step) => [step.status, step.state]), [["pending", "done"], ["cancelled", "current"]]);
});

test("customer steps: a delivered order ends done; orders without history get only the current milestone", () => {
  const delivered = customerOrderSteps("delivered", "COD", [{ status: "delivered", at: "2026-09-25 03:00:00" }]);
  assert.deepEqual(delivered.map((step) => step.state), ["done"]);
  const legacy = customerOrderSteps("shipping", "COD", []);
  assert.deepEqual(legacy.map((step) => [step.status, step.state]), [["shipping", "current"], ["delivered", "upcoming"]]);
});

test("an online order that already has money is never cancelled for running out of time", () => {
  const facts = orderFacts({ status: "waiting_payment", payment_method: "ONLINE_PAYMENT", payments: [{ payment_status: "paid", created_at: "2026-09-25" }] });
  assert.equal(actionGuard("payment_expired", facts), "PAYMENT_ALREADY_PAID");
  assert.equal(actionGuard("payment_succeeded", facts), null);
});
