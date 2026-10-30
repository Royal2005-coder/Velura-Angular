import test from "node:test";
import assert from "node:assert/strict";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";
import type { ReturnListFilters, ReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { HttpError } from "../../apps/api/src/http.js";
import { asJsonObject, type JsonObject } from "../../apps/api/src/types.js";

/** Predicate for `assert.rejects`: an HttpError with the given stable code (and optional status). */
const hasCode = (code: string, status?: number) => (error: unknown): boolean =>
  error instanceof HttpError && error.code === code && (status === undefined || error.status === status);
const hasStatus = (status: number) => (error: unknown): boolean => error instanceof HttpError && error.status === status;

const RETURN_ID = "50000000-0000-4000-8000-000000000001";
const TICKET_ID = "50000000-0000-4000-8000-000000000002";

test("CSKH reads the return queue with paging and the caller's token", async () => {
  let received;
  const service = createReturnService({ repository: {
    listReturns: async (filters, token) => { received = { filters, token }; return { rows: [] }; }
  } });
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("limit=15"));
  assert.equal(received.filters.limit, 15);
  assert.equal(received.token, "jwt-token");
});

test("whole-request progression cannot bypass line actions", async () => {
  const service = createReturnService({ repository: {} as ReturnRepository });
  const admin = context("super_admin");
  for (const mutation of [
    service.reject, service.updateReturnStatus, service.createReturnShipment,
    service.confirmReturnPickup, service.updateReturnShipmentStatus, service.shipExchange
  ]) {
    await assert.rejects(() => mutation(admin, RETURN_ID, { expectedVersion: 1, status: "COMPLETED" }), hasCode("ITEM_ACTION_REQUIRED", 409));
  }
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

test("only super_admin can decide a line, while CSKH can operate approved lines", async () => {
  const calls: unknown[][] = [];
  const service = createReturnService({ repository: {
    listEvidence: async () => [
      { kind: 'packing_photo', uploaded_by_role: 'customer' },
      { kind: 'packing_video', uploaded_by_role: 'customer' }
    ],
    actOnItem: async (...args) => { calls.push(args); return { return_item_id: ITEM_ID }; }
  } as unknown as ReturnRepository });
  for (const action of ["approve", "reject"]) {
    await assert.rejects(() => service.actOnItem(context("admin_operator_cskh_dt"), RETURN_ID, ITEM_ID, {
      action, expectedVersion: 2, reason: "Da xac minh thong tin"
    }), hasCode("RBAC_DENIED", 403));
    await service.actOnItem(context("super_admin"), RETURN_ID, ITEM_ID, {
      action, expectedVersion: 2, reason: "Da xac minh thong tin"
    });
  }
  await service.actOnItem(context("admin_operator_cskh_dt"), RETURN_ID, ITEM_ID, { action: "wait_return", expectedVersion: 3 });
  assert.equal(calls.length, 3);
  await assert.rejects(() => service.actOnItem(context("admin_operator_donhang"), RETURN_ID, ITEM_ID, {
    action: "wait_return", expectedVersion: 3
  }), hasCode("RBAC_DENIED", 403));
});

test("partial line facts stay flat and false seal facts survive the service boundary", async () => {
  let received: unknown[] = [];
  const service = createReturnService({ repository: {
    actOnItem: async (...args) => { received = args; return { return_item_id: ITEM_ID }; }
  } as unknown as ReturnRepository });
  const facts = {
    quantity: 1, receivedQuantity: 1, matchesProduct: true, tagsIntact: true,
    conditionAcceptable: true, packageMatch: true, sealIntact: false,
    disposition: "restock", receiptProofRef: `storage://order-evidence/returns/${RETURN_ID}/qa_photo/proof.jpg`
  };
  await service.actOnItem(context("admin_operator_cskh_dt"), RETURN_ID, ITEM_ID, { action: "receive", expectedVersion: 7, ...facts });
  assert.deepEqual(received.slice(0, 6), [RETURN_ID, ITEM_ID, "receive", facts, 7, "auth-1"]);
  for (const quantity of [0, -1, 1.5, "1"]) {
    await assert.rejects(() => service.actOnItem(context("super_admin"), RETURN_ID, ITEM_ID, {
      action: "receive", expectedVersion: 7, ...facts, quantity
    }), hasCode("QTY_MISMATCH"));
  }
  await assert.rejects(() => service.actOnItem(context("super_admin"), RETURN_ID, ITEM_ID, {
    action: "receive", expectedVersion: 7, payload: facts
  }), hasCode("FLAT_ITEM_FACTS_REQUIRED"));
});

test("conversion requires a reason and explicit customer consent", async () => {
  const service = createReturnService({ repository: {
    actOnItem: async () => ({ resolution_type: "refund" })
  } as unknown as ReturnRepository });
  const admin = context("admin_operator_cskh_dt");
  await assert.rejects(() => service.actOnItem(admin, RETURN_ID, ITEM_ID, { action: "convert_refund", expectedVersion: 2 }), hasCode("REASON_REQUIRED"));
  await assert.rejects(() => service.actOnItem(admin, RETURN_ID, ITEM_ID, {
    action: "convert_refund", expectedVersion: 2, reason: "Khach dong y nhan hoan"
  }), hasCode("CUSTOMER_CONSENT_REQUIRED"));
  assert.equal((await service.actOnItem(admin, RETURN_ID, ITEM_ID, {
    action: "convert_refund", expectedVersion: 2, reason: "Khach dong y nhan hoan", customerConsent: true
  })).resolution_type, "refund");
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

const ITEM_ID = "50000000-0000-4000-8000-000000000003";
const REFUND_LINE = {
  return_item_id: ITEM_ID, order_item_id: "order-line", quantity: 1, version: 3,
  item_status: "RECEIVED", decision_status: "approved", resolution_type: "refund",
  received_quantity: 1, matches_product: true, tags_intact: true, condition_acceptable: true,
  package_match: true, seal_intact: false
};
const COD_RETURN = { return_id: RETURN_ID, order_id: "order-cod", status: "IN_PROGRESS", return_type: "refund", payment_method: "COD", version: 3 };
const COD_PAYMENT = { payment_id: "pay-cod-1", payment_method: "COD", payment_provider: "cod", payment_status: "paid" };
const MANUAL_BODY = {
  returnItemId: ITEM_ID, expectedVersion: 3, transferReference: "VCB2026100501", amount: 200000,
  transferredAt: new Date(Date.now() - 60_000).toISOString(),
  imageProof: `storage://order-evidence/returns/${RETURN_ID}/refund_proof/receipt.png`
};
const VALID_RECEIVER = { bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A", supplement_request: null };

test("Stripe refund targets the converted line using its version and amount, independent of the header", async () => {
  let refundCall: unknown[] = [];
  const service = createReturnService({
    repository: {
      getRefundOperation: async () => null,
      getReturn: async () => ({ ...COD_RETURN, return_type: "exchange", version: 19 }),
      listReturnLines: async () => ({ rows: [REFUND_LINE, { return_item_id: "other-part", item_status: "REQUESTED", version: 1 }] }),
      getItemRefundableAmount: async id => { assert.equal(id, ITEM_ID); return 200000; },
      getPaymentByOrderId: async () => ({ payment_provider: "stripe" })
    } as unknown as ReturnRepository,
    refunds: { refund: async (...args) => { refundCall = args; return { status: "requested" }; } }
  });
  const res = await service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, { returnItemId: ITEM_ID, expectedVersion: 3 });
  assert.deepEqual(refundCall, ["order-cod", 200000, RETURN_ID, 3, ITEM_ID]);
  assert.equal(res.success, true);
});

test("a successful Stripe refund is replayed on retry instead of failing the completed line version", async () => {
  let gatewayCalls = 0;
  const service = createReturnService({
    repository: {
      getRefundOperation: async () => ({ return_item_id: ITEM_ID, status: "succeeded", provider_ref: "re_123" })
    } as unknown as ReturnRepository,
    refunds: { refund: async () => { gatewayCalls++; return { status: "refunded" }; } }
  });
  const res = await service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, { returnItemId: ITEM_ID, expectedVersion: 3 });
  assert.equal(asJsonObject(res.refund).status, "refunded");
  assert.equal(res.idempotent, true);
  assert.equal(gatewayCalls, 0);
});

test("refund endpoints require a real line id, line version, approved refund resolution and receipt facts", async () => {
  let gatewayCalls = 0;
  const make = (line: JsonObject = REFUND_LINE) => createReturnService({
    repository: {
      getRefundOperation: async () => null,
      getManualRefund: async () => null,
      getReturn: async () => ({ ...COD_RETURN, status: "RECEIVED", version: 3 }),
      listReturnLines: async () => ({ rows: [line] })
    } as unknown as ReturnRepository,
    refunds: { refund: async () => { gatewayCalls++; return { status: "refunded" }; } }
  });
  const admin = context("admin_operator_cskh_dt");
  for (const operation of ["triggerStripeRefund", "recordManualRefund"] as const) {
    await assert.rejects(() => make()[operation](admin, RETURN_ID, { expectedVersion: 3 }), hasCode("RETURN_ITEM_REQUIRED"));
    await assert.rejects(() => make()[operation](admin, RETURN_ID, { returnItemId: ITEM_ID }), hasCode("VALIDATION_ERROR"));
    await assert.rejects(() => make()[operation](admin, RETURN_ID, { returnItemId: "not-this-return", expectedVersion: 3 }), hasCode("RETURN_ITEM_NOT_FOUND"));
    await assert.rejects(() => make()[operation](admin, RETURN_ID, { returnItemId: ITEM_ID, expectedVersion: 2 }), hasCode("VERSION_CONFLICT"));
    for (const patch of [{ decision_status: "pending" }, { resolution_type: "exchange" }]) {
      await assert.rejects(() => make({ ...REFUND_LINE, ...patch })[operation](admin, RETURN_ID, MANUAL_BODY), hasCode("REFUND_RESOLUTION_REQUIRED"));
    }
    for (const patch of [{ item_status: "WAITING_RETURN" }, { received_quantity: 0 }, { tags_intact: false }, { condition_acceptable: false }, { package_match: false }, { matches_product: false }]) {
      await assert.rejects(() => make({ ...REFUND_LINE, ...patch })[operation](admin, RETURN_ID, MANUAL_BODY), hasCode("WAREHOUSE_QA_REQUIRED"));
    }
  }
  assert.equal(gatewayCalls, 0);
});

test("Stripe failure is not reported as successful completion", async () => {
  const service = createReturnService({
    repository: {
      getRefundOperation: async () => null,
      getReturn: async () => COD_RETURN, listReturnLines: async () => ({ rows: [REFUND_LINE] }),
      getItemRefundableAmount: async () => 200000, getPaymentByOrderId: async () => ({ payment_provider: "stripe" })
    } as unknown as ReturnRepository,
    refunds: { refund: async () => ({ status: "failed", message: "Provider rejected refund" }) }
  });
  await assert.rejects(() => service.triggerStripeRefund(context("admin_operator_cskh_dt"), RETURN_ID, MANUAL_BODY), hasCode("STRIPE_REFUND_FAILED"));
});

test("manual refund records only the target COD line atomically, without pre-RPC payment writes", async () => {
  let recorded: unknown[] = [];
  const service = createReturnService({ repository: {
    getManualRefund: async () => null,
    getReturn: async () => COD_RETURN,
    listReturnLines: async () => ({ rows: [REFUND_LINE] }),
    getOrderPaymentMethod: async () => null,
    getPaymentByOrderId: async () => ({ ...COD_PAYMENT, payment_status: "pending" }),
    getRefundReceiver: async () => VALID_RECEIVER,
    recordManualRefund: async (...args) => { recorded = args; return { return_item_id: ITEM_ID, item_status: "COMPLETED" }; }
  } as unknown as ReturnRepository });
  const res = await service.recordManualRefund(context("admin_operator_cskh_dt"), RETURN_ID, { ...MANUAL_BODY, adminNote: "Chuyen khoan VCB" });
  assert.equal(res.return_item_id, ITEM_ID);
  assert.deepEqual(recorded, [RETURN_ID, 3, {
    reference: MANUAL_BODY.transferReference, amount: 200000, transferredAt: MANUAL_BODY.transferredAt,
    proof: MANUAL_BODY.imageProof, note: "Chuyen khoan VCB"
  }, "auth-1", undefined, ITEM_ID]);
});

test("manual COD refund accepts a legacy order with no payment row but a COD order method", async () => {
  let recorded: unknown[] = [];
  const service = createReturnService({ repository: {
    getManualRefund: async () => null,
    getReturn: async () => COD_RETURN,
    listReturnLines: async () => ({ rows: [REFUND_LINE] }),
    getPaymentByOrderId: async () => null,
    getOrderPaymentMethod: async () => "COD",
    getRefundReceiver: async () => VALID_RECEIVER,
    recordManualRefund: async (...args) => { recorded = args; return { return_item_id: ITEM_ID, item_status: "COMPLETED" }; }
  } as unknown as ReturnRepository });
  const res = await service.recordManualRefund(context("admin_operator_cskh_dt"), RETURN_ID, MANUAL_BODY);
  assert.equal(res.return_item_id, ITEM_ID);
  assert.equal(recorded.length > 0, true, "legacy COD order reached the refund RPC");
});

test("manual refund retries replay the recorded transfer and never pay the same part twice", async () => {
  let writes = 0;
  const service = createReturnService({ repository: {
    getManualRefund: async () => ({ return_item_id: ITEM_ID, reference: "FT-SMOKE-20261029", amount: 200000 }),
    recordManualRefund: async () => { writes++; return {}; }
  } as unknown as ReturnRepository });
  const admin = context("admin_operator_cskh_dt");
  const replay = await service.recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, transferReference: "ft-smoke-20261029" });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.reference, "FT-SMOKE-20261029");
  await assert.rejects(
    () => service.recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, transferReference: "FT-OTHER-20261029" }),
    hasCode("REFUND_ALREADY_REQUESTED")
  );
  assert.equal(writes, 0);
});

