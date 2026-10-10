import test from "node:test";
import assert from "node:assert/strict";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";

const RETURN_ID = "50000000-0000-4000-8000-000000000001";
const TICKET_ID = "50000000-0000-4000-8000-000000000002";

test("CSKH reads returns and approves a positive refund", async () => {
  let received;
  const service = createReturnService({ repository: {
    listReturns: async (filters, token) => { received = { filters, token }; return { rows: [] }; },
    getRefundableAmount: async () => 250000,
    approveRefund: async (_id, input) => input
  } });
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("limit=15"));
  assert.equal(received.filters.limit, 15);
  assert.equal(received.token, "jwt-token");
  const result = await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 100000, adminNote: "Da doi soat", expectedVersion: 3 });
  assert.equal(result.refundAmount, 100000);
});

test("order operator is read-only and invalid refunds are rejected", async () => {
  const service = createReturnService({ repository: { approveRefund: async () => ({}), getRefundableAmount: async () => 250000 } });
  await assert.rejects(() => service.approveRefund(context("admin_operator_donhang"), RETURN_ID, { refundAmount: 1, expectedVersion: 1 }), (error) => error.status === 403);
  await assert.rejects(() => service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 0, expectedVersion: 1 }), (error) => error.status === 422);
});

test("refund defaults to the value of the returned items, not to a number typed by hand", async () => {
  let received;
  const service = createReturnService({
    repository: {
      getRefundableAmount: async () => 250000,
      approveRefund: async (_id, input) => {
        received = input;
        return input;
      }
    }
  });

  // Không gửi refundAmount: API tự điền theo giá trị hàng trả (UAT ADM-RET-01).
  await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { expectedVersion: 1 });
  assert.equal(received.refundAmount, 250000);
});

test("a refund larger than the returned goods is refused", async () => {
  const service = createReturnService({
    repository: { getRefundableAmount: async () => 250000, approveRefund: async () => ({}) }
  });

  await assert.rejects(
    () => service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 400000, expectedVersion: 1 }),
    (error) => error.status === 422 && error.code === "REFUND_EXCEEDS_ITEM_VALUE"
  );

  // Hoàn một phần vẫn hợp lệ: hàng hỏng một phần thì CSKH giảm số tiền xuống.
  await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 100000, expectedVersion: 1 });
});

test("a return cannot skip the physical steps between approval and completion", async () => {
  let wrote = false;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, status: "WAITING_RETURN", version: 5 }),
      updateReturnStatus: async (returnId, input) => {
        wrote = true;
        return { return_id: returnId, status: input.status };
      }
    }
  });
  const ctx = { authUser: { id: "admin-user-id" }, roleCode: "admin_operator_cskh_dt", ipAddress: "127.0.0.1", accessToken: "jwt-token" };

  // `approved` chỉ được đi tiếp sang `shipping_back`; nhảy thẳng sang hoàn tất là bỏ
  // qua cả bước nhận hàng lẫn bước kiểm tra tình trạng.
  await assert.rejects(
    () => service.updateReturnStatus(ctx, RETURN_ID, { status: "COMPLETED", expectedVersion: 5 }),
    (error) => error.status === 422 && error.code === "INVALID_TRANSITION"
  );
  assert.equal(wrote, false);

  await service.updateReturnStatus(ctx, RETURN_ID, { status: "RETURN_IN_TRANSIT", trackingReturnCode:"RETURN-SHIP-001", expectedVersion: 5 });
  assert.equal(wrote, true);
});

test("service audit logs are protected by the A05 reader matrix", async () => {
  // Bắt tham số qua closure chứ không qua giá trị trả về: service còn enrich lại
  // payload trước khi trả, nên dùng kết quả để dò tham số sẽ hỏng.
  let received;
  const service = createReturnService({
    repository: {
      listAuditLogs: async (filters, token) => {
        received = { filters, token };
        return { rows: [], count: 0 };
      }
    }
  });
  await service.listAuditLogs(context("admin_operator_donhang"), new URLSearchParams("limit=500&offset=-2"));
  assert.equal(received.filters.limit, 500);
  assert.equal(received.filters.offset, 0);
  assert.equal(received.token, "jwt-token");
});

