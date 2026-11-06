import { config } from "../config.js";
import { selectRows } from "../supabase.js";
import { asString } from "../types.js";
import { localGatewayConfigured, type LocalGateway } from "./local-gateways.js";
import { verifyLocalGatewayOrder } from "./local-gateway-verify.js";

/** Nghỉ giữa hai lần hỏi cùng một phiên, để không spam nhà mạng mỗi phút. */
const lastAttempt = new Map<string, number>();
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
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
