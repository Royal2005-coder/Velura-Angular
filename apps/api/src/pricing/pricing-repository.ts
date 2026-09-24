import { callRpc, selectOne, selectRows } from "../supabase.js";
import { HttpError } from "../http.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { PRICE_HISTORY_SELECT, PROMOTION_SELECT, VOUCHER_SELECT } from "./pricing-constants.js";

/**
 * Số chiến dịch tối đa kéo về để tính chỉ số tổng hợp và phát hiện chồng lấn.
 *
 * Một truy vấn không có trần là một truy vấn sẽ đổ sập vào một ngày nào đó. Tổng số
 * chiến dịch vẫn luôn đúng vì đọc từ `count` của PostgREST; chỉ phần bóc tách theo
 * trạng thái là giới hạn trong khoảng này, và tầng dịch vụ nói rõ điều đó qua cờ
 * `truncated`.
 */
export const PROMOTION_SUMMARY_CAP = 1000;

/**
 * PostgREST pricing repository used by `createPricingService`.
 */
export type PricingRepository = ReturnType<typeof createPricingRepository>;

/**
 * Create the pricing / promotion / voucher PostgREST repository.
 */
export function createPricingRepository() {
  return {
    async listPriceHistory(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: PRICE_HISTORY_SELECT,
        order: "changed_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.productId) query.product_id = `eq.${filters.productId}`;
      return selectRows("price_history", query, authOptions(accessToken));
    },

    async changePrice(productId: string, input: JsonObject, accessToken: string | null) {
      return withPricingError(() => callRpc("admin_change_product_price", {
        p_product_id: productId,
        p_new_base_price: input.newBasePrice,
        p_new_sale_price: input.newSalePrice,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken }));
    },

    async listPromotions(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: PROMOTION_SELECT,
        order: "start_date.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      // Lọc theo loại chiến dịch, dùng cho tab Combo trên màn khuyến mãi.
      if (filters.type) query.promo_type = `eq.${filters.type}`;
      return selectRows("promotion", query, authOptions(accessToken));
    },

    /**
     * Lấy các cột đủ để tính vòng đời và ngân sách của TOÀN BỘ chiến dịch.
     *
     * Trần `PROMOTION_SUMMARY_CAP` là giới hạn thật: quá số đó thì phần đếm theo trạng
     * thái và phần phát hiện chồng lấn chỉ xét trong khoảng đã lấy. `count` trả về từ
     * PostgREST vẫn là con số đúng nên tổng số chiến dịch không bao giờ sai; tầng dịch
     * vụ dùng `count` cho tổng và báo `truncated` khi vượt trần.
     *
     * Các chỉ số ở đầu trang Khuyến mãi — đang chạy, tạm dừng, tổng ngân sách, đã phát
     * ra — trước đây được cộng trên `rows` của trang hiện tại, tức trên đúng 10 bản
     * ghi. Sang trang 2 là bốn con số đổi hết, và với hơn 10 chiến dịch thì không con
     * số nào đúng. Truy vấn này chỉ lấy 6 cột nên nhẹ hơn hẳn việc tải cả danh sách.
     */
    async summarizePromotions(accessToken: string | null) {
      return selectRows("promotion", {
        // `promo_name` và `applicable_categories` cũng có ở đây vì cùng truy vấn này
        // dùng để phát hiện chiến dịch chồng lấn — xem `overlapWarning`.
        select: "promo_id,promo_name,applicable_categories,start_date,end_date,is_active,paused_at,budget_limit,total_discount_issued",
        // Sắp xếp để việc cắt ở `limit` là xác định: không có `order` thì PostgREST
        // trả về 1000 dòng nào là chuyện của bộ tối ưu, và mỗi lần tải lại có thể ra
        // một tập khác.
        order: "start_date.desc",
        limit: PROMOTION_SUMMARY_CAP
      }, { ...authOptions(accessToken), count: "exact" });
    },

    /**
     * Đếm số mã còn hiệu lực trên toàn hệ thống.
     */
    async countActiveVouchers(accessToken: string | null) {
      return selectRows("voucher", {
        select: "voucher_id",
        is_active: "eq.true",
        limit: 1
      }, authOptions(accessToken));
    },

    /**
     * Đếm số mã của từng chiến dịch, tách riêng số mã còn hiệu lực.
     *
     * Ngân sách chiến dịch chỉ tăng khi có người dùng mã của nó
     * (`velura_record_voucher_redemption`). Chiến dịch chưa phát mã nào thì cột ngân
     * sách vĩnh viễn đứng yên — hiện thanh tiến độ ở đó là nói dối người vận hành rằng
     * hệ thống đang theo dõi. Đếm ở đây để nói đúng thực tế.
     */
    async countVouchersByPromotion(
      promoIds: readonly string[],
      accessToken: string | null
    ): Promise<Record<string, { total: number; active: number }>> {
      if (!promoIds.length) return {};
      const result = await selectRows("voucher", {
        select: "promo_id,is_active",
        promo_id: `in.(${promoIds.join(",")})`,
        limit: 1000
      }, { ...authOptions(accessToken), count: "none" });

      const stats: Record<string, { total: number; active: number }> = {};
      for (const row of result.rows || []) {
        const promoId = asString(row.promo_id);
        if (!promoId) continue;
        const entry = stats[promoId] || { total: 0, active: 0 };
        entry.total += 1;
        if (row.is_active !== false) entry.active += 1;
        stats[promoId] = entry;
      }
      return stats;
    },

    async getPromotion(promotionId: string, accessToken: string | null) {
      return selectOne("promotion", {
        select: PROMOTION_SELECT,
        promo_id: `eq.${promotionId}`
      }, authOptions(accessToken));
    },

    async createPromotion(input: JsonObject, accessToken: string | null) {
      // Đi qua RPC để hàm tự kiểm vai trò người gọi và ghi nhật ký (BR-A4-08). Trước đây
      // ghi thẳng bằng khoá service-role nên bỏ qua RLS và không có dòng nhật ký nào.
      return withPricingError(() => callRpc("admin_create_promotion", {
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_promo_type: input.type || "product_discount",
        p_description: input.description ?? null,
        p_applicable_categories: input.applicableCategories || null,
        p_budget_limit: Number(input.budgetLimit) || 0,
        p_max_vouchers_allowed: Number(input.maxVouchersAllowed) || 0,
        p_banner_image_url: input.bannerImageUrl ?? null,
        p_highlight_label: input.highlightLabel ?? null,
        p_display_order: Number(input.displayOrder) || 0,
        p_is_featured: input.isFeatured === true
      }, { accessToken }));
    },

    async updatePromotion(promotionId: string, input: JsonObject, accessToken: string | null) {
      // Trường bỏ trống (null) nghĩa là giữ nguyên; chuỗi rỗng là lệnh xoá. Quy ước này
      // nằm trong RPC `admin_update_promotion` — xem migration 027.
      return withPricingError(() => callRpc("admin_update_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion,
        p_name: input.name,
        p_description: input.description,
        p_applicable_categories: input.applicableCategories,
        p_budget_limit: input.budgetLimit,
        p_banner_image_url: input.bannerImageUrl,
        p_highlight_label: input.highlightLabel,
        p_display_order: input.displayOrder,
        p_is_featured: input.isFeatured,
        p_start_date: input.startDate,
        p_end_date: input.endDate
      }, { accessToken }));
    },

    async activatePromotion(promotionId: string, input: JsonObject, accessToken: string | null) {
      return withPricingError(() => callRpc("admin_activate_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken }));
    },

    async pausePromotion(promotionId: string, input: JsonObject, accessToken: string | null) {
      return withPricingError(() => callRpc("admin_pause_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken }));
    },

    async listVouchers(filters: JsonObject, accessToken: string | null) {
      const query: Record<string, unknown> = {
        select: VOUCHER_SELECT,
        order: "start_date.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      return selectRows("voucher", query, authOptions(accessToken));
    },

    async getVoucher(voucherId: string, accessToken: string | null) {
      return selectOne("voucher", {
        select: VOUCHER_SELECT,
        voucher_id: `eq.${voucherId}`
      }, authOptions(accessToken));
    },

    async createVoucher(input: JsonObject, accessToken: string | null) {
      // RPC tự kiểm vai trò, kiểm trùng mã không phân biệt hoa thường, kiểm danh mục tồn
      // tại, và chốt trần `max_vouchers_allowed` trong lúc khoá dòng chiến dịch.
      return withPricingError(() => callRpc("admin_create_voucher", {
        p_code: input.code,
        p_name: input.name || input.code,
        p_discount_type: input.type,
        p_discount_value: Number(input.value) || 0,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_promo_id: input.promoId || null,
        p_max_discount_amount: optionalNumber(input.maxDiscount),
        p_min_order_value: Number(input.minOrderValue) || 0,
        p_usage_limit_total: optionalNumber(input.maxUses),
        p_usage_limit_per_user: Number(input.maxPerUser) || 1,
        p_applicable_categories: input.applicableCategories || null,
        p_applicable_user_group: input.applicableUserGroup || "all_users"
      }, { accessToken }));
    },

    async updateVoucher(voucherId: string, input: JsonObject, accessToken: string | null) {
      // Tham số không gửi (null) là giữ nguyên. Ba trường "không giới hạn" có cờ xoá riêng
      // vì null đã mang nghĩa giữ nguyên — xem migration 035.
      return withPricingError(() => callRpc("admin_update_voucher", {
        p_voucher_id: voucherId,
        p_expected_version: input.expectedVersion,
        p_is_active: optionalBoolean(input.isActive),
        p_name: input.name ?? null,
        p_discount_type: input.type ?? null,
        p_discount_value: optionalNumber(input.value),
        p_max_discount_amount: optionalNumber(input.maxDiscount),
        p_clear_max_discount: input.clearMaxDiscount === true,
        p_min_order_value: optionalNumber(input.minOrderValue),
        p_usage_limit_total: optionalNumber(input.maxUses),
        p_clear_usage_limit_total: input.clearMaxUses === true,
        p_usage_limit_per_user: optionalNumber(input.maxPerUser),
        p_applicable_user_group: input.applicableUserGroup ?? null,
        p_applicable_categories: input.applicableCategories ?? null,
        p_start_date: input.startDate ?? null,
        p_end_date: input.endDate ?? null,
        p_promo_id: input.promoId || null,
        p_clear_promo: input.clearPromo === true
      }, { accessToken }));
    },

    async listAuditLogs(filters: JsonObject, accessToken: string | null) {
      return selectRows("audit_log", {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        or: "(module.eq.pricing,module.eq.promotions,module.eq.vouchers)",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      }, authOptions(accessToken));
    },

    async getStatistics(accessToken: string | null) {
      const opts = authOptions(accessToken);
      const [promos, vouchers] = await Promise.all([
        selectRows("promotion", { select: PROMOTION_SELECT, limit: 500 }, opts),
        selectRows("voucher", { select: VOUCHER_SELECT, limit: 500 }, opts)
      ]);
      const promoRows = promos?.rows || [];
      const voucherRows = vouchers?.rows || [];
      const activePromos = promoRows.filter((p) => p.is_active);
      const pausedPromos = promoRows.filter((p) => !p.is_active);
      const totalBudget = promoRows.reduce((s, p) => s + Number(p.budget_limit || 0), 0);
      const totalIssued = promoRows.reduce((s, p) => s + Number(p.total_discount_issued || 0), 0);
      const activeVouchers = voucherRows.filter((v) => v.is_active);
      const expiredVouchers = voucherRows.filter((v) => !v.is_active || new Date(v.end_date as string) < new Date());
      const totalUsed = voucherRows.reduce((s, v) => s + Number(v.used_count || 0), 0);
      const totalLimit = voucherRows.reduce((s, v) => s + Number(v.usage_limit_total || 0), 0);
      return {
        promotions: {
          total: promoRows.length,
          active: activePromos.length,
          paused: pausedPromos.length,
          totalBudget,
          totalIssued,
          budgetRemaining: totalBudget - totalIssued,
          budgetUsagePercent: totalBudget > 0 ? Math.round(totalIssued * 100 / totalBudget) : 0
        },
        vouchers: {
          total: voucherRows.length,
          active: activeVouchers.length,
          expired: expiredVouchers.length,
          totalUsed,
          totalLimit,
          usagePercent: totalLimit > 0 ? Math.round(totalUsed * 100 / totalLimit) : 0
        }
      };
    }
  };
}

/** Số từ body, hoặc null khi không gửi. Khác `Number(x) || 0` ở chỗ 0 vẫn là 0. */
function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function authOptions(accessToken: string | null | undefined) {
  return { useAnonKey: true, accessToken };
}

async function withPricingError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const details = asJsonObject(error.details);
      const databaseCode = asString(details.message) || asString(details.code) || "PRICING_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, databaseCode, pricingErrorMessage(databaseCode), error.details);
    }
    throw error;
  }
}

function pricingErrorMessage(code: string): string {
  // Ghi chú: các dòng tiếng Anh bên dưới là nội dung có sẵn của luồng đổi giá. Giao diện
  // quản trị hiển thị thẳng chuỗi này cho người vận hành, nên phần bổ sung cho khuyến mãi
  // viết bằng tiếng Việt. Dịch nốt phần cũ là một việc riêng, không gộp vào thay đổi này.
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Authentication is required",
    RBAC_DENIED: "Chỉ quản trị viên giá và khuyến mãi hoặc super admin được thao tác phần này.",
    PRODUCT_NOT_FOUND: "Product was not found",
    // Mã này giờ dùng chung cho cả đổi giá lẫn sửa chiến dịch, nên nội dung không được
    // nhắc riêng giá sản phẩm nữa.
    VERSION_CONFLICT: "Dữ liệu đã được người khác thay đổi. Hãy tải lại rồi lưu lại.",
    PRICE_REQUIRED: "Base price and sale price are required",
    PRICE_NON_NEGATIVE: "Prices must be non-negative",
    SALE_PRICE_ABOVE_BASE_PRICE: "Sale price cannot be higher than base price",
    REASON_MIN_10_CHARS: "Reason must be at least 10 characters",

    PROMOTION_NOT_FOUND: "Không tìm thấy chiến dịch khuyến mãi.",
    HIGHLIGHT_LABEL_TOO_LONG: "Nhãn nổi bật tối đa 60 ký tự.",
    DISPLAY_ORDER_NEGATIVE: "Thứ tự hiển thị không được là số âm.",
    BUDGET_LIMIT_NEGATIVE: "Ngân sách chiến dịch không được là số âm.",
    BANNER_URL_INVALID: "Ảnh banner phải là đường dẫn http(s) hoặc bắt đầu bằng /.",
    BUDGET_BELOW_ISSUED: "Ngân sách mới thấp hơn số tiền đã giảm cho khách. Hãy đặt mức bằng hoặc cao hơn phần đã phát.",
    END_DATE_BEFORE_START_DATE: "Ngày kết thúc phải sau ngày bắt đầu.",
    BUDGET_EXHAUSTED: "Chiến dịch đã tiêu hết ngân sách. Hãy nâng ngân sách trước khi chạy lại.",
    ALREADY_ACTIVE: "Chiến dịch đang chạy rồi.",
    NOT_ACTIVE: "Chiến dịch đang không chạy.",
    OUTSIDE_DATE_RANGE: "Thời điểm hiện tại nằm ngoài khoảng ngày của chiến dịch.",
    VOUCHER_NOT_FOUND: "Không tìm thấy mã giảm giá.",
    NAME_MIN_8_CHARS: "Tên chiến dịch tối thiểu 8 ký tự.",
    DATES_REQUIRED: "Cần nhập ngày bắt đầu và ngày kết thúc.",
    MAX_VOUCHERS_NEGATIVE: "Số mã tối đa không được là số âm.",
    CATEGORIES_MUST_BE_ARRAY: "Danh mục áp dụng phải là một danh sách.",
    CATEGORY_NOT_FOUND: "Có danh mục áp dụng không tồn tại.",
    CODE_REQUIRED: "Mã giảm giá là bắt buộc.",
    VOUCHER_CODE_EXISTS: "Mã này đã tồn tại. Chọn một mã khác.",
    DISCOUNT_VALUE_REQUIRED: "Giá trị giảm phải lớn hơn 0.",
    PERCENTAGE_OVER_100: "Giảm theo phần trăm không được vượt 100%.",
    AMOUNT_NEGATIVE: "Số tiền không được là số âm.",
    USAGE_LIMIT_INVALID: "Số lượt dùng phải từ 1 trở lên.",
    USAGE_LIMIT_BELOW_USED: "Tổng lượt mới thấp hơn số lượt khách đã dùng.",
    VOUCHER_LIMIT_REACHED: "Chiến dịch đã phát đủ số mã tối đa. Nâng trần số mã của chiến dịch trước."
  };
  return messages[code] || "Pricing database operation failed";
}