test("updateReturnStatus validates status and enforces permissions", async () => {
  let receivedInput;
  const service = createReturnService({ repository: {
    getReturn: async () => ({ return_id: RETURN_ID, status: "WAITING_RETURN", version: 5 }),
    updateReturnStatus: async (returnId, input, actorId, roleCode, ipAddress) => {
      receivedInput = { returnId, input, actorId, roleCode, ipAddress };
      return { return_id: returnId, status: input.status };
    }
  } });

  // 1. Authorized CSKH operator can transition status
  const ctx = { authUser: { id: "admin-user-id" }, roleCode: "admin_operator_cskh_dt", ipAddress: "127.0.0.1", accessToken: "jwt-token" };
  const res = await service.updateReturnStatus(ctx, RETURN_ID, { status: "RETURN_IN_TRANSIT", trackingReturnCode:"RETURN-SHIP-001", expectedVersion: 5, adminNote: "Updating status" });
  assert.equal(res.status, "RETURN_IN_TRANSIT");
  assert.equal(receivedInput.input.status, "RETURN_IN_TRANSIT");
  assert.equal(receivedInput.input.expectedVersion, 5);
  assert.equal(receivedInput.actorId, "admin-user-id");

  // 2. Reject invalid status
  await assert.rejects(() => service.updateReturnStatus(ctx, RETURN_ID, { status: "invalid_status", expectedVersion: 5 }), (error) => error.status === 422);

  // 3. Reject missing expectedVersion
  await assert.rejects(() => service.updateReturnStatus(ctx, RETURN_ID, { status: "RETURN_IN_TRANSIT" }), (error) => error.status === 422);

  // 4. Unauthorized role is blocked
  const badCtx = { authUser: { id: "other-user" }, roleCode: "admin_operator_donhang", ipAddress: "127.0.0.1", accessToken: "jwt-token" };
  await assert.rejects(() => service.updateReturnStatus(badCtx, RETURN_ID, { status: "RETURN_IN_TRANSIT", trackingReturnCode:"RETURN-SHIP-001", expectedVersion: 5 }), (error) => error.status === 403);
});

test("a support ticket cannot jump straight from open to resolved", async () => {
  let wrote = false;
  const service = createReturnService({
    repository: {
      getTicket: async () => ({ ticket_id: TICKET_ID, status: "open", version: 2 }),
      updateTicketStatus: async (ticketId, input) => {
        wrote = true;
        return { ticket_id: ticketId, status: input.status };
      }
    }
  });
  const ctx = context("admin_operator_cskh_dt");

  // `open` chỉ đi được sang `processing` hoặc `closed`. Kết luận "đã giải quyết" một
  // phiếu chưa ai nhận xử lý là bỏ qua toàn bộ phần làm việc ở giữa.
  await assert.rejects(
    () => service.resolveTicket(ctx, TICKET_ID, { expectedVersion: 2 }),
    (error) => error.status === 422 && error.code === "INVALID_TRANSITION"
  );
  assert.equal(wrote, false);
});

test("resolving a ticket in processing is the path that fills the dead 'resolved' label", async () => {
  let received;
  const service = createReturnService({
    repository: {
      getTicket: async () => ({ ticket_id: TICKET_ID, status: "processing", version: 4 }),
      updateTicketStatus: async (ticketId, input) => {
        received = { ticketId, input };
        return { ticket_id: ticketId, status: input.status };
      }
    }
  });

  const result = await service.resolveTicket(context("admin_operator_cskh_dt"), TICKET_ID, {
    expectedVersion: 4,
    adminNote: "Da hoan tien cho khach"
  });

  assert.equal(result.status, "resolved");
  assert.equal(received.input.status, "resolved");
  assert.equal(received.input.expectedVersion, 4);
  assert.equal(received.input.adminNote, "Da hoan tien cho khach");
});

test("a closed ticket cannot be reopened by replying to it", async () => {
  let wrote = false;
  const service = createReturnService({
    repository: {
      getTicket: async () => ({ ticket_id: TICKET_ID, status: "closed", version: 9 }),
      respondTicket: async () => {
        wrote = true;
        return {};
      }
    }
  });

  await assert.rejects(
    () => service.respondTicket(context("admin_operator_cskh_dt"), TICKET_ID, { response: "Xin loi anh/chi", expectedVersion: 9 }),
    (error) => error.status === 422 && error.code === "INVALID_TRANSITION"
  );
  assert.equal(wrote, false);
});

test("replying twice to the same processing ticket is not a transition and stays allowed", async () => {
  let calls = 0;
  const service = createReturnService({
    repository: {
      getTicket: async () => ({ ticket_id: TICKET_ID, status: "processing", version: 3 }),
      respondTicket: async () => {
        calls += 1;
        return {};
      }
    }
  });
  const ctx = context("admin_operator_cskh_dt");

  await service.respondTicket(ctx, TICKET_ID, { response: "Da tiep nhan", expectedVersion: 3 });
  await service.respondTicket(ctx, TICKET_ID, { response: "Dang cho kho kiem tra", expectedVersion: 4 });
  assert.equal(calls, 2);
});

test("linked chatbot tickets cannot bypass filtered replies, ownership or case lifecycle", async () => {
  const writes: string[] = [];
  const service = createReturnService({
    repository: {
      getTicket: async () => ({
        ticket_id: TICKET_ID, status: "processing", version: 3,
        chat_session_id: "60000000-0000-4000-8000-000000000001"
      }),
      assignTicket: async () => { writes.push("assign"); },
      respondTicket: async () => { writes.push("reply"); },
      closeTicket: async () => { writes.push("close"); },
      updateTicketStatus: async () => { writes.push("resolve"); }
    }
  });
  const staff = context("admin_operator_cskh_dt");
  for (const mutate of [
    () => service.assignTicket(staff, TICKET_ID, { assignedTo: staff.authUser.id, expectedVersion: 3 }),
    () => service.respondTicket(staff, TICKET_ID, { response: "Unfiltered staff reply", expectedVersion: 3 }),
    () => service.closeTicket(staff, TICKET_ID, { reason: "Close outside case", expectedVersion: 3 }),
    () => service.resolveTicket(staff, TICKET_ID, { adminNote: "Resolve outside case", expectedVersion: 3 })
  ]) {
    await assert.rejects(mutate, (error) => error.status === 409 && error.code === "CHAT_TICKET_GOVERNED");
  }
  assert.deepEqual(writes, []);
});

