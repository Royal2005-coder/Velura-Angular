import { HttpError, sendJson } from "../http.js";
import { selectRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import { buildWallet } from "./vouchers.js";
import {
  asString,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject,
  type UserProfile
} from "../types.js";

/** Ảnh mặc định theo loại chiến dịch, dùng khi admin chưa tải ảnh riêng. */
const DEFAULT_BANNER_BY_TYPE: Record<string, string> = {
  flash_sale: "/assets/offers/flash-sale.jpg",
  seasonal_sale: "/assets/offers/seasonal.jpg",
  combo_discount: "/assets/offers/combo.jpg",
  bulk_discount: "/assets/offers/bulk.jpg",
  product_discount: "/assets/offers/product.jpg"
};

/**
 * Trang Ưu đãi phía khách hàng — chạy bằng dữ liệu thật từ bảng chiến dịch và mã.
 *
 * Mở cho cả khách vãng lai: ưu đãi là công cụ thu hút khách mới, bắt đăng nhập mới
 * cho xem là tự chặn chính mình. Khách đã đăng nhập thì nhận thêm phần cá nhân hóa
 * (mã đã dùng, nhắc bổ sung ngày sinh).
 */
export async function handleOffersRoute(
  req: HttpRequest,
  res: HttpResponse,
  corsHeaders: HeaderMap,
  context: AuthContext
): Promise<void> {
  if (req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ");
  }

  const profile = resolveProfile(context);
  const now = new Date();

  // Đánh giá mã ở giá trị đơn bằng 0: ví voucher ở trang Ưu đãi cho khách xem mã nào
  // đang có và điều kiện của từng mã, chưa gắn với một giỏ hàng cụ thể nào.
  const [{ rows: promotions }, wallet] = await Promise.all([
    selectRows("promotion", { is_active: "eq.true", order: "display_order.asc", limit: 100 }),
    buildWallet(context, 0, 0)
  ]);

  const campaigns = (promotions || [])
    .filter((promotion) => isRunning(promotion, now))
    .map((promotion) => toCampaignCard(promotion, now));

  return sendJson(res, 200, {
    success: true,
    generated_at: now.toISOString(),
    is_member: Boolean(profile?.user_id),
    featured: campaigns.filter((campaign) => campaign.is_featured),
    campaigns,
    vouchers: wallet.items.map(toVoucherCard),
    birthday_prompt: buildBirthdayPrompt(profile)
  }, corsHeaders);
}

function isRunning(promotion: JsonObject, now: Date): boolean {
  const start = promotion.start_date ? new Date(String(promotion.start_date)) : null;
  const end = promotion.end_date ? new Date(String(promotion.end_date)) : null;
  if (start && start > now) return false;
  if (end && end < now) return false;
  return true;
}

function toCampaignCard(promotion: JsonObject, now: Date): JsonObject {
  const type = asString(promotion.promo_type) || "product_discount";
  const end = promotion.end_date ? new Date(String(promotion.end_date)) : null;
  const daysLeft = end ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000)) : null;

  return {
    promo_id: promotion.promo_id,
    title: asString(promotion.promo_name),
    description: asString(promotion.description) || null,
    type,
    banner_image_url: asString(promotion.banner_image_url) || DEFAULT_BANNER_BY_TYPE[type] || null,
    // Nhãn do admin đặt được ưu tiên; nếu bỏ trống thì tự sinh nhãn đếm ngược khi
    // chiến dịch sắp kết thúc, để khách thấy được tính cấp thiết mà admin không phải sửa tay.
    highlight_label: asString(promotion.highlight_label)
      || (daysLeft !== null && daysLeft <= 3 ? `Chỉ còn ${daysLeft} ngày` : null),
    is_featured: promotion.is_featured === true,
    start_date: promotion.start_date || null,
    end_date: promotion.end_date || null,
    days_left: daysLeft
  };
}

function toVoucherCard(item: {
  voucherId: string;
  promoId: string | null;
  code: string;
  name: string;
  discountType: string;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderValue: number;
  endDate: string | null;
  remainingUses: number | null;
  eligible: boolean;
  reason: string | null;
  reasonText: string | null;
}): JsonObject {
  return {
    voucher_id: item.voucherId,
    promo_id: item.promoId,
    code: item.code,
    name: item.name,
    description: describeDiscount(item),
    discount_type: item.discountType,
    min_order_value: item.minOrderValue,
    end_date: item.endDate,
    remaining_uses: item.remainingUses,
    // Ở trang Ưu đãi, "không dùng được vì đơn chưa đủ tiền" chưa phải là lỗi — khách
    // chưa có giỏ hàng nào. Chỉ các lý do thật sự chặn mới hạ trạng thái xuống.
    usable: item.eligible || item.reason === "MIN_ORDER_NOT_MET",
    blocked_reason: item.reason === "MIN_ORDER_NOT_MET" ? null : item.reasonText,
    condition_text: item.minOrderValue > 0
      ? `Đơn tối thiểu ${formatMoney(item.minOrderValue)}`
      : "Không yêu cầu giá trị tối thiểu"
  };
}

function describeDiscount(item: {
  discountType: string;
  discountValue: number;
  maxDiscountAmount: number | null;
}): string {
  if (item.discountType === "free_shipping") return "Miễn phí vận chuyển";
  if (item.discountType === "percentage") {
    const cap = item.maxDiscountAmount ? `, tối đa ${formatMoney(item.maxDiscountAmount)}` : "";
    return `Giảm ${item.discountValue}%${cap}`;
  }
  return `Giảm ${formatMoney(item.discountValue)}`;
}

function buildBirthdayPrompt(profile: UserProfile | null): JsonObject | null {
  if (!profile?.user_id) return null;
  const birthday = profile.date_of_birth || profile.birthday || profile.birthdate || profile.dob;
  if (birthday) return null;
  return {
    title: "Ưu đãi sinh nhật",
    description: "Bổ sung ngày sinh để Velura chuẩn bị voucher và quà trong tháng sinh nhật của bạn.",
    action_label: "Bổ sung ngày sinh",
    action_route: "/account/profile"
  };
}

function resolveProfile(context: AuthContext): UserProfile | null {
  try {
    return requireUserAuth(context);
  } catch {
    return null;
  }
}

function formatMoney(value: unknown): string {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}
