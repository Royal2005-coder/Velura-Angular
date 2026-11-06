import { HttpError } from "../http.js";
import { callRpc, selectOne, selectRows, updateRows } from "../supabase.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { refundChannelFor } from "../returns/return-email.js";
import {
  gatewayCredentials,
  gatewayEndpoints,
  momoSignature,
  sameSignature,
  vnpayDate,
  vnpayPipeHash,
  type GatewayCredentials,
  type LocalGateway
} from "./local-gateways.js";
import {
  completeRefund,
  completeReturnRefund,
  markRefundFailed,
  refundStripeOrder,
  updateReturnRefundOperation,
  type RefundResult,
  type RefundStripeOptions
} from "./stripe.js";

/** Tham số hoàn tiền dùng chung cho mọi nhà mạng, khớp chữ ký của `ReturnRefundGateway`. */
export interface GatewayRefundOptions extends RefundStripeOptions {
  clientIp?: string;
}

/** Bảng mã VNPay 2.1.0 cho refund: thứ tự cố định, kể cả trường tuỳ chọn vắng mặt. */
const VNPAY_REFUND_REQUEST = ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TransactionType", "vnp_TxnRef", "vnp_Amount", "vnp_TransactionNo", "vnp_TransactionDate", "vnp_CreateBy", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"] as const;
const VNPAY_REFUND_RESPONSE = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo"] as const;
const MOMO_REFUND_KEYS = ["accessKey", "amount", "description", "orderId", "partnerCode", "requestId", "transId"] as const;

/**
 * Hoàn tiền VNPay/MoMo cho một đơn hàng, dùng đúng sổ ledger mà Stripe đã dùng
 * (`velura_prepare_return_refund` → provider → `velura_complete_return_refund`).
 *
 * Hai nhà mạng này bắt buộc phải có số giao dịch của lần thu tiền (vnp_TransactionNo / transId).
 * Không có nó thì không hoàn tự động được — trả `failed` để CSKH chuyển sang ghi nhận chuyển
 * khoản thủ công, thay vì đoán một số giao dịch.
 */
export async function refundLocalGatewayOrder(orderId: string, options: GatewayRefundOptions = {}): Promise<RefundResult> {
  let refundAmount = typeof options.amount === "number" ? options.amount : undefined;
  let operation: JsonObject | null = null;
  if (options.returnId) {
    if (!options.returnItemId) throw new HttpError(422, "RETURN_ITEM_REQUIRED", "A return item is required for a return refund");
    operation = asJsonObject(await callRpc("velura_prepare_return_refund", {
      p_return_id: options.returnId, p_order_id: orderId,
      p_expected_version: options.expectedVersion, p_return_item_id: options.returnItemId
    }));
    if (!operation.refund_id || operation.return_item_id !== options.returnItemId || operation.return_id !== options.returnId) {
      throw new HttpError(409, "REFUND_OPERATION_MISMATCH", "Refund operation does not match the return item");
    }
    if (operation.status === "succeeded") return { status: "refunded" };
    refundAmount = Number(operation.amount);
  }

  const payment = await selectOne("payment", {
    order_id: `eq.${orderId}`,
    ...(operation ? { payment_id: "eq." + asString(operation.payment_id) } : {}),
    payment_provider: "in.(vnpay,momo)",
    payment_status: "in.(paid,refund_pending)",
    order: "created_at.desc"
  });
  if (!payment) return { status: "skipped", message: "Không có giao dịch VNPay/MoMo nào đã thu để hoàn tiền" };
  if (operation && operation.payment_id !== payment.payment_id) throw new HttpError(409, "PAYMENT_CHANGED", "Refund payment changed");

  const provider = asString(payment.payment_provider).toUpperCase() as LocalGateway;
  const remaining = Number(payment.amount) - Number(payment.refunded_amount || 0);
  if (refundAmount !== undefined && (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > remaining)) {
    throw new HttpError(422, "INVALID_REFUND_AMOUNT", "Refund exceeds the remaining captured balance");
  }
  const transactionNo = asString(payment.gateway_transaction_ref);
  if (!/^\d{1,20}$/.test(transactionNo)) {
    return { status: "failed", message: "Thiếu số giao dịch của cổng thanh toán nên không hoàn tự động được." };
  }
  if (payment.payment_status === "paid") {
    await updateRows("payment", { payment_id: `eq.${asString(payment.payment_id)}` }, {
      payment_status: "refund_pending",
      refund_amount: refundAmount ?? payment.amount,
      refund_reason: options.reason || "Yêu cầu hoàn tiền từ quản trị viên / trả hàng",
      gateway_response_code: "REFUND_REQUESTED"
    });
  }

  const credentials = gatewayCredentials(provider);
  const amount = refundAmount ?? Number(payment.amount);
  const fetchImpl = options.fetchImpl ?? fetch;
  let attempt: { url: string; body: JsonObject; provider_ref: string };
  if (provider === "VNPAY") {
    // MoMo dùng đơn vị VND; VNPay nhân 100 ở mọi trường tiền, kể cả refund.
    const request: JsonObject = {
      vnp_RequestId: asString(operation?.refund_id || payment.payment_id).replace(/-/g, ""),
      vnp_Version: "2.1.0", vnp_Command: "refund", vnp_TmnCode: credentials.merchantId,
      vnp_TransactionType: amount < Number(payment.amount) ? "03" : "02",
      vnp_TxnRef: asString(payment.gateway_session_id), vnp_Amount: String(amount * 100),
      vnp_TransactionNo: transactionNo, vnp_TransactionDate: vnpayDate(new Date(asString(payment.created_at))),
      vnp_CreateBy: "velura", vnp_CreateDate: vnpayDate(new Date()),
      vnp_IpAddr: options.clientIp || "127.0.0.1", vnp_OrderInfo: `Hoan tien don hang ${asString(payment.gateway_session_id)}`
    };
    request.vnp_SecureHash = vnpayPipeHash(VNPAY_REFUND_REQUEST.map(key => asString(request[key])), credentials.secret);
    attempt = { url: gatewayEndpoints("VNPAY").api, body: request, provider_ref: `vnpay:${transactionNo}` };
  } else {
    if (amount < 1000 || amount > 50000000) return { status: "failed", message: "Số tiền hoàn ngoài phạm vi MoMo hỗ trợ (1.000đ – 50.000.000đ)." };
    // requestId là khoá idempotent của MoMo: lấy refund_id bền vững để retry không tạo hoàn tiền thứ hai.
    const refundReference = asString(operation?.refund_id || payment.payment_id).replace(/-/g, "");
    const fields = {
      accessKey: credentials.accessKey, amount, description: "Velura hoan tien",
      orderId: refundReference, partnerCode: credentials.merchantId, requestId: refundReference, transId: transactionNo
    };
    const request: JsonObject = {
      partnerCode: credentials.merchantId, orderId: refundReference, requestId: refundReference,
      amount, transId: Number(transactionNo), description: fields.description, lang: "vi",
      signature: momoSignature(fields, MOMO_REFUND_KEYS, credentials.secret)
    };
    attempt = { url: `${gatewayEndpoints("MOMO").api}/refund`, body: request, provider_ref: `momo:${transactionNo}` };
  }

  try {
    const response = await fetchImpl(attempt.url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(attempt.body),
      signal: AbortSignal.timeout(30000)
    });
    const result = asJsonObject(await response.json());
    const outcome = provider === "VNPAY" ? interpretVnpayRefund(result, credentials, attempt.body, amount) : interpretMomoRefund(result, response.status);
    if (outcome.status === "refunded") {
      const providerRef = outcome.provider_ref || attempt.provider_ref;
      if (operation) {
        const changed = await updateReturnRefundOperation(operation, { status: "pending", provider_ref: providerRef });
        if (!changed.length) return { status: "requested", message: "Đang đối soát giao dịch hoàn tiền" };
        await completeReturnRefund(operation, providerRef, refundChannelFor(provider));
      } else {
        await completeRefund(asString(payment.payment_id), orderId, amount, providerRef);
      }
      return { status: "refunded" };
    }
    if (outcome.status === "requested") {
      if (operation && outcome.provider_ref) await updateReturnRefundOperation(operation, { status: "pending", provider_ref: outcome.provider_ref });
      return { status: "requested", message: outcome.message };
    }
    if (operation && !response.ok) return { status: "requested", message: outcome.message };
    if (operation) await updateReturnRefundOperation(operation, { status: "failed" });
    await markRefundFailed(orderId, payment, outcome.message);
    return { status: "failed", message: outcome.message };
  } catch (error: unknown) {
    // Nhà mạng có thể đã nhận yêu cầu trước khi kết nối đứt: giữ reservation, không mở lại hoàn tiền.
    if (operation) return { status: "requested", message: `Đang chờ đối soát kết quả hoàn tiền ${provider}` };
    await markRefundFailed(orderId, payment, asString((error as Error)?.message));
    return { status: "failed", message: `Không kết nối được ${provider}` };
  }
}

interface RefundInterpretation {
  status: "refunded" | "requested" | "failed";
  provider_ref?: string;
  message: string;
}

/**
 * VNPay trả `00` nghĩa là YÊU CẦU hoàn tiền được chấp nhận, không phải tiền đã về.
 * Chỉ `vnp_TransactionStatus=00` trên giao dịch hoàn trả mới kết thúc phiên; 05/06 đang chạy,
 * 94 là trùng yêu cầu (đã có yêu cầu trước đó đang xử lý) nên giữ lại để đối soát.
 */
