import { callRpc, selectOne, selectRows, insertRow } from "../supabase.js";
import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { PRICE_HISTORY_SELECT, PROMOTION_SELECT, VOUCHER_SELECT } from "./pricing-constants.js";

export function createPricingRepository() {
  return {
    async listPriceHistory(filters, accessToken) {
      const query = {
        select: PRICE_HISTORY_SELECT,
        order: "changed_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.productId) query.product_id = `eq.${filters.productId}`;
      return selectRows("price_history", query, authOptions(accessToken));
    },

    async changePrice(productId, input, accessToken) {
      return withPricingError(() => callRpc("admin_change_product_price", {
        p_product_id: productId,
        p_new_base_price: input.newBasePrice,
        p_new_sale_price: input.newSalePrice,
        p_reason: input.reason,
        p_expected_version: input.expectedVersion
      }, { accessToken }));
    },

    async listPromotions(filters, accessToken) {
      const query = {
        select: PROMOTION_SELECT,
        order: "start_date.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      return selectRows("promotion", query, authOptions(accessToken));
    },

    async getPromotion(promotionId, accessToken) {
      return selectOne("promotion", {
        select: PROMOTION_SELECT,
        promo_id: `eq.${promotionId}`
      }, authOptions(accessToken));
    },

    async createPromotion(input, accessToken) {
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
          version: 1
        }, accessToken);
        return result;
      });
    },

    async getPromotion(promotionId, accessToken) {
      return selectOne("promotion", {
        select: PROMOTION_SELECT,
        promo_id: `eq.${promotionId}`
      }, authOptions(accessToken));
    },

    async updatePromotion(promotionId, input, accessToken) {
      return callRpc("admin_update_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion,
        p_name: input.name,
        p_description: input.description,
        p_applicable_categories: input.applicableCategories,
        p_budget_limit: input.budgetLimit
      }, { accessToken });
    },

    async activatePromotion(promotionId, input, accessToken) {
      return callRpc("admin_activate_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async pausePromotion(promotionId, input, accessToken) {
      return callRpc("admin_pause_promotion", {
        p_promo_id: promotionId,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async listVouchers(filters, accessToken) {
      const query = {
        select: VOUCHER_SELECT,
        order: "start_date.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.isActive !== undefined) query.is_active = `eq.${filters.isActive}`;
      return selectRows("voucher", query, authOptions(accessToken));
    },

    async getVoucher(voucherId, accessToken) {
      return selectOne("voucher", {
        select: VOUCHER_SELECT,
        voucher_id: `eq.${voucherId}`
      }, authOptions(accessToken));
    },

    async createVoucher(input, accessToken) {
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
        }, accessToken);
        return result;
      });
    },

    async updateVoucher(voucherId, input, accessToken) {
      return callRpc("admin_update_voucher", {
        p_voucher_id: voucherId,
        p_expected_version: input.expectedVersion,
        p_is_active: input.isActive,
        p_name: input.name
      }, { accessToken });
    },

    async listAuditLogs(filters, accessToken) {
      return selectRows("audit_log", {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        or: "(module.eq.pricing,module.eq.promotions,module.eq.vouchers)",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset
      }, authOptions(accessToken));
    },

    async getStatistics(accessToken) {
      const opts = authOptions(accessToken);
      const [promos, vouchers] = await Promise.all([
        selectRows("promotion", { select: PROMOTION_SELECT, limit: 500 }, opts),
        selectRows("voucher", { select: VOUCHER_SELECT, limit: 500 }, opts)
      ]);
      const promoRows = promos?.rows || [];
      const voucherRows = vouchers?.rows || [];
      const activePromos = promoRows.filter(p => p.is_active);
      const pausedPromos = promoRows.filter(p => !p.is_active);
      const totalBudget = promoRows.reduce((s, p) => s + Number(p.budget_limit || 0), 0);
      const totalIssued = promoRows.reduce((s, p) => s + Number(p.total_discount_issued || 0), 0);
      const activeVouchers = voucherRows.filter(v => v.is_active);
      const expiredVouchers = voucherRows.filter(v => !v.is_active || new Date(v.end_date) < new Date());
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

function authOptions(accessToken) {
  return { useAnonKey: true, accessToken };
}

async function withPricingError(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError && error.code === "SUPABASE_ERROR") {
      const databaseCode = error.details?.message || error.details?.code || "PRICING_DATABASE_ERROR";
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      throw new HttpError(status, databaseCode, pricingErrorMessage(databaseCode), error.details);
    }
    throw error;
  }
}

function pricingErrorMessage(code) {
  const messages = {
    AUTH_REQUIRED: "Authentication is required",
    RBAC_DENIED: "Only pricing operator or super admin can manage pricing",
    PRODUCT_NOT_FOUND: "Product was not found",
    VERSION_CONFLICT: "Product price changed; reload before trying again",
    PRICE_REQUIRED: "Base price and sale price are required",
    PRICE_NON_NEGATIVE: "Prices must be non-negative",
    SALE_PRICE_ABOVE_BASE_PRICE: "Sale price cannot be higher than base price",
    REASON_MIN_10_CHARS: "Reason must be at least 10 characters"
  };
  return messages[code] || "Pricing database operation failed";
}