test("manual refunds reject every online payment provider", async () => {
  for (const provider of ["stripe", "momo", "vnpay"]) {
    const service = createReturnService({ repository: {
      getManualRefund: async () => null,
      getReturn: async () => ({ ...COD_RETURN, payment_method: "ONLINE_PAYMENT" }),
      listReturnLines: async () => ({ rows: [REFUND_LINE] }),
      getOrderPaymentMethod: async () => null,
      getPaymentByOrderId: async () => ({ payment_provider: provider, payment_method: "ONLINE_PAYMENT", payment_status: "paid" })
    } as unknown as ReturnRepository });
    await assert.rejects(() => service.recordManualRefund(context("admin_operator_cskh_dt"), RETURN_ID, MANUAL_BODY), hasCode("COD_PAYMENT_REQUIRED"));
  }
});

test("COD refund is blocked by invalid receivers and by public, inline or missing proof before the RPC", async () => {
  let writes = 0;
  const make = (receiver: JsonObject | null = VALID_RECEIVER) => createReturnService({ repository: {
    getManualRefund: async () => null,
    getReturn: async () => COD_RETURN, listReturnLines: async () => ({ rows: [REFUND_LINE] }),
    getOrderPaymentMethod: async () => null,
    getPaymentByOrderId: async () => COD_PAYMENT, getRefundReceiver: async () => receiver,
    recordManualRefund: async () => { writes++; return {}; }
  } as unknown as ReturnRepository });
  const admin = context("admin_operator_cskh_dt");
  for (const receiver of [null, { ...VALID_RECEIVER, account_number: "12ab" }, { ...VALID_RECEIVER, supplement_request: "Gui lai tai khoan" }]) {
    await assert.rejects(() => make(receiver).recordManualRefund(admin, RETURN_ID, MANUAL_BODY), hasCode("REFUND_RECEIVER_REQUIRED"));
  }
  for (const imageProof of ["", "https://cdn.test/proof.png", "data:image/png;base64,YQ==", "http://cdn.test/proof.png"]) {
    await assert.rejects(() => make().recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, imageProof }), hasCode("TRANSFER_PROOF_REQUIRED"));
  }
  await assert.rejects(() => make().recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, amount: 0 }), hasCode("REFUND_AMOUNT_MISMATCH"));
  await assert.rejects(() => make().recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, transferredAt: "" }), hasCode("TRANSFER_TIME_INVALID"));
  await assert.rejects(() => make().recordManualRefund(admin, RETURN_ID, { ...MANUAL_BODY, transferredAt: new Date(Date.now() + 3_600_000).toISOString() }), hasCode("TRANSFER_TIME_INVALID"));
  assert.equal(writes, 0);
});

test("requestRefundInfo stores the CSKH supplement request without moving the return", async () => {
  let saved: { returnId: string; version: number; message: string; actorId: string } | null = null;
  const service = createReturnService({
    repository: {
      getReturn: async () => COD_RETURN,
      getPaymentByOrderId: async () => COD_PAYMENT,
      requestRefundReceiverSupplement: async (returnId: string, version: number, message: string, actorId: string) => {
        saved = { returnId, version, message, actorId };
        return { supplement_request: message, supplement_requested_at: "2026-10-19T01:00:00.000Z" };
      },
      getRefundReceiver: async () => ({ bank_name: "", account_number: "", account_holder: "", supplement_request: "Vui long gui so tai khoan nhan hoan tien" })
    }
  });
  const res = await service.requestRefundInfo(context("admin_operator_cskh_dt"), RETURN_ID, { message: "  Vui long gui so tai khoan nhan hoan tien  ", expectedVersion: 3 });
  const receiver = asJsonObject(res.refund_receiver);
  assert.equal(saved?.message, "Vui long gui so tai khoan nhan hoan tien");
  assert.equal(saved?.version, 3);
  assert.equal(receiver.status, "supplement_requested");
  assert.equal(receiver.supplement_request, "Vui long gui so tai khoan nhan hoan tien");

  const admin = context("admin_operator_cskh_dt");
  await assert.rejects(() => service.requestRefundInfo(admin, RETURN_ID, { message: "ngan", expectedVersion: 3 }), hasCode("SUPPLEMENT_MESSAGE_REQUIRED"));
  await assert.rejects(() => service.requestRefundInfo(admin, RETURN_ID, { message: "Vui long gui so tai khoan", expectedVersion: 2 }), hasStatus(409));
  await assert.rejects(() => service.requestRefundInfo(context("admin_operator_donhang"), RETURN_ID, { message: "Vui long gui so tai khoan", expectedVersion: 3 }), hasStatus(403));
});

test("receiving-account supplementation supports a converted refund without rewriting the original exchange type", async () => {
  const service = createReturnService({ repository: {
    getReturn: async () => ({ ...COD_RETURN, return_type: "exchange" }),
    listReturnLines: async () => ({ rows: [REFUND_LINE] }),
    getPaymentByOrderId: async () => COD_PAYMENT,
    getRefundReceiver: async () => VALID_RECEIVER,
    requestRefundReceiverSupplement: async (_id, _version, message) => ({ supplement_request: message })
  } as unknown as ReturnRepository });
  const detail = await service.requestRefundInfo(context("admin_operator_cskh_dt"), RETURN_ID, {
    expectedVersion: 3, message: "Vui long xac nhan lai tai khoan"
  });
  assert.equal(asJsonObject(detail.refund_receiver).status, "supplement_requested");
});

test("requestRefundInfo is refused for Stripe returns, exchanges and finished returns", async () => {
  const admin = context("admin_operator_cskh_dt");
  const make = (ret: JsonObject, payment: JsonObject) => createReturnService({
    repository: { getReturn: async () => ret, getPaymentByOrderId: async () => payment, listReturnLines: async () => ({ rows: [] }), requestRefundReceiverSupplement: async () => { throw new Error("must not be reached"); } }
  });
  const body = { message: "Vui long gui so tai khoan", expectedVersion: 3 };
  await assert.rejects(() => make({ ...COD_RETURN, payment_method: "ONLINE_PAYMENT" }, { payment_provider: "stripe", payment_method: "ONLINE_PAYMENT" }).requestRefundInfo(admin, RETURN_ID, body), hasCode("REFUND_RECEIVER_NOT_APPLICABLE"));
  await assert.rejects(() => make({ ...COD_RETURN, return_type: "exchange" }, COD_PAYMENT).requestRefundInfo(admin, RETURN_ID, body), hasCode("REFUND_RECEIVER_NOT_APPLICABLE"));
  await assert.rejects(() => make({ ...COD_RETURN, status: "COMPLETED" }, COD_PAYMENT).requestRefundInfo(admin, RETURN_ID, body), hasCode("RETURN_CLOSED"));
});

test("return detail tells COD (manual transfer + receiving account) apart from Stripe (automatic refund)", async () => {
  const detail = (ret: JsonObject, payment: JsonObject) => createReturnService({
    repository: {
      getReturn: async () => ret,
      getRefundableAmount: async () => 200000,
      getPaymentByOrderId: async () => payment,
      listReturnLines: async () => ({ rows: [] }),
      getRefundReceiver: async () => VALID_RECEIVER,
      getManualRefund: async () => ({ reference: "VCB2026100501", amount: 200000 })
    }
  }).getReturn(context("admin_operator_cskh_dt"), RETURN_ID);
  const cod = await detail(COD_RETURN, COD_PAYMENT);
  assert.equal(cod.payment_kind, "cod");
  assert.equal(cod.refund_flow, "cod_manual");
  assert.equal(cod.refund_receiver_status, "valid");
  assert.equal(asJsonObject(cod.refund_receiver).account_number, "0123456789");
  assert.equal(asJsonObject(cod.manual_refund).reference, "VCB2026100501");
  const stripe = await detail({ ...COD_RETURN, payment_method: "ONLINE_PAYMENT" }, { payment_method: "ONLINE_PAYMENT", payment_provider: "stripe" });
  assert.equal(stripe.payment_kind, "stripe");
  assert.equal(stripe.refund_flow, "stripe_auto");
  assert.equal(stripe.refund_receiver, null);
  assert.equal(stripe.refund_receiver_status, "not_required");
  const exchange = await detail({ ...COD_RETURN, return_type: "exchange" }, COD_PAYMENT);
  assert.equal(exchange.refund_flow, "none");
});

