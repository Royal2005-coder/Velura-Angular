import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { mapReturnDatabaseError } from "../../apps/api/src/returns/return-repository.js";
import {
  adminRefundReceiver,
  classifyReturnPayment,
  customerRefundReceiver,
  refundFlowFor,
  refundReceiverStatus,
  validateRefundReceiver
} from "../../apps/api/src/returns/return-refund-receiver.js";

test("payment kind separates COD, Stripe and the manual MoMo/VNPay gateways", () => {
  assert.equal(classifyReturnPayment("COD", "cod"), "cod");
  assert.equal(classifyReturnPayment("COD", undefined), "cod");
  assert.equal(classifyReturnPayment("ONLINE_PAYMENT", "stripe"), "stripe");
  assert.equal(classifyReturnPayment("ONLINE_PAYMENT", undefined), "stripe");
  assert.equal(classifyReturnPayment("ONLINE_PAYMENT", "momo"), "other_online");
  assert.equal(classifyReturnPayment("ONLINE_PAYMENT", "vnpay"), "other_online");
  assert.equal(refundFlowFor("refund", "cod"), "cod_manual");
  assert.equal(refundFlowFor("refund", "stripe"), "stripe_auto");
  assert.equal(refundFlowFor("refund", "other_online"), "manual_transfer");
  assert.equal(refundFlowFor("exchange", "cod"), "none");
});

test("receiving account validation matches the database rule (bank, 6-20 digit account, holder without digits)", () => {
  const ok = validateRefundReceiver({ bank_name: " Vietcombank ", account_number: "0123 456-789", account_holder: "Nguyen   Van A" });
  assert.deepEqual(ok, { ok: true, value: { bankName: "Vietcombank", accountNumber: "0123456789", accountHolder: "Nguyen Van A" } });
  const bad = validateRefundReceiver({ bank_name: "V", account_number: "12345", account_holder: "A1" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["account_holder", "account_number", "bank_name"]);
  assert.equal(validateRefundReceiver({ bank_name: "MoMo", account_number: "0912345678", account_holder: "Tran Thi B" }).ok, true);
  assert.equal(validateRefundReceiver({ bank_name: "MoMo", account_number: "1".repeat(21), account_holder: "Tran Thi B" }).ok, false);
});

test("receiver status: a pending CSKH supplement request outranks complete-looking data", () => {
  const valid = { bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A" };
  assert.equal(refundReceiverStatus(false, null), "not_required");
  assert.equal(refundReceiverStatus(true, null), "missing");
  assert.equal(refundReceiverStatus(true, { supplement_request: "Gui lai so tai khoan" }), "supplement_requested");
  assert.equal(refundReceiverStatus(true, { ...valid, supplement_request: "Gui lai so tai khoan" }), "supplement_requested");
  assert.equal(refundReceiverStatus(true, { ...valid, account_number: "12ab" }), "invalid");
  assert.equal(refundReceiverStatus(true, valid), "valid");
});

test("admins get the full account number to transfer to, customers only its last four digits", () => {
  const row = { bank_name: "Vietcombank", account_number: "0123456789", account_holder: "Nguyen Van A", submitted_at: "2026-10-19T01:00:00Z" };
  assert.equal(adminRefundReceiver(true, row)?.account_number, "0123456789");
  const customer = customerRefundReceiver(true, row);
  assert.equal(customer?.account_last4, "6789");
  assert.equal(customer && "account_number" in customer, false);
  assert.equal(adminRefundReceiver(false, row), null);
  assert.equal(customerRefundReceiver(false, row), null);
});

test("database guard codes surface as localized, stable HTTP errors", () => {
  const raised = new HttpError(422, "SUPABASE_ERROR", "REFUND_RECEIVER_REQUIRED [status:422]", { message: "REFUND_RECEIVER_REQUIRED", code: "PT422" });
  const mapped = mapReturnDatabaseError(raised);
  assert.ok(mapped instanceof HttpError);
  assert.equal(mapped.status, 422);
  assert.equal(mapped.code, "REFUND_RECEIVER_REQUIRED");
  assert.match(mapped.message, /thông tin nhận hoàn tiền/i);
  const duplicate = mapReturnDatabaseError(new HttpError(409, "SUPABASE_ERROR", "x", { message: "DUPLICATE_TRANSFER_REFERENCE" }));
  assert.ok(duplicate instanceof HttpError);
  assert.equal(duplicate.status, 409);
  const unknown = new HttpError(500, "SUPABASE_ERROR", "boom", { message: "SOMETHING_ELSE" });
  assert.equal(mapReturnDatabaseError(unknown), unknown);
});
