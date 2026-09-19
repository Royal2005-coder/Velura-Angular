import { HttpError, readJson, sendJson } from "../http.js";
import { callRpc, selectRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import {
  buildPromotionBudgetMap,
  buildUsageMap,
  evaluateVouchers,
  normalizeShippingFee,
  pickBestVoucher,
  type EvaluatedVoucher,
  type VoucherEvaluationContext
} from "./voucher-engine.js";
import {
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject,
  type UserProfile
} from "../types.js";

/**
 * Ví voucher và engine chọn mã tốt nhất — dùng chung cho khách vãng lai và thành viên.
 *
 * Ba đường vào đều chạy qua cùng một bộ đánh giá (`voucher-engine`) nên số tiền giảm
 * hiển thị ở ví luôn khớp với số tiền thực trừ khi đặt hàng.
 *
 * - `GET  /api/user/vouchers`        → ví voucher, kèm lý do từng mã chưa dùng được
 * - `POST /api/user/vouchers/best`   → hệ thống tự chọn mã lợi nhất
 * - `POST /api/user/vouchers/apply`  → khách chủ động chọn một mã cụ thể
 */
export async function handleVouchersRoute(
  req: HttpRequest,
  res: HttpResponse,
  action: string | undefined,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (!action && req.method === "GET") {
    const orderValue = toAmount(readQueryParam(req, "orderValue"));
    const shippingFee = normalizeShippingFee(readQueryParam(req, "shippingFee"));
    const wallet = await buildWallet(context, orderValue, shippingFee);
    return sendJson(res, 200, {
      success: true,
      order_value: orderValue,
      shipping_fee: shippingFee,
      best_voucher_id: wallet.best?.voucherId || null,
      eligible_count: wallet.items.filter((item) => item.eligible).length,
      vouchers: wallet.items.map(toWireFormat)
    }, corsHeaders);
  }

  if (action === "best" && req.method === "POST") {
    const body = await readJson(req) as JsonObject;
    const orderValue = toAmount(body.order_value);
    const shippingFee = normalizeShippingFee(body.shipping_fee);
    const wallet = await buildWallet(context, orderValue, shippingFee);

    if (!wallet.best) {
      return sendJson(res, 200, {
        success: true,
        applied: false,
        message: "Chưa có mã nào phù hợp với đơn hàng hiện tại.",
        vouchers: wallet.items.map(toWireFormat)
      }, corsHeaders);
    }

    return sendJson(res, 200, {
      success: true,
      applied: true,
      ...toAppliedFormat(wallet.best),
      vouchers: wallet.items.map(toWireFormat)
    }, corsHeaders);
  }

  if (action === "apply" && req.method === "POST") {
    const body = await readJson(req) as JsonObject;
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) throw new HttpError(400, "BAD_REQUEST", "Mã giảm giá là bắt buộc");

    const orderValue = toAmount(body.order_value);
    const shippingFee = normalizeShippingFee(body.shipping_fee);
    const wallet = await buildWallet(context, orderValue, shippingFee);
    const match = wallet.items.find((item) => item.code.toUpperCase() === code);

    if (!match) throw new HttpError(404, "NOT_FOUND", "Mã giảm giá không tồn tại");
    if (!match.eligible) {
      throw new HttpError(400, "INVALID_VOUCHER", match.reasonText || "Mã giảm giá không dùng được cho đơn này");
    }

    return sendJson(res, 200, {
      success: true,
      applied: true,
      ...toAppliedFormat(match)
    }, corsHeaders);
  }

  throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ");
}

/**
 * Dựng ví voucher cho người gọi hiện tại.
 *
 * Khách vãng lai vẫn nhận đủ danh sách mã công khai — chỉ khác ở chỗ không tra được
 * lịch sử dùng mã theo tài khoản, nên các mã giới hạn theo thành viên sẽ báo rõ là
 * cần đăng nhập thay vì biến mất khỏi danh sách.
 */
export async function buildWallet(
  context: AuthContext,
  orderValue: number,
  shippingFee: number
): Promise<{ items: EvaluatedVoucher[]; best: EvaluatedVoucher | null }> {
  const profile = resolveProfile(context);

  const [voucherResult, promotionResult, orderResult] = await Promise.all([
    selectRows("voucher", { is_active: "eq.true", limit: 200 }),
    selectRows("promotion", { limit: 200 }),
    profile?.user_id
      ? selectRows("orders", { user_id: `eq.${profile.user_id}`, limit: 500 })
      : Promise.resolve({ rows: [] as JsonObject[] })
  ]);

  const orders = orderResult.rows || [];
  const evaluationContext: VoucherEvaluationContext = {
    orderValue,
    shippingFee,
    now: new Date(),
    isMember: Boolean(profile?.user_id),
    isFirstOrder: countBillableOrders(orders) === 0,
    usageByVoucherId: buildUsageMap(orders),
    promotionBudgetByPromoId: buildPromotionBudgetMap(promotionResult.rows || [])
  };

  const items = evaluateVouchers(voucherResult.rows || [], evaluationContext);
  return { items, best: pickBestVoucher(items) };
}

/**
 * Ghi nhận một lượt dùng mã khi đơn hàng được tạo thành công.
 *
 * Gọi xuống RPC vì hai việc phải xảy ra nguyên tử: tăng lượt dùng của mã và cộng dồn
 * số tiền đã giảm vào ngân sách chiến dịch. Làm bằng đọc-rồi-ghi ở tầng ứng dụng thì
 * hai đơn đặt cùng lúc sẽ ghi đè lẫn nhau, và ngân sách sẽ không bao giờ khớp.
 *
 * Không ném lỗi ra ngoài: đơn hàng đã tạo xong rồi, một lỗi kế toán khuyến mãi không
 * được phép làm hỏng đơn của khách. Lỗi được ghi log để đối soát sau.
 */
export async function recordVoucherRedemption(
  voucherId: string,
  discountAmount: number
): Promise<void> {
  try {
    await callRpc("velura_record_voucher_redemption", {
      p_voucher_id: voucherId,
      p_discount_amount: Math.max(0, Math.round(Number(discountAmount) || 0))
    });
  } catch (error: unknown) {
    console.error("[voucher] redemption bookkeeping failed", voucherId, error);
  }
}

/**
 * Hoàn lại lượt dùng và ngân sách khi đơn bị hủy.
 */
export async function releaseVoucherRedemption(
  voucherId: string,
  discountAmount: number
): Promise<void> {
  try {
    await callRpc("velura_release_voucher_redemption", {
      p_voucher_id: voucherId,
      p_discount_amount: Math.max(0, Math.round(Number(discountAmount) || 0))
    });
  } catch (error: unknown) {
    console.error("[voucher] redemption release failed", voucherId, error);
  }
}

/**
 * Đơn đã hủy không tính là "đã từng mua", nên khách bị hủy đơn đầu tiên vẫn giữ
 * quyền dùng mã dành cho khách mới.
 */
function countBillableOrders(orders: readonly JsonObject[]): number {
  return orders.filter((order) => String(order.status) !== "cancelled").length;
}

function resolveProfile(context: AuthContext): UserProfile | null {
  try {
    return requireUserAuth(context);
  } catch {
    return null;
  }
}

function toWireFormat(item: EvaluatedVoucher): JsonObject {
  return {
    voucher_id: item.voucherId,
    promo_id: item.promoId,
    code: item.code,
    name: item.name,
    discount_type: item.discountType,
    discount_value: item.discountValue,
    max_discount_amount: item.maxDiscountAmount,
    min_order_value: item.minOrderValue,
    start_date: item.startDate,
    end_date: item.endDate,
    remaining_uses: item.remainingUses,
    eligible: item.eligible,
    discount_amount: item.discountAmount,
    reason: item.reason,
    reason_text: item.reasonText,
    shortfall: item.shortfall
  };
}

function toAppliedFormat(item: EvaluatedVoucher): JsonObject {
  return {
    voucher_id: item.voucherId,
    code: item.code,
    name: item.name,
    discount_amount: item.discountAmount,
    discount_type: item.discountType
  };
}

function readQueryParam(req: HttpRequest, key: string): string | null {
  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get(key);
}

function toAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
}