test("approving a refund records approval and never transfers money before warehouse QA", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getRefundableAmount: async () => 350000,
      approveRefund: async (_id, input) => ({ order_id: "order-123", refund_amount: input.refundAmount }),
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-123", status: "REQUESTED", version: 1 })
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  const res = await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 300000, expectedVersion: 1 });
  assert.equal(refundCall, null);
  assert.equal(res.refund, null);
});

test("a return cannot complete before gateway-confirmed refund", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-456", status: "RECEIVED", refund_amount: 500000, version: 3 }),
      getRefundableAmount: async () => 500000,
      getPaymentByOrderId: async () => ({ payment_provider: "stripe" }),
      updateReturnStatus: async (_id, input) => ({ status: input.status, order_id: "order-456" })
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  await assert.rejects(() => service.updateReturnStatus(context("admin_operator_cskh_dt"), RETURN_ID, {status:"COMPLETED",expectedVersion:3}), error => error.code === "INVALID_TRANSITION");
  assert.equal(refundCall,null);
});

test("triggerStripeRefund manually executes payment refund gateway", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-789", status: "RECEIVED",condition_check_result:"qa_pass", return_type:"refund", refund_amount: 200000, version: 4 }),
      getRefundableAmount:async()=>200000,
      getPaymentByOrderId:async()=>({payment_provider:"stripe"})
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  const res = await service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 200000, expectedVersion:4 });
  assert.equal(refundCall?.orderId, "order-789");
  assert.equal(refundCall?.amount, 200000);
  assert.equal(res.success, true);
});

test("triggerStripeRefund throws STRIPE_REFUND_FAILED when gateway refund fails", async () => {
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-fail", status: "RECEIVED", condition_check_result: "qa_pass", return_type: "refund", refund_amount: 200000, version: 2 }),
      getRefundableAmount: async () => 200000,
      getPaymentByOrderId: async () => ({ payment_provider: "stripe" })
    },
    refunds: {
      refund: async () => ({ status: "failed", message: "Stripe card expired" })
    }
  });

  await assert.rejects(
    () => service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, { expectedVersion: 2 }),
    (error: any) => error.status === 422 && error.code === "STRIPE_REFUND_FAILED" && error.message.includes("Stripe card expired")
  );
});

test("recordManualRefund supports COD, MoMo, VNPay and auto-syncs pending COD payment to paid", async () => {
  let paidPaymentId: string | null = null;
  let recordedRefund: any = null;

  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-cod", status: "RECEIVED", condition_check_result: "qa_pass", return_type: "refund", version: 3 }),
      getPaymentByOrderId: async () => ({ payment_id: "pay-cod-1", payment_method: "COD", payment_provider: "cod", payment_status: "pending" }),
      markPaymentPaid: async (paymentId: string) => { paidPaymentId = paymentId; return []; },
      recordManualRefund: async (returnId: string, version: number, reference: string, proof: string, actorId: string, ipAddress?: string, adminNote?: string) => {
        recordedRefund = { returnId, version, reference, proof, actorId, ipAddress, adminNote };
        return { return_id: returnId, status: "REFUNDED" };
      }
    }
  });

  const res = await service.recordManualRefund(context("admin_operator_cskh_dt"), RETURN_ID, {
    expectedVersion: 3,
    transferReference: "VCB2026100501",
    imageProof: "https://example.com/receipt.png",
    adminNote: "Da hoan tien vao tai khoan Vietcombank cua khach"
  });

  assert.equal(paidPaymentId, "pay-cod-1");
  assert.equal(recordedRefund.reference, "VCB2026100501");
  assert.equal(recordedRefund.adminNote, "Da hoan tien vao tai khoan Vietcombank cua khach");
  assert.equal(res.status, "REFUNDED");
});

test("recordManualRefund rejects invalid reference, proof, or stripe payment", async () => {
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-stripe", status: "RECEIVED", condition_check_result: "qa_pass", return_type: "refund", version: 1 }),
      getPaymentByOrderId: async () => ({ payment_id: "pay-str-1", payment_method: "ONLINE_PAYMENT", payment_provider: "stripe", payment_status: "paid" })
    }
  });

  // Stripe order must not use manual refund
  await assert.rejects(
    () => service.recordManualRefund(context("admin_operator_cskh_dt"), RETURN_ID, {
      expectedVersion: 1,
      transferReference: "VCB2026100501",
      imageProof: "https://example.com/receipt.png"
    }),
    (error: any) => error.status === 422 && error.code === "CAPTURED_NON_STRIPE_REQUIRED"
  );
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }
