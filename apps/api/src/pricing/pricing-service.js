import { HttpError } from "../http.js";
import { PROMOTION_OPERATOR_ROLES, PROMOTION_READER_ROLES, PROMOTION_TYPES, VOUCHER_TYPES } from "./pricing-constants.js";

export function createPricingService({ repository }) {
  function requirePricingAdmin(context) {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!PROMOTION_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only pricing operator or super admin can manage pricing");
    }
  }

  function requirePricingReader(context) {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!PROMOTION_READER_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view pricing");
    }
  }

  return {
    async listPriceHistory(context, searchParams) {
      requirePricingReader(context);
      return repository.listPriceHistory({
        productId: searchParams.get("productId") || undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async changePrice(context, productId, body) {
      requirePricingAdmin(context);
      const input = validatePriceChange(body);
      return repository.changePrice(productId, input, context.accessToken);
    },

    async listPromotions(context, searchParams) {
      requirePricingReader(context);
      return repository.listPromotions({
        isActive: searchParams.get("isActive") || undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async getPromotion(context, promotionId) {
      requirePricingReader(context);
      const promo = await repository.getPromotion(promotionId, context.accessToken);
      if (!promo) throw new HttpError(404, "PROMOTION_NOT_FOUND", "Promotion not found");
      return promo;
    },

    async createPromotion(context, body) {
      requirePricingAdmin(context);
      if (!body?.name) throw new HttpError(422, "VALIDATION_ERROR", "Name required");
      if (!body?.startDate || !body?.endDate) throw new HttpError(422, "VALIDATION_ERROR", "Start and end dates required");
      if (body.type && !PROMOTION_TYPES.includes(body.type)) throw new HttpError(422, "VALIDATION_ERROR", `Invalid promo type. Valid: ${PROMOTION_TYPES.join(", ")}`);
      return repository.createPromotion({ ...body, createdBy: context.profile?.user_id || context.authUser?.id }, context.accessToken);
    },

    async updatePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.updatePromotion(promotionId, body, context.accessToken);
    },

    async activatePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.activatePromotion(promotionId, { expectedVersion }, context.accessToken);
    },

    async pausePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.pausePromotion(promotionId, { expectedVersion }, context.accessToken);
    },

    async listVouchers(context, searchParams) {
      requirePricingReader(context);
      const isActive = searchParams.get("isActive");
      return repository.listVouchers({
        isActive: isActive !== null ? isActive === "true" : undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
    },

    async getVoucher(context, voucherId) {
      requirePricingReader(context);
      const voucher = await repository.getVoucher(voucherId, context.accessToken);
      if (!voucher) throw new HttpError(404, "VOUCHER_NOT_FOUND", "Voucher not found");
      return voucher;
    },

    async createVoucher(context, body) {
      requirePricingAdmin(context);
      if (!body?.code) throw new HttpError(422, "VALIDATION_ERROR", "Code required");
      if (!VOUCHER_TYPES.includes(body?.type)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid voucher type");
      return repository.createVoucher({ ...body, createdBy: context.profile?.user_id || context.authUser?.id }, context.accessToken);
    },

    async updateVoucher(context, voucherId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt(body?.expectedVersion || "0");
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.updateVoucher(voucherId, body, context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requirePricingReader(context);
      return repository.listAuditLogs({
        limit: boundedInteger(searchParams.get("limit"), 50, 1, 100),
        offset: boundedInteger(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
      }, context.accessToken);
    },

    async toggleVoucher(context, voucherId) {
      requirePricingAdmin(context);
      const voucher = await repository.getVoucher(voucherId, context.accessToken);
      if (!voucher) throw new HttpError(404, "VOUCHER_NOT_FOUND", "Voucher not found");
      if (!voucher.is_active && voucher.promo_id) {
        const promo = await repository.getPromotion(voucher.promo_id, context.accessToken);
        if (promo && !promo.is_active) {
          throw new HttpError(422, "PROMOTION_PAUSED", "Không thể kích hoạt voucher của chiến dịch đang tạm dừng");
        }
      }
      return repository.updateVoucher(voucherId, {
        expectedVersion: voucher.version,
        isActive: !voucher.is_active,
        name: voucher.name
      }, context.accessToken);
    },

    async getStatistics(context) {
      requirePricingReader(context);
      return repository.getStatistics(context.accessToken);
    }
  };
}

export function validatePriceChange(body = {}) {
  const newBasePrice = parsePrice(body.newBasePrice ?? body.basePrice, "newBasePrice");
  const newSalePrice = parsePrice(body.newSalePrice ?? body.salePrice ?? body.newPrice, "newSalePrice");
  const reason = String(body.reason || "").trim().replace(/\s+/g, " ");
  if (reason.length < 10 || reason.length > 500) {
    throw new HttpError(422, "VALIDATION_ERROR", "Reason must be 10 to 500 characters", {
      reason: ["Reason must be 10 to 500 characters"]
    });
  }
  if (newSalePrice > newBasePrice) {
    throw new HttpError(422, "VALIDATION_ERROR", "Sale price cannot be higher than base price", {
      newSalePrice: ["Sale price cannot be higher than base price"]
    });
  }
  return {
    newBasePrice,
    newSalePrice,
    reason,
    expectedVersion: parseVersion(body.expectedVersion)
  };
}

function parsePrice(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new HttpError(422, "VALIDATION_ERROR", `${field} required`, {
      [field]: [`${field} required`]
    });
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) {
    throw new HttpError(422, "VALIDATION_ERROR", `${field} must be a non-negative number`, {
      [field]: [`${field} must be a non-negative number`]
    });
  }
  return price;
}

function parseVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required", {
      expectedVersion: ["expectedVersion required"]
    });
  }
  return version;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
