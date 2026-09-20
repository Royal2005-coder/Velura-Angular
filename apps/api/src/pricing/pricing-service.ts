import { enrichAuditLogs, PRICING_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import type { AuthContext, JsonObject } from "../types.js";
import { PROMOTION_OPERATOR_ROLES, PROMOTION_READER_ROLES, PROMOTION_TYPES, VOUCHER_TYPES } from "./pricing-constants.js";
import type { PricingRepository } from "./pricing-repository.js";
import {
  canActivatePromotion,
  canPausePromotion,
  promotionLifecycle,
  promotionLifecycleLabel,
  promotionWarnings,
  toLifecycleInput
} from "./promotion-lifecycle.js";
import { normalizePromotionPresentation } from "./promotion-presentation.js";

/**
 * Admin pricing use-cases used by `handlePricingRoute`.
 */
export interface PricingService {
  listPriceHistory(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  changePrice(context: AuthContext | undefined, productId: string, body: JsonObject): Promise<unknown>;
  listPromotions(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  getPromotion(context: AuthContext | undefined, promotionId: string): Promise<unknown>;
  createPromotion(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  updatePromotion(context: AuthContext | undefined, promotionId: string, body: JsonObject): Promise<unknown>;
  activatePromotion(context: AuthContext | undefined, promotionId: string, body: JsonObject): Promise<unknown>;
  pausePromotion(context: AuthContext | undefined, promotionId: string, body: JsonObject): Promise<unknown>;
  listVouchers(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  getVoucher(context: AuthContext | undefined, voucherId: string): Promise<unknown>;
  createVoucher(context: AuthContext | undefined, body: JsonObject): Promise<unknown>;
  updateVoucher(context: AuthContext | undefined, voucherId: string, body: JsonObject): Promise<unknown>;
  listAuditLogs(context: AuthContext | undefined, searchParams: URLSearchParams): Promise<unknown>;
  toggleVoucher(context: AuthContext | undefined, voucherId: string): Promise<unknown>;
  getStatistics(context: AuthContext | undefined): Promise<unknown>;
}

/**
 * Create the admin pricing application service.
 */
export function createPricingService({ repository }: { repository: PricingRepository }): PricingService {
  function requirePricingAdmin(context: AuthContext | undefined): asserts context is AuthContext {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!PROMOTION_OPERATOR_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Only pricing operator or super admin can manage pricing");
    }
  }

  function requirePricingReader(context: AuthContext | undefined): asserts context is AuthContext {
    if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    if (!PROMOTION_READER_ROLES.includes(context.roleCode)) {
      throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view pricing");
    }
  }

  return {
    async listPriceHistory(context, searchParams) {
      if (!context?.authUser?.id) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
      const historyReaders = [...PROMOTION_READER_ROLES, "admin_operator_sanpham", "admin_viewer"];
      if (!historyReaders.includes(context.roleCode)) {
        throw new HttpError(403, "RBAC_DENIED", "Insufficient permissions to view price history");
      }
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
      const payload = await repository.listPromotions({
        isActive: searchParams.get("isActive") || undefined,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
      return decoratePromotions(payload, new Date());
    },

    async getPromotion(context, promotionId) {
      requirePricingReader(context);
      const promo = await repository.getPromotion(promotionId, context.accessToken);
      if (!promo) throw new HttpError(404, "PROMOTION_NOT_FOUND", "Promotion not found");
      return promo;
    },

    async createPromotion(context, body) {
      requirePricingAdmin(context);
      if (body.type && !PROMOTION_TYPES.includes(body.type as string)) throw new HttpError(422, "VALIDATION_ERROR", `Invalid promo type. Valid: ${PROMOTION_TYPES.join(", ")}`);
      validatePromotionSchedule(body);
      return repository.createPromotion({
        ...body,
        ...normalizePromotionPresentation(body, "create"),
        createdBy: context.profile?.user_id || context.authUser?.id
      }, context.accessToken);
    },

    async updatePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt((body?.expectedVersion || "0") as string);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.updatePromotion(promotionId, {
        ...body,
        ...normalizePromotionPresentation(body, "update")
      }, context.accessToken);
    },

    async activatePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt((body?.expectedVersion || "0") as string);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.activatePromotion(promotionId, { expectedVersion }, context.accessToken);
    },

    async pausePromotion(context, promotionId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt((body?.expectedVersion || "0") as string);
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
      if (!VOUCHER_TYPES.includes(body?.type as string)) throw new HttpError(422, "VALIDATION_ERROR", "Invalid voucher type");
      return repository.createVoucher({ ...body, createdBy: context.profile?.user_id || context.authUser?.id }, context.accessToken);
    },

    async updateVoucher(context, voucherId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt((body?.expectedVersion || "0") as string);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      return repository.updateVoucher(voucherId, body, context.accessToken);
    },

    async listAuditLogs(context, searchParams) {
      requirePricingReader(context);
      const payload = await repository.listAuditLogs({
        limit: boundedInteger(searchParams.get("limit"), 50, 1, 100),
        offset: boundedInteger(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
      }, context.accessToken);
      return enrichAuditLogs(payload, PRICING_AUDIT);
    },

    async toggleVoucher(context, voucherId) {
      requirePricingAdmin(context);
      const voucher = await repository.getVoucher(voucherId, context.accessToken);
      if (!voucher) throw new HttpError(404, "VOUCHER_NOT_FOUND", "Voucher not found");
      if (!voucher.is_active && voucher.promo_id) {
        const promo = await repository.getPromotion(voucher.promo_id as string, context.accessToken);
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

/**
 * Validate an admin product price-change body.
 */
export function validatePriceChange(body: JsonObject = {}) {
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

function parsePrice(value: unknown, field: string): number {
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

function parseVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required", {
      expectedVersion: ["expectedVersion required"]
    });
  }
  return version;
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

/**
 * Tên chiến dịch ngắn hơn mức này thì không ai đọc ra nó là chương trình gì.
 * Đặt ở 8 để vẫn nhận tên thật ngắn gọn như "Tet 2026" nhưng loại được "grsgrg".
 */
const PROMOTION_NAME_MIN = 8;

/**
 * Chặn chiến dịch rác ngay tại biên.
 *
 * Bảng khuyến mãi trên production đang lẫn "grsgrg" và vài "Test Campaign <timestamp>"
 * cùng chiến dịch thật, vì tầng API chỉ kiểm tên khác rỗng và hai mốc ngày có mặt —
 * không kiểm thứ tự hai mốc đó, cũng không kiểm độ dài tên. Kiểm ở client thì bỏ qua
 * được bằng một lệnh curl.
 */
export function validatePromotionSchedule(body: JsonObject): void {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < PROMOTION_NAME_MIN) {
    throw new HttpError(422, "VALIDATION_ERROR", `Tên chiến dịch cần tối thiểu ${PROMOTION_NAME_MIN} ký tự`, {
      name: [`Tên chiến dịch cần tối thiểu ${PROMOTION_NAME_MIN} ký tự`]
    });
  }

  if (!body.startDate || !body.endDate) {
    throw new HttpError(422, "VALIDATION_ERROR", "Cần cả ngày bắt đầu và ngày kết thúc", {
      startDate: ["Cần cả ngày bắt đầu và ngày kết thúc"]
    });
  }

  const start = Date.parse(String(body.startDate));
  const end = Date.parse(String(body.endDate));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new HttpError(422, "VALIDATION_ERROR", "Ngày bắt đầu hoặc kết thúc không hợp lệ", {
      startDate: ["Ngày không hợp lệ"]
    });
  }
  if (end <= start) {
    throw new HttpError(422, "VALIDATION_ERROR", "Ngày kết thúc phải sau ngày bắt đầu", {
      endDate: ["Ngày kết thúc phải sau ngày bắt đầu"]
    });
  }

  if (body.budgetLimit !== undefined && body.budgetLimit !== null && body.budgetLimit !== "") {
    const budget = Number(body.budgetLimit);
    if (!Number.isFinite(budget) || budget < 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Ngân sách phải là số không âm", {
        budgetLimit: ["Ngân sách phải là số không âm"]
      });
    }
  }
}

/**
 * Gắn vòng đời và cảnh báo vào từng chiến dịch trước khi trả cho admin.
 *
 * Trạng thái tính ở đây chứ không ở trình duyệt, để badge, nút thao tác và trang ưu đãi
 * bên khách không thể suy ra ba kết quả khác nhau từ cùng một dòng dữ liệu.
 */
export function decoratePromotions(
  payload: { rows?: JsonObject[]; count?: number | undefined } | JsonObject[] | unknown,
  now: Date
): { rows: JsonObject[]; count: number | undefined } {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { rows?: JsonObject[] })?.rows)
      ? (payload as { rows: JsonObject[] }).rows
      : [];
  const count = Array.isArray(payload)
    ? payload.length
    : (payload as { count?: number | undefined })?.count;

  return {
    rows: rows.map((row) => {
      const input = toLifecycleInput(row);
      const lifecycle = promotionLifecycle(input, now);
      return {
        ...row,
        lifecycle_status: lifecycle,
        lifecycle_label: promotionLifecycleLabel(lifecycle),
        can_activate: canActivatePromotion(lifecycle),
        can_pause: canPausePromotion(lifecycle),
        // `budget_limit = 0` trong cơ sở dữ liệu nghĩa là không đặt trần, không phải
        // ngân sách bằng không — nói rõ ra để UI không vẽ "0đ / 0đ".
        budget_unlimited: input.budgetLimit <= 0,
        warnings: promotionWarnings(input, now)
      };
    }),
    count
  };
}
