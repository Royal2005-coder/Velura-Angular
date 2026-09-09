import { HttpError, sendJson } from "../http.js";
import { selectRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";

const OFFER_STATUSES = Object.freeze({
  LOCKED: "LOCKED",
  AVAILABLE: "AVAILABLE",
  USED: "USED",
  EXPIRED: "EXPIRED",
  SCHEDULED: "SCHEDULED"
});

export async function handleOffersRoute(req, res, corsHeaders, context) {
  if (req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ");
  }

  const profile = requireUserAuth(context);
  const now = new Date();
  const [{ rows: vouchers }, { rows: orders }] = await Promise.all([
    selectRows("voucher", { limit: 500 }),
    selectRows("orders", { user_id: `eq.${profile.user_id}`, limit: 500 })
  ]);

  const usedVoucherIds = new Set(
    orders.filter((order) => ["completed", "delivered"].includes(order.status) && order.voucher_id)
      .map((order) => String(order.voucher_id))
  );

  const items = (vouchers || []).map((voucher) => normalizeVoucher(voucher, now, usedVoucherIds));
  const birthday = profile.date_of_birth || profile.birthday || profile.birthdate || profile.dob;
  if (!birthday) {
    items.unshift({
      id: "birthday-profile",
      type: "birthday",
      title: "Ưu đãi sinh nhật",
      description: "Bổ sung ngày sinh để Velura chuẩn bị voucher và quà trong tháng sinh nhật.",
      status: OFFER_STATUSES.LOCKED,
      action: { label: "Bổ sung ngày sinh", href: "/src/pages/offers.html?offer=A1" },
      terms: ["Giảm 15% cho đơn từ 500.000đ, tối đa 300.000đ.", "Mỗi tháng sinh nhật dùng một lần."]
    });
  }

  return sendJson(res, 200, {
    success: true,
    generated_at: now.toISOString(),
    offers: items.sort(sortOffers)
  }, corsHeaders);
}

function normalizeVoucher(voucher, now, usedVoucherIds) {
  const start = voucher.start_date ? new Date(voucher.start_date) : null;
  const end = voucher.end_date ? new Date(voucher.end_date) : null;
  const exhausted = voucher.usage_limit_total !== null && voucher.usage_limit_total !== undefined
    && Number(voucher.used_count || 0) >= Number(voucher.usage_limit_total);
  let status = OFFER_STATUSES.AVAILABLE;
  if (usedVoucherIds.has(String(voucher.voucher_id))) status = OFFER_STATUSES.USED;
  else if (exhausted || (end && end < now) || voucher.is_active === false) status = OFFER_STATUSES.EXPIRED;
  else if (start && start > now) status = OFFER_STATUSES.SCHEDULED;

  return {
    id: voucher.voucher_id,
    type: voucher.discount_type || "voucher",
    title: formatVoucherTitle(voucher),
    code: voucher.code || null,
    description: describeDiscount(voucher),
    status,
    valid_from: voucher.start_date || null,
    valid_until: voucher.end_date || null,
    min_order_value: Number(voucher.min_order_value || 0),
    max_discount_amount: voucher.max_discount_amount ? Number(voucher.max_discount_amount) : null,
    terms: [
      Number(voucher.min_order_value || 0) > 0 ? `Đơn tối thiểu ${formatMoney(voucher.min_order_value)}.` : "Không yêu cầu giá trị tối thiểu.",
      voucher.end_date ? `Hết hạn ${new Date(voucher.end_date).toLocaleDateString("vi-VN")}.` : "Áp dụng đến khi chương trình kết thúc."
    ],
    action: status === OFFER_STATUSES.AVAILABLE
      ? { label: "Dùng ngay", href: "/src/pages/cart.html" }
      : { label: "Xem chi tiết", href: "/src/pages/offers.html" }
  };
}

function formatVoucherTitle(voucher) {
  const titlesByCode = {
    SALE50K: "Giảm 50K cho đơn từ 500K",
    SUMMER25: "Giảm 25% mùa hè",
    VIP200K: "Ưu đãi VIP giảm 200K",
    FREESHIP: "Miễn phí vận chuyển",
    WELCOME10: "Giảm 10% cho khách mới",
    WELCOME100: "Giảm 10% cho khách mới"
  };
  const code = String(voucher.code || "").trim().toUpperCase();
  return titlesByCode[code] || voucher.name || voucher.code || "Ưu đãi Velura";
}

function describeDiscount(voucher) {
  if (voucher.discount_type === "free_shipping") return "Miễn phí vận chuyển cho đơn đủ điều kiện.";
  if (voucher.discount_type === "percentage") {
    const cap = voucher.max_discount_amount ? `, tối đa ${formatMoney(voucher.max_discount_amount)}` : "";
    return `Giảm ${Number(voucher.discount_value || 0)}%${cap}.`;
  }
  return `Giảm ${formatMoney(voucher.discount_value || 0)}.`;
}

function sortOffers(a, b) {
  const rank = { AVAILABLE: 0, LOCKED: 1, SCHEDULED: 2, USED: 3, EXPIRED: 4 };
  return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}
