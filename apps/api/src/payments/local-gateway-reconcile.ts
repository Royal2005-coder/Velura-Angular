import { config } from "../config.js";
import { selectOne, selectRows } from "../supabase.js";
import { asString } from "../types.js";
import { sendRefundSuccessEmail } from "../returns/return-email.js";
import { gatewayEnvironment, localGatewayConfigured, type LocalGateway } from "./local-gateways.js";
import { queryRefundStatus, verifyLocalGatewayOrder } from "./local-gateway-verify.js";
import { completeRefund, completeReturnRefund, markRefundFailed, updateReturnRefundOperation } from "./stripe.js";

/** Nghỉ giữa hai lần hỏi cùng một phiên, để không spam nhà mạng mỗi phút. */
const lastAttempt = new Map<string, number>();
const lastRefundAttempt = new Map<string, number>();
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Đóng khe hở mà VNPay/MoMo để lại so với Stripe: IPN có thể không bao giờ tới.
 *
 * VNPay chỉ gọi IPN nếu họ đã đăng ký URL cho terminal (sandbox thường chưa), MoMo không công bố
 * lịch retry. Vì vậy phiên nào treo `pending` phải được hỏi lại chính nhà mạng — không có đường
 * nào tự đánh dấu đã thu tiền. Kết quả vẫn đi qua `velura_reconcile_gateway_attempt`, nên đối soát
 * không tạo tiền và không capture một phiên chưa thanh toán.
 */
export async function reconcilePendingLocalGatewayPayments(
  limit = 20,
  now = Date.now()
): Promise<{ checked: number; paid: number; still_pending: number }> {
  const providers = (["VNPAY", "MOMO"] as const).filter(localGatewayConfigured);
  if (!providers.length) return { checked: 0, paid: 0, still_pending: 0 };
  const olderThan = new Date(now - 2 * 60 * 1000).toISOString();
  const { rows } = await selectRows("payment", {
    payment_provider: "in.(vnpay,momo)",
    payment_status: "eq.pending",
    created_at: `lt.${olderThan}`,
    gateway_session_id: "not.is.null",
    select: "payment_id,order_id,payment_provider,created_at",
    order: "created_at.desc",
    limit
  }, { count: "none" });
  let checked = 0;
  let paid = 0;
  let stillPending = 0;
  for (const row of rows) {
    const paymentId = asString(row.payment_id);
    const orderId = asString(row.order_id);
    const provider = asString(row.payment_provider).toUpperCase() as LocalGateway;
    if (!orderId || !providers.includes(provider)) continue;
    const previous = lastAttempt.get(paymentId) || 0;
    if (now - previous < RETRY_AFTER_MS) continue;
    lastAttempt.set(paymentId, now);
    checked += 1;
    try {
      const result = await verifyLocalGatewayOrder({ orderId, provider });
      if (result.paid) paid += 1;
      else stillPending += 1;
    } catch (error) {
      stillPending += 1;
      console.warn("[GATEWAY RECONCILE] payment check failed", {
        payment_id: paymentId, provider, code: (error as { code?: string })?.code || "UNKNOWN"
      });
    }
  }
  return { checked, paid, still_pending: stillPending };
}

/**
 * Đóng các LỆNH HOÀN TIỀN đang chờ cổng. Phần mà webhook Stripe làm hộ Velura, VNPay/MoMo không có:
 * cả hai tài liệu đều không mô tả callback cho refund, và hoàn tiền về ngân hàng mất nhiều ngày, nên
 * nếu không hỏi lại thì `payment_refund` nằm `pending` mãi — khách chưa nhận tiền, CSKH cũng không
 * thấy đường nào để ghi chuyển khoản tay (migration 113 đòi một lệnh `failed`).
 */
export async function reconcilePendingGatewayRefunds(
  limit = 20,
  now = Date.now()
): Promise<{ checked: number; settled: number; refused: number; still_pending: number }> {
  const providers = (["VNPAY", "MOMO"] as const).filter(code => localGatewayConfigured(code));
  if (!providers.length) return { checked: 0, settled: 0, refused: 0, still_pending: 0 };
  const { rows: refunds } = await selectRows("payment_refund", {
    status: "eq.pending",
    created_at: `lt.${new Date(now - 60 * 1000).toISOString()}`,
    order: "updated_at.asc",
    limit
  }, { count: "none" });
  let checked = 0;
  let settled = 0;
  let refused = 0;
  let stillPending = 0;
  for (const refund of refunds) {
    const refundId = asString(refund.refund_id);
    if (!refundId) continue;
    const previous = lastRefundAttempt.get(refundId) || 0;
    if (now - previous < RETRY_AFTER_MS) continue;
    lastRefundAttempt.set(refundId, now);
    const payment = await selectOne("payment", { payment_id: `eq.${asString(refund.payment_id)}` });
    const provider = asString(payment?.payment_provider).toUpperCase() as LocalGateway;
    if (!payment || !providers.includes(provider)) continue;
    // Đối soát chỉ nói về phiên thuộc môi trường mình đang chạy (bất biến migration 112).
    if (asString(payment.gateway_environment) !== gatewayEnvironment(provider)) {
      console.warn("[GATEWAY REFUND RECONCILE] skipped: environment mismatch", { refund_id: refundId, provider });
      continue;
    }
    checked += 1;
    try {
      const status = await queryRefundStatus(refund, payment);
      if (status.outcome === "settled") {
        if (refund.return_item_id) await completeReturnRefund(refund, status.provider_ref, provider.toLowerCase() as "vnpay" | "momo");
        else await completeRefund(asString(payment.payment_id), asString(payment.order_id), Number(refund.amount), status.provider_ref, provider.toLowerCase() as "vnpay" | "momo");
        settled += 1;
      } else if (status.outcome === "refused") {
        await updateReturnRefundOperation(refund, { status: "failed", provider_ref: status.provider_ref });
        await markRefundFailed(asString(payment.order_id), payment, status.message);
        // Cổng chính thức từ chối: báo khách để họ biết tiền sẽ đi đường chuyển khoản tay, đồng thời
        // mở đường ghi nhận thủ công theo migration 113 (cần một lệnh 'failed' tồn tại).
        if (refund.return_id) void sendRefundSuccessEmail(asString(refund.return_id), { status: "failed", reason: status.message, returnItemId: asString(refund.return_item_id) || undefined });
        refused += 1;
      } else {
        stillPending += 1;
      }
    } catch (error) {
      stillPending += 1;
      console.warn("[GATEWAY REFUND RECONCILE] check failed", {
        refund_id: refundId, provider, code: (error as { code?: string })?.code || "UNKNOWN"
      });
    }
  }
  return { checked, settled, refused, still_pending: stillPending };
}

/** Khởi động vòng đối soát VNPay/MoMo; không chạy khi cả hai nhà mạng đều tắt. */
export function startLocalGatewayReconciliation(
  intervalMs = Number(process.env.PAYMENT_GATEWAY_RECONCILE_INTERVAL_MS) || 3 * 60 * 1000
): ReturnType<typeof setInterval> | null {
  if (!(["VNPAY", "MOMO"] as const).some(code => localGatewayConfigured(code)) || !config.supabaseServiceRoleKey || intervalMs <= 0) return null;
  const run = () => {
    void reconcilePendingLocalGatewayPayments().then((result) => {
      if (result.paid > 0 || result.checked > 0) console.warn("[GATEWAY RECONCILE]", result);
    }).catch((error: unknown) => {
      console.error("[GATEWAY RECONCILE] run failed", { code: (error as { code?: string })?.code || "UNKNOWN" });
    });
    void reconcilePendingGatewayRefunds().then((result) => {
      if (result.settled > 0 || result.refused > 0 || result.checked > 0) console.warn("[GATEWAY REFUND RECONCILE]", result);
    }).catch((error: unknown) => {
      console.error("[GATEWAY REFUND RECONCILE] run failed", { code: (error as { code?: string })?.code || "UNKNOWN" });
    });
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