function interpretVnpayRefund(result: JsonObject, credentials: GatewayCredentials, request: JsonObject, amount: number): RefundInterpretation {
  const code = asString(result.vnp_ResponseCode) || "99";
  const message = asString(result.vnp_Message) || "VNPay không mô tả kết quả";
  if (result.vnp_SecureHash) {
    const expected = vnpayPipeHash(VNPAY_REFUND_RESPONSE.map(key => asString(result[key])), credentials.secret);
    if (!sameSignature(asString(result.vnp_SecureHash), expected)) return { status: "requested", message: "Chưa xác minh được chữ ký phản hồi hoàn tiền VNPay" };
  }
  if (code === "94") return { status: "requested", message: "Yêu cầu hoàn tiền VNPay đang được xử lý" };
  if (code !== "00") {
    const refused: Record<string, string> = {
      "16": "VNPay từ chối hoàn tiền vì ngoài thời gian cho phép",
      "93": "Số tiền hoàn vượt quá giá trị giao dịch gốc",
      "95": "Giao dịch gốc không thành công nên VNPay từ chối hoàn tiền",
      "97": "Chữ ký hoàn tiền VNPay không hợp lệ"
    };
    return { status: "failed", message: refused[code] || `VNPay từ chối yêu cầu (${code}): ${message}` };
  }
  const refundAmount = Number(result.vnp_Amount) / 100;
  if (Number.isFinite(result.vnp_Amount) && refundAmount !== amount) return { status: "requested", message: "Số tiền hoàn VNPay báo về không khớp yêu cầu" };
  if (asString(request.vnp_TxnRef) !== asString(result.vnp_TxnRef)) return { status: "requested", message: "VNPay phản hồi cho một giao dịch khác" };
  const status = asString(result.vnp_TransactionStatus);
  const providerRef = `vnpay:${asString(result.vnp_TransactionNo) || asString(request.vnp_TransactionNo)}`;
  if (status === "09") return { status: "failed", message: "VNPay từ chối giao dịch hoàn tiền" };
  if (status === "00") return { status: "refunded", provider_ref: providerRef, message: "VNPay hoàn tất hoàn tiền" };
  return { status: "requested", provider_ref: providerRef, message: "VNPay đang xử lý hoàn tiền" };
}

/** MoMo: `resultCode=0` là hoàn tiền đã thực hiện; 1080 là "hãy thử lại sau", các mã còn lại là từ chối. */
function interpretMomoRefund(result: JsonObject, httpStatus: number): RefundInterpretation {
  const code = Number(result.resultCode);
  const message = asString(result.message) || `MoMo trả trạng thái ${httpStatus}`;
  if (httpStatus === 422 && code === 7000) return { status: "requested", message: "Yêu cầu hoàn tiền MoMo đang được xử lý" };
  if (Number.isNaN(code)) return { status: "requested", message: "Chưa đọc được kết quả hoàn tiền MoMo" };
  if (code === 0) return { status: "refunded", provider_ref: `momo:${asString(result.transId)}`, message: "MoMo hoàn tất hoàn tiền" };
  if (code === 1080) return { status: "requested", message: "MoMo chưa xử lý xong, sẽ tự đối soát lại" };
  if (code === 7000 || code === 7002) return { status: "requested", message };
  const refused: Record<number, string> = {
    1081: "Giao dịch gốc đã được hoàn trước đó",
    1088: "Giao dịch gốc không đủ điều kiện hoàn tiền",
    41: "Yêu cầu hoàn tiền này đã được gửi trước đó",
    42: "Không tìm thấy giao dịch gốc trên MoMo"
  };
  return { status: "failed", message: refused[code] || `MoMo từ chối hoàn tiền (${code}): ${message}` };
}

/**
 * Cổng hoàn tiền thống nhất cho đơn hàng: đọc nhà mạng của chính giao dịch đã thu tiền rồi
 * gọi đúng client của nhà mạng đó. Trước đây mọi đường hoàn tiền đều_hardcode_ Stripe, nên
 * một đơn VNPay/MoMo không có cách nào hoàn tự động.
 */
export async function refundOrderPayment(orderId: string, options: GatewayRefundOptions = {}): Promise<RefundResult> {
  const { rows } = await selectRows("payment", {
    order_id: `eq.${orderId}`,
    payment_status: "in.(paid,refund_pending)",
    order: "created_at.desc",
    limit: "5",
    select: "payment_id,payment_provider"
  }, { count: "none" });
  const provider = asString(rows[0]?.payment_provider).toLowerCase();
  if (provider === "vnpay" || provider === "momo") return refundLocalGatewayOrder(orderId, options);
  return refundStripeOrder(orderId, options);
}
