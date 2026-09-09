import test from "node:test";
import assert from "node:assert/strict";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";

const RETURN_ID = "50000000-0000-4000-8000-000000000001";

test("CSKH reads returns and approves a positive refund", async () => {
  let received;
  const service = createReturnService({ repository: {
    listReturns: async (filters, token) => { received = { filters, token }; return { rows: [] }; },
    approveRefund: async (_id, input) => input
  } });
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("limit=15"));
  assert.equal(received.filters.limit, 15);
  assert.equal(received.token, "jwt-token");
  const result = await service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 100000, adminNote: "Da doi soat", expectedVersion: 3 });
  assert.equal(result.refundAmount, 100000);
});

test("order operator is read-only and invalid refunds are rejected", async () => {
  const service = createReturnService({ repository: { approveRefund: async () => ({}) } });
  await assert.rejects(() => service.approveRefund(context("admin_operator_donhang"), RETURN_ID, { refundAmount: 1, expectedVersion: 1 }), (error) => error.status === 403);
  await assert.rejects(() => service.approveRefund(context("admin_operator_cskh_dt"), RETURN_ID, { refundAmount: 0, expectedVersion: 1 }), (error) => error.status === 422);
});

test("service audit logs are protected by the A05 reader matrix", async () => {
  const service = createReturnService({ repository: { listAuditLogs: async (filters, token) => ({ filters, token }) } });
  const result = await service.listAuditLogs(context("admin_operator_donhang"), new URLSearchParams("limit=500&offset=-2"));
  assert.equal(result.filters.limit, 500);
  assert.equal(result.filters.offset, 0);
  assert.equal(result.token, "jwt-token");
});

test("updateReturnStatus validates status and enforces permissions", async () => {
  let receivedInput;
  const service = createReturnService({ repository: {
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

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }
