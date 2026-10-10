import { HttpError, sendJson } from "../http.js";
import { selectRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import { buildWallet } from "./vouchers.js";
import { loadCategoryTree } from "./cart-catalog.js";
import { promotionLifecycle, toLifecycleInput } from "../pricing/promotion-lifecycle.js";
import type { EvaluatedVoucher } from "./voucher-engine.js";
import {
  asString,
  type AuthContext,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type JsonObject,
  type UserProfile
} from "../types.js";

/** Mã còn từ chừng này ngày trở xuống thì xếp vào nhóm "Sắp hết hạn". */
const ENDING_SOON_DAYS = 3;

/**
 * Lý do chỉ có nghĩa khi đã có giỏ hàng. Trang Ưu đãi chưa có giỏ nên không coi là bị chặn.
 */
const CART_DEPENDENT_REASONS = new Set(["MIN_ORDER_NOT_MET", "CATEGORY_MISMATCH"]);

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
  // đang có và điều kiện của từng mã, chưa gắn với một giỏ hàng cụ thể nào. Cây danh
  // mục tải kèm để mã theo danh mục nói được tên danh mục thay vì "danh mục khác".
  let promotions: JsonObject[] = [];
  let tree: CategoryTree = { pathById: new Map(), nameById: {} };
  try {
    const [promoResult, treeResult] = await Promise.all([
      selectRows("promotion", { is_active: "eq.true", limit: 100 }),
      loadCategoryTree().catch(() => ({ pathById: new Map(), nameById: {} }))
    ]);
    promotions = (promoResult.rows || []).sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0));
    tree = treeResult;
  } catch (err: unknown) {
    console.warn("[OFFERS] Failed to load promotions or categories:", err);
  }

  let walletItems: EvaluatedVoucher[] = [];
  try {
    const wallet = await buildWallet(context, 0, 0, { lines: [], categoryNameById: tree.nameById });
    walletItems = wallet.items;
  } catch (err: unknown) {
    console.warn("[OFFERS] Failed to build wallet for offers:", err);
  }
  // Cùng quy tắc vòng đời với bảng chiến dịch bên admin: chiến dịch cạn ngân sách vẫn
  // còn cờ bật nhưng không còn giảm được, nên không được mời khách vào.
  const campaigns = (promotions || [])
    .filter((promotion) => promotionLifecycle(toLifecycleInput(promotion), now) === "running")
    .map((promotion) => toCampaignCard(promotion, now));
  const isMember = Boolean(profile?.user_id);

  return sendJson(res, 200, {
    success: true,
    generated_at: now.toISOString(),
    is_member: isMember,
    featured: campaigns.filter((campaign) => campaign.is_featured),
    campaigns,
    vouchers: walletItems.map((item) => toVoucherCard(item, now, isMember)),
    birthday_prompt: buildBirthdayPrompt(profile, now)
  }, corsHeaders);
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

/**
 * Nhóm hiển thị của một mã trên trang Ưu đãi.
 *
 * "Dành riêng cho bạn" là mã nhắm một nhóm khách cụ thể mà khách đang đăng nhập đạt,
 * không phải mã mở cho mọi khách. Mã sắp hết hạn tách riêng để khách thấy trước.
 */
export function voucherGroup(item: Pick<EvaluatedVoucher, "audience" | "endDate"> & { code?: string }, usable: boolean, isMember: boolean, now: Date): "personal" | "ending" | "running" {
  if (item.code && (item.code.toUpperCase().startsWith("HPBD") || item.code.toUpperCase().includes("SINHNHAT"))) {
    return "personal";
  }
  const daysLeft = item.endDate ? (new Date(item.endDate).getTime() - now.getTime()) / 86400000 : null;
  if (daysLeft !== null && daysLeft <= ENDING_SOON_DAYS) return "ending";
  if (isMember && usable && item.audience !== "all_users") return "personal";
  return "running";
}

