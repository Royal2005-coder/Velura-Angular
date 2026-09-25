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
      getReturn: async () => ({ return_id: RETURN_ID, status: "approved", version: 5 }),
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
    () => service.updateReturnStatus(ctx, RETURN_ID, { status: "completed", expectedVersion: 5 }),
    (error) => error.status === 422 && error.code === "INVALID_TRANSITION"
  );
  assert.equal(wrote, false);

  await service.updateReturnStatus(ctx, RETURN_ID, { status: "shipping_back", expectedVersion: 5 });
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
    getReturn: async () => ({ return_id: RETURN_ID, status: "approved", version: 5 }),
    updateReturnStatus: async (returnId, input, actorId, roleCode, ipAddress) => {
      receivedInput = { returnId, input, actorId, roleCode, ipAddress };
      return { return_id: returnId, status: input.status };
    }
  } });

  // 1. Authorized CSKH operator can transition status
  const ctx = { authUser: { id: "admin-user-id" }, roleCode: "admin_operator_cskh_dt", ipAddress: "127.0.0.1", accessToken: "jwt-token" };
  const res = await service.updateReturnStatus(ctx, RETURN_ID, { status: "shipping_back", expectedVersion: 5, adminNote: "Updating status" });
  assert.equal(res.status, "shipping_back");
  assert.equal(receivedInput.input.status, "shipping_back");
  assert.equal(receivedInput.input.expectedVersion, 5);
  assert.equal(receivedInput.actorId, "admin-user-id");

  // 2. Reject invalid status
  await assert.rejects(() => service.updateReturnStatus(ctx, RETURN_ID, { status: "invalid_status", expectedVersion: 5 }), (error) => error.status === 422);

  // 3. Reject missing expectedVersion
  await assert.rejects(() => service.updateReturnStatus(ctx, RETURN_ID, { status: "shipping_back" }), (error) => error.status === 422);

  // 4. Unauthorized role is blocked
  const badCtx = { authUser: { id: "other-user" }, roleCode: "admin_operator_donhang", ipAddress: "127.0.0.1", accessToken: "jwt-token" };
  await assert.rejects(() => service.updateReturnStatus(badCtx, RETURN_ID, { status: "shipping_back", expectedVersion: 5 }), (error) => error.status === 403);
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

test("approving a refund triggers payment refund gateway with orderId and requested amount", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getRefundableAmount: async () => 350000,
      approveRefund: async (_id, input) => ({ order_id: "order-123", refund_amount: input.refundAmount }),
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-123", status: "pending", version: 1 })
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  const res = await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 300000, expectedVersion: 1 });
  assert.equal(refundCall?.orderId, "order-123");
  assert.equal(refundCall?.amount, 300000);
  assert.deepEqual(res.refund, { status: "refunded" });
});

test("completing a return triggers payment refund gateway if applicable", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-456", status: "received", refund_amount: 500000, version: 3 }),
      updateReturnStatus: async (_id, input) => ({ status: input.status, order_id: "order-456" })
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  await service.updateReturnStatus(context("admin_operator_cskh_dt"), RETURN_ID, { status: "completed", expectedVersion: 3 });
  assert.equal(refundCall?.orderId, "order-456");
  assert.equal(refundCall?.amount, 500000);
});

test("triggerStripeRefund manually executes payment refund gateway", async () => {
  let refundCall: { orderId: string; amount?: number } | null = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => ({ return_id: RETURN_ID, order_id: "order-789", status: "completed", refund_amount: 200000, version: 4 })
    },
    refunds: {
      refund: async (orderId, amount) => {
        refundCall = { orderId, amount };
        return { status: "refunded" };
      }
    }
  });

  const res = await service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 200000 });
  assert.equal(refundCall?.orderId, "order-789");
  assert.equal(refundCall?.amount, 200000);
  assert.equal(res.success, true);
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }
