import { asString, type JsonObject } from "../types.js";

/**
 * How a return's refund is paid out. COD cannot be reversed to a gateway, so CSKH transfers the money by hand to the
 * customer's account; Stripe reverses automatically; MoMo/VNPay use the same manual transfer ledger without receiver capture.
 */
export type ReturnPaymentKind = "cod" | "stripe" | "other_online";

/** Refund execution path for one return; `none` for exchanges that move no money. */
export type ReturnRefundFlow = "cod_manual" | "stripe_auto" | "manual_transfer" | "none";

/** Usability of the customer's receiving account for a COD refund. */
export type RefundReceiverStatus = "not_required" | "missing" | "invalid" | "supplement_requested" | "valid";

/** Statuses after which the receiving account can no longer be changed or supplemented. */
export const REFUND_RECEIVER_CLOSED_STATUSES: readonly string[] = ["REFUNDED", "COMPLETED", "CANCELLED"];

/**
 * Classifies an order's payment. The order enum only knows COD vs ONLINE_PAYMENT, so the gateway name from the
 * `payment` row separates Stripe from MoMo/VNPay.
 */
export function classifyReturnPayment(orderPaymentMethod: unknown, paymentProvider: unknown): ReturnPaymentKind {
  const method = asString(orderPaymentMethod).toUpperCase();
  const provider = asString(paymentProvider).toLowerCase();
  if (provider === "stripe") return "stripe";
  if (method === "COD" || (!method && provider === "cod")) return "cod";
  if (provider === "momo" || provider === "vnpay") return "other_online";
  // Online-paid order without a recorded non-Stripe gateway: Stripe is the only automatic online gateway Velura ships.
  return method === "ONLINE_PAYMENT" ? "stripe" : "cod";
}

/**
 * Picks the refund path. Exchanges never move money.
 */
export function refundFlowFor(returnType: unknown, kind: ReturnPaymentKind): ReturnRefundFlow {
  if (asString(returnType) !== "refund") return "none";
  return kind === "cod" ? "cod_manual" : kind === "stripe" ? "stripe_auto" : "manual_transfer";
}

/** Customer-supplied receiving account, normalised. */
export interface RefundReceiverInput {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
}

export type RefundReceiverValidation =
  | { ok: true; value: RefundReceiverInput }
  | { ok: false; errors: Record<string, string[]> };

/**
 * Validates the receiving bank/wallet account. Mirrors `velura_refund_receiver_valid` in migration 069: the database
 * remains the authority, this gives the customer field-level Vietnamese errors before the round trip.
 */
export function validateRefundReceiver(input: { bank_name?: unknown; account_number?: unknown; account_holder?: unknown }): RefundReceiverValidation {
  const bankName = asString(input.bank_name).trim();
  const accountNumber = asString(input.account_number).replace(/[\s-]/g, "");
  const accountHolder = asString(input.account_holder).trim().replace(/\s+/g, " ");
  const errors: Record<string, string[]> = {};
  if (bankName.length < 2 || bankName.length > 80) errors.bank_name = ["Nhập tên ngân hàng hoặc ví nhận tiền (2–80 ký tự)."];
  if (!/^[0-9]{6,20}$/.test(accountNumber)) errors.account_number = ["Số tài khoản/ví chỉ gồm 6–20 chữ số."];
  if (accountHolder.length < 2 || accountHolder.length > 100 || /[0-9]/.test(accountHolder)) errors.account_holder = ["Tên chủ tài khoản gồm 2–100 ký tự và không chứa chữ số."];
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { bankName, accountNumber, accountHolder } };
}

/**
 * Resolves the receiver status from the stored `return_refund_receiver` row. A pending CSKH supplement request always
 * wins over complete-looking data: the customer must answer it before the refund can continue.
 */
export function refundReceiverStatus(required: boolean, row: JsonObject | null | undefined): RefundReceiverStatus {
  if (!required) return "not_required";
  if (!row) return "missing";
  if (asString(row.supplement_request).trim()) return "supplement_requested";
  if (!asString(row.bank_name) && !asString(row.account_number) && !asString(row.account_holder)) return "missing";
  const check = validateRefundReceiver(row);
  return check.ok ? "valid" : "invalid";
}

/** Admin view of the receiver; the full account number is needed to make the transfer. */
export function adminRefundReceiver(required: boolean, row: JsonObject | null | undefined): JsonObject | null {
  if (!required) return null;
  return {
    status: refundReceiverStatus(required, row),
    bank_name: row ? asString(row.bank_name) || null : null,
    account_number: row ? asString(row.account_number) || null : null,
    account_holder: row ? asString(row.account_holder) || null : null,
    submitted_at: row ? asString(row.submitted_at) || null : null,
    supplement_request: row ? asString(row.supplement_request) || null : null,
    supplement_requested_at: row ? asString(row.supplement_requested_at) || null : null
  };
}

/** Customer view of the receiver: the account number is reduced to its last four digits. */
export function customerRefundReceiver(required: boolean, row: JsonObject | null | undefined): JsonObject | null {
  if (!required) return null;
  const account = row ? asString(row.account_number) : "";
  return {
    status: refundReceiverStatus(required, row),
    bank_name: row ? asString(row.bank_name) || null : null,
    account_last4: account ? account.slice(-4) : null,
    account_holder: row ? asString(row.account_holder) || null : null,
    submitted_at: row ? asString(row.submitted_at) || null : null,
    supplement_request: row ? asString(row.supplement_request) || null : null,
    supplement_requested_at: row ? asString(row.supplement_requested_at) || null : null
  };
}
