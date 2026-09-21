import { callRpc, selectOne, selectRows, insertRow } from "../supabase.js";
import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { asJsonObject, asString, type JsonObject } from "../types.js";
import { PRICE_HISTORY_SELECT, PROMOTION_SELECT, VOUCHER_SELECT } from "./pricing-constants.js";

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
      return selectRows("promotion", query, authOptions(accessToken));
    },

    /**
     * Lấy các cột đủ để tính vòng đời và ngân sách của TOÀN BỘ chiến dịch.
     *
     * Các chỉ số ở đầu trang Khuyến mãi — đang chạy, tạm dừng, tổng ngân sách, đã phát
     * ra — trước đây được cộng trên `rows` của trang hiện tại, tức trên đúng 10 bản
     * ghi. Sang trang 2 là bốn con số đổi hết, và với hơn 10 chiến dịch thì không con
     * số nào đúng. Truy vấn này chỉ lấy 6 cột nên nhẹ hơn hẳn việc tải cả danh sách.
     */
    async summarizePromotions(accessToken: string | null) {
      return selectRows("promotion", {
        select: "promo_id,start_date,end_date,is_active,paused_at,budget_limit,total_discount_issued",
        limit: 1000
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
      return withPricingError(async () => {
        const result = await insertRow("promotion", {
          promo_id: randomUUID(),
          promo_name: input.name,
          promo_type: input.type || "product_discount",
          applicable_categories: input.applicableCategories || null,
          start_date: input.startDate,
          end_date: input.endDate,
          is_active: false,
          budget_limit: input.budgetLimit || 0,
          max_vouchers_allowed: input.maxVouchersAllowed || 0,
          total_discount_issued: 0,
          created_by: input.createdBy || null,
          version: 1,
          // Nội dung marketing của chiến dịch. Trang Ưu đãi phía khách đọc thẳng từ
          // đây, nên chiến dịch tạo ra là hiển thị được ngay, không cần sửa mã nguồn.
          description: input.description || null,
          banner_image_url: input.bannerImageUrl || null,
          highlight_label: input.highlightLabel || null,
          display_order: Number(input.displayOrder) || 0,
          is_featured: input.isFeatured === true
        }, accessToken as never);
        return result;
      });
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
      return callRpc("admin_activate_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async pausePromotion(promotionId: string, input: JsonObject, accessToken: string | null) {
      return callRpc("admin_pause_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken });
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
      return withPricingError(async () => {
        const voucherId = randomUUID();
        const result = await insertRow("voucher", {
          voucher_id: voucherId,
          code: input.code,
          name: input.name,
          promo_id: input.promoId || null,
          discount_type: input.type,
          discount_value: input.value,
          max_discount_amount: input.maxDiscount || null,
          min_order_value: input.minOrderValue || 0,
          usage_limit_total: input.maxUses || null,
          usage_limit_per_user: input.maxPerUser || 1,
          used_count: 0,
          applicable_categories: input.applicableCategories || null,
          applicable_user_group: input.applicableUserGroup || "all_users",
          start_date: input.startDate,
          end_date: input.endDate,
          is_active: true,
          created_by: input.createdBy || null,
          version: 1
        }, accessToken as never);
        return result;
      });
    },

    async updateVoucher(voucherId: string, input: JsonObject, accessToken: string | null) {
      return callRpc("admin_update_voucher", {
        p_voucher_id: voucherId,
        p_expected_version: input.expectedVersion,
        p_is_active: input.isActive,
        p_name: input.name
      }, { accessToken });
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
    RBAC_DENIED: "Only pricing operator or super admin can manage pricing",
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
    VOUCHER_NOT_FOUND: "Không tìm thấy mã giảm giá."
  };
  return messages[code] || "Pricing database operation failed";
}