test("the return queue filters by payment kind and refuses unknown kinds", async () => {
  let filters: ReturnListFilters | null = null;
  const service = createReturnService({ repository: { listReturns: async (received: ReturnListFilters) => { filters = received; return { rows: [] }; } } });
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("payment_kind=cod"));
  assert.equal(filters?.paymentKind, "cod");
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("payment_kind=online"));
  assert.equal(filters?.paymentKind, "online");
  await service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams(""));
  assert.equal(filters?.paymentKind, undefined);
  await assert.rejects(() => service.listReturns(context("admin_operator_cskh_dt"), new URLSearchParams("payment_kind=momo")), hasStatus(422));
});

test("order readers never receive full bank fields in legacy headers, manual snapshots or events", async () => {
  const service = createReturnService({ repository: {
    getReturn: async () => ({ ...COD_RETURN, return_type: "refund", refund_bank_name: "Vietcombank", refund_bank_account: "0123456789", refund_bank_holder: "Nguyen Van A" }),
    getRefundableAmount: async () => 200000,
    getPaymentByOrderId: async () => COD_PAYMENT,
    listReturnLines: async () => ({ rows: [REFUND_LINE] }),
    getItemRefundableAmount: async () => 200000,
    getRefundReceiver: async () => VALID_RECEIVER,
    getManualRefund: async () => ({ reference: "transfer-reference", receiver_snapshot: VALID_RECEIVER, proof: MANUAL_BODY.imageProof }),
    listReturnEvents: async () => [{ payload: { receiver_snapshot: VALID_RECEIVER } }],
    listReturns: async () => ({ rows: [{ ...COD_RETURN, refund_bank_account: "0123456789" }], count: 1 })
  } as unknown as ReturnRepository });
  const reader = await service.getReturn(context("admin_operator_donhang"), RETURN_ID);
  assert.doesNotMatch(JSON.stringify(reader), /0123456789|Nguyen Van A|Vietcombank/);
  assert.equal(asJsonObject(reader.manual_refund).reference, "transfer-reference");
  const maskedLine = (reader.lines as JsonObject[])[0];
  assert.equal(asJsonObject(asJsonObject(maskedLine.manual_refund).receiver_snapshot).account_number, null);
  assert.equal(asJsonObject(maskedLine.manual_refund).proof, null);
  const queue = await service.listReturns(context("admin_operator_donhang"), new URLSearchParams());
  assert.equal(queue.rows[0].refund_bank_account, null);
  const operator = await service.getReturn(context("admin_operator_cskh_dt"), RETURN_ID);
  assert.equal(asJsonObject(operator.refund_receiver).account_number, "0123456789");
  assert.equal(operator.refund_bank_account, "0123456789");
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }

test("super-admin approval is blocked until the customer uploaded both packing photo and video", async () => {
  let called = 0;
  const service = createReturnService({ repository: {
    listEvidence: async () => [{ kind: "packing_photo", uploaded_by_role: "customer" }],
    actOnItem: async () => { called += 1; return {}; }
  } as unknown as ReturnRepository });
  await assert.rejects(
    () => service.actOnItem(context("super_admin"), RETURN_ID, ITEM_ID, { action: "approve", expectedVersion: 3, reason: "Da xac minh du bang chung" }),
    hasCode("PACKING_EVIDENCE_REQUIRED")
  );
  assert.equal(called, 0);
});