export function toVoucherCard(item: EvaluatedVoucher, now: Date, isMember: boolean): JsonObject {
  const cartDependent = item.reason !== null && CART_DEPENDENT_REASONS.has(item.reason);
  const usable = item.eligible || cartDependent;
  const conditions = [
    item.minOrderValue > 0 ? `Đơn tối thiểu ${formatMoney(item.minOrderValue)}` : "Không yêu cầu giá trị tối thiểu",
    item.categoryNames.length ? `Áp cho ${item.categoryNames.join(", ")}` : null
  ].filter(Boolean);
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
    // Ở trang Ưu đãi, "đơn chưa đủ tiền" hay "giỏ chưa có sản phẩm thuộc danh mục" chưa
    // phải là lỗi — khách chưa có giỏ hàng nào. Chỉ các lý do thật sự chặn mới hạ trạng thái.
    usable,
    blocked_reason: usable ? null : item.reasonText,
    category_names: item.categoryNames,
    group: voucherGroup(item, usable, isMember, now),
    condition_text: conditions.join(" · ")
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

export function buildBirthdayPrompt(profile: UserProfile | null, now: Date): JsonObject | null {
  const isMember = Boolean(profile?.user_id);
  const fullName = profile?.full_name ? String(profile.full_name).trim() : "bạn";

  if (!profile || !profile.user_id) {
    return {
      title: "Đặc quyền sinh nhật thành viên",
      description: "Đăng ký hoặc đăng nhập tài khoản Velura để nhận voucher giảm 20% và quà tặng đặc quyền trong tháng sinh nhật của bạn.",
      action_label: "Đăng nhập / Đăng ký",
      action_route: "/auth/signin?returnUrl=/offers",
      is_birthday_month: false
    };
  }

  const rawBirthday = profile.date_of_birth || profile.birthday || profile.birthdate || profile.dob;
  if (!rawBirthday) {
    return {
      title: "Ưu đãi sinh nhật thành viên",
      description: "Bổ sung ngày sinh trong hồ sơ cá nhân để Velura chuẩn bị voucher giảm 20% và quà tặng riêng trong tháng sinh nhật của bạn.",
      action_label: "Bổ sung ngày sinh",
      action_route: "/account/profile",
      is_birthday_month: false
    };
  }

  const d = new Date(String(rawBirthday));
  if (isNaN(d.getTime())) {
    return {
      title: "Ưu đãi sinh nhật",
      description: "Bổ sung ngày sinh hợp lệ trong hồ sơ để nhận quà sinh nhật từ Velura.",
      action_label: "Cập nhật ngày sinh",
      action_route: "/account/profile",
      is_birthday_month: false
    };
  }

  const birthDay = d.getDate();
  const birthMonth = d.getMonth() + 1;
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const isBirthdayMonth = birthMonth === currentMonth;
  const isBirthdayToday = isBirthdayMonth && birthDay === currentDay;

  if (isBirthdayMonth) {
    const todayGreeting = isBirthdayToday
      ? `🎂 Chúc mừng sinh nhật ${fullName} hôm nay!`
      : `🎉 Chúc mừng tháng sinh nhật của ${fullName}!`;
    return {
      title: todayGreeting,
      description: `Tháng ${currentMonth} này là tháng sinh nhật của bạn! Velura gửi tặng bạn mã voucher đặc quyền HPBD2026 (giảm 20% tối đa 200.000đ) áp dụng cho mọi đơn hàng trong suốt tháng!`,
      action_label: "Xem voucher sinh nhật",
      action_route: "/account/vouchers",
      is_birthday_month: true,
      voucher_code: "HPBD2026"
    };
  }

  return {
    title: `Đặc quyền sinh nhật đã kích hoạt 🎂`,
    description: `Ngày sinh của bạn: ${String(birthDay).padStart(2, '0')}/${String(birthMonth).padStart(2, '0')}. Món quà sinh nhật đặc biệt cùng voucher giảm 20% sẽ tự động được gửi tặng vào đầu tháng ${birthMonth}!`,
    action_label: "Xem hồ sơ cá nhân",
    action_route: "/account/profile",
    is_birthday_month: false
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
