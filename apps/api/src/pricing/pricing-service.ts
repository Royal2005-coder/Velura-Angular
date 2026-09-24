import { enrichAuditLogs, PRICING_AUDIT } from "../audit-enrichment.js";
import { HttpError } from "../http.js";
import { asJsonObject, asString, type AuthContext, type JsonObject } from "../types.js";
import { PROMOTION_OPERATOR_ROLES, PROMOTION_READER_ROLES, PROMOTION_TYPES, VOUCHER_TYPES } from "./pricing-constants.js";
import type { PricingRepository } from "./pricing-repository.js";
import {
  canActivatePromotion,
  canPausePromotion,
  promotionLifecycle,
  promotionLifecycleLabel,
  promotionWarnings,
  overlapWarning,
  toLifecycleInput,
  toOverlapCandidate
} from "./promotion-lifecycle.js";
import { normalizePromotionPresentation } from "./promotion-presentation.js";

/** Dạng UUID chung, đủ để chặn chuỗi lạ lọt vào bộ lọc PostgREST. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  getStatistics(context: AuthContext | undefined, searchParams?: URLSearchParams): Promise<unknown>;
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
      const type = searchParams.get("type") || undefined;
      if (type && !PROMOTION_TYPES.includes(type)) {
        throw new HttpError(422, "VALIDATION_ERROR", `Invalid promo type. Valid: ${PROMOTION_TYPES.join(", ")}`);
      }
      const payload = await repository.listPromotions({
        isActive: searchParams.get("isActive") || undefined,
        type,
        limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
        offset: parseInt(searchParams.get("offset") || "0")
      }, context.accessToken);
      const promoIds = (payload?.rows || [])
        .map((row) => asString(row.promo_id))
        .filter((id): id is string => Boolean(id));
      const now = new Date();
      const [voucherStats, summarySource, activeVouchers] = await Promise.all([
        repository.countVouchersByPromotion(promoIds, context.accessToken),
        repository.summarizePromotions(context.accessToken),
        repository.countActiveVouchers(context.accessToken)
      ]);
      const allCampaigns = Array.isArray(summarySource?.rows) ? summarySource.rows : [];
      return {
        ...decoratePromotions(payload, now, voucherStats, allCampaigns),
        summary: summarizePromotionRows(summarySource, activeVouchers?.count, now)
      };
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
      const promoId = searchParams.get("promoId") || "";
      if (promoId && promoId !== "none" && !UUID_PATTERN.test(promoId)) {
        throw new HttpError(422, "VALIDATION_ERROR", "promoId không hợp lệ");
      }
      return repository.listVouchers({
        isActive: isActive !== null ? isActive === "true" : undefined,
        promoId: promoId || undefined,
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
      const audience = String(body.applicableUserGroup || "all_users");
      if (!["guest", "member", "all_users", "new_user", "loyal_user", "churn_risk_user"].includes(audience)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Đối tượng mã phải là khách vãng lai, thành viên hoặc mọi khách");
      }

      // Trần `max_vouchers_allowed` của chiến dịch do RPC chốt khi đang khoá dòng chiến
      // dịch (migration 035). Đếm ở đây rồi mới ghi thì hai admin bấm cùng lúc vẫn lọt
      // qua cả hai, nên không đếm lại ở tầng này.
      return repository.createVoucher({ ...body, code: String(body.code).trim().toUpperCase() }, context.accessToken);
    },

    async updateVoucher(context, voucherId, body) {
      requirePricingAdmin(context);
      const expectedVersion = parseInt((body?.expectedVersion || "0") as string);
      if (!expectedVersion) throw new HttpError(422, "VALIDATION_ERROR", "expectedVersion required");
      if (body?.type !== undefined && body.type !== null && !VOUCHER_TYPES.includes(body.type as string)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Invalid voucher type");
      }
      return repository.updateVoucher(voucherId, { ...body, expectedVersion }, context.accessToken);
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

    async getStatistics(context, searchParams = new URLSearchParams()) {
      requirePricingReader(context);
      const from = optionalIsoDate(searchParams.get("from"), "from");
      const to = optionalIsoDate(searchParams.get("to"), "to");
      if (from && to && Date.parse(from) >= Date.parse(to)) {
        throw new HttpError(422, "VALIDATION_ERROR", "Ngày kết thúc phải sau ngày bắt đầu");
      }
      const [raw, summarySource, activeVouchers] = await Promise.all([
        repository.getStatistics({ from, to }, context.accessToken),
        repository.summarizePromotions(context.accessToken),
        repository.countActiveVouchers(context.accessToken)
      ]);
      return buildPromotionStatistics(asJsonObject(raw), summarizePromotionRows(summarySource, activeVouchers?.count, new Date()), new Date(), { from, to });
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
/**
 * Chỉ số tổng hợp của toàn bộ chiến dịch, không phụ thuộc vào trang đang xem.
 */
export interface PromotionSummary {
  /** Tổng số chiến dịch — đọc từ `count` của PostgREST nên luôn đúng. */
  total: number;
  /**
   * Phần bóc tách theo trạng thái chỉ xét được trong số chiến dịch đã kéo về. Cờ này
   * bật khi tổng vượt trần, để giao diện không trình bày một con số thiếu như thể là
   * đủ.
   */
  truncated: boolean;
  running: number;
  scheduled: number;
  paused: number;
  ended: number;
  budgetExhausted: number;
  totalBudget: number;
  issuedDiscount: number;
  /** Số chiến dịch có đặt trần ngân sách — phần còn lại không theo dõi được bằng tiền. */
  budgetedCampaigns: number;
  activeVouchers: number;
}

/**
 * Tính các chỉ số đầu trang Khuyến mãi trên toàn bộ chiến dịch.
 *
 * `totalBudget` chỉ cộng những chiến dịch có đặt trần. Cộng cả chiến dịch không giới
 * hạn vào (chúng lưu `budget_limit = 0`) sẽ cho ra một tổng nhỏ hơn thực tế và làm
 * người vận hành tưởng ngân sách còn dư trong khi không có trần nào cả.
 */
export function summarizePromotionRows(
  payload: { rows?: JsonObject[]; count?: number | undefined } | unknown,
  activeVoucherCount: number | undefined,
  now: Date
): PromotionSummary {
  const rows = Array.isArray((payload as { rows?: JsonObject[] })?.rows)
    ? (payload as { rows: JsonObject[] }).rows
    : [];

  // Tổng lấy từ `count` chứ không từ `rows.length`: truy vấn có trần nên `rows` có thể
  // ngắn hơn thực tế, và đếm trên nó sẽ cho ra một con số nhỏ hơn mà không báo gì.
  const exactTotal = (payload as { count?: number | undefined })?.count;
  const total = typeof exactTotal === "number" ? exactTotal : rows.length;

  const summary: PromotionSummary = {
    total,
    truncated: total > rows.length,
    running: 0,
    scheduled: 0,
    paused: 0,
    ended: 0,
    budgetExhausted: 0,
    totalBudget: 0,
    issuedDiscount: 0,
    budgetedCampaigns: 0,
    activeVouchers: activeVoucherCount ?? 0
  };

  for (const row of rows) {
    const input = toLifecycleInput(row);
    switch (promotionLifecycle(input, now)) {
      case "running": summary.running += 1; break;
      case "scheduled": summary.scheduled += 1; break;
      case "paused": summary.paused += 1; break;
      case "ended": summary.ended += 1; break;
      case "budget_exhausted": summary.budgetExhausted += 1; break;
    }
    if (input.budgetLimit > 0) {
      summary.totalBudget += input.budgetLimit;
      summary.budgetedCampaigns += 1;
    }
    summary.issuedDiscount += input.totalDiscountIssued;
  }

  return summary;
}

export function decoratePromotions(
  payload: { rows?: JsonObject[]; count?: number | undefined } | JsonObject[] | unknown,
  now: Date,
  voucherStats: Record<string, { total: number; active: number }> = {},
  /**
   * Toàn bộ chiến dịch, dùng để phát hiện chồng lấn. Bỏ trống thì chỉ xét trong phạm
   * vi trang hiện tại — vẫn đúng, chỉ là sót những chiến dịch ở trang khác.
   */
  allCampaigns: readonly JsonObject[] = []
): { rows: JsonObject[]; count: number | undefined } {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { rows?: JsonObject[] })?.rows)
      ? (payload as { rows: JsonObject[] }).rows
      : [];
  const count = Array.isArray(payload)
    ? payload.length
    : (payload as { count?: number | undefined })?.count;

  // Chỉ xét chồng lấn giữa những chiến dịch còn sống: một chiến dịch đã kết thúc trùng
  // danh mục với chiến dịch đang chạy không phải là vấn đề của ai cả.
  const liveCandidates = (allCampaigns.length ? allCampaigns : rows)
    .filter((row) => {
      const lifecycle = promotionLifecycle(toLifecycleInput(row), now);
      return lifecycle === "running" || lifecycle === "scheduled";
    })
    .map(toOverlapCandidate);

  return {
    rows: rows.map((row) => {
      const stats = voucherStats[asString(row.promo_id) || ""] || { total: 0, active: 0 };
      const input = { ...toLifecycleInput(row), voucherCount: stats.total, activeVoucherCount: stats.active };
      const lifecycle = promotionLifecycle(input, now);
      const warnings = promotionWarnings(input, now);
      if (lifecycle === "running" || lifecycle === "scheduled") {
        const overlap = overlapWarning(toOverlapCandidate(row), liveCandidates);
        if (overlap) warnings.push(overlap);
      }
      return {
        ...row,
        voucher_count: stats.total,
        active_voucher_count: stats.active,
        // Ngân sách chỉ nhúc nhích khi có mã được dùng; không mã thì không theo dõi được.
        budget_tracked: stats.total > 0,
        lifecycle_status: lifecycle,
        lifecycle_label: promotionLifecycleLabel(lifecycle),
        can_activate: canActivatePromotion(lifecycle),
        can_pause: canPausePromotion(lifecycle),
        // `budget_limit = 0` trong cơ sở dữ liệu nghĩa là không đặt trần, không phải
        // ngân sách bằng không — nói rõ ra để UI không vẽ "0đ / 0đ".
        budget_unlimited: input.budgetLimit <= 0,
        warnings
      };
    }),
    count
  };
}

/** Ngày ISO từ query, hoặc undefined khi không gửi. */
function optionalIsoDate(value: string | null, field: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new HttpError(422, "VALIDATION_ERROR", `${field} không phải ngày hợp lệ`);
  return new Date(time).toISOString();
}

const toNumber = (value: unknown): number => Number(value) || 0;
const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : 0);

/**
 * Ghép số liệu đơn hàng từ RPC với vòng đời chiến dịch tính ở API.
 *
 * Trạng thái chiến dịch lấy từ `promotionLifecycle`, cùng nguồn với badge trên bảng
 * chiến dịch, chứ không suy từ `is_active`: chiến dịch hết hạn vẫn còn cờ bật.
 */
export function buildPromotionStatistics(
  raw: JsonObject,
  summary: PromotionSummary,
  now: Date,
  range: { from?: string; to?: string } = {}
) {
  const overall = asJsonObject(raw.overall);
  const vouchers = asJsonObject(raw.vouchers);
  const orders = toNumber(overall.orders);
  const voucherOrders = toNumber(overall.voucher_orders);
  const revenueWith = toNumber(overall.revenue_with_voucher);
  const revenueWithout = toNumber(overall.revenue_without_voucher);
  const totalUsed = toNumber(vouchers.total_used);
  const totalLimit = toNumber(vouchers.total_limit);
  const campaigns = (Array.isArray(raw.campaigns) ? raw.campaigns : []).map((item) => {
    const row = asJsonObject(item);
    const revenue = toNumber(row.revenue);
    const discount = toNumber(row.discount);
    const standalone = !row.promo_id;
    const lifecycle = standalone ? null : promotionLifecycle(toLifecycleInput(row), now);
    return {
      promoId: asString(row.promo_id) || null,
      name: standalone ? "Mã đứng riêng" : asString(row.promo_name) || "—",
      lifecycle,
      lifecycleLabel: lifecycle ? promotionLifecycleLabel(lifecycle) : null,
      vouchers: toNumber(row.vouchers),
      orders: toNumber(row.orders),
      revenue,
      discount,
      // Mỗi đồng giảm mang về bao nhiêu đồng doanh thu. Chưa có đơn thì không có tỉ số.
      revenuePerDiscount: discount > 0 ? Math.round((revenue / discount) * 10) / 10 : null,
      budgetLimit: toNumber(row.budget_limit),
      budgetUsed: toNumber(row.total_discount_issued)
    };
  });

  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    orders: {
      total: orders,
      withVoucher: voucherOrders,
      voucherRate: percent(voucherOrders, orders),
      revenueWithVoucher: revenueWith,
      revenueWithoutVoucher: revenueWithout,
      revenueShareWithVoucher: percent(revenueWith, revenueWith + revenueWithout),
      discountTotal: toNumber(overall.discount_total),
      aovWithVoucher: toNumber(overall.aov_with_voucher),
      aovWithoutVoucher: toNumber(overall.aov_without_voucher)
    },
    promotions: {
      ...summary,
      budgetRemaining: Math.max(0, summary.totalBudget - summary.issuedDiscount),
      budgetUsagePercent: summary.totalBudget > 0 ? Math.min(100, Math.round((summary.issuedDiscount * 100) / summary.totalBudget)) : 0
    },
    vouchers: {
      total: toNumber(vouchers.total),
      active: toNumber(vouchers.active),
      scheduled: toNumber(vouchers.scheduled),
      expired: toNumber(vouchers.expired),
      disabled: toNumber(vouchers.disabled),
      unlimited: toNumber(vouchers.unlimited),
      totalUsed,
      totalLimit,
      usagePercent: totalLimit > 0 ? Math.min(100, Math.round((totalUsed * 100) / totalLimit)) : 0
    },
    campaigns,
    topVouchers: (Array.isArray(raw.top_vouchers) ? raw.top_vouchers : []).map((item) => {
      const row = asJsonObject(item);
      return {
        voucherId: asString(row.voucher_id),
        code: asString(row.code) || "—",
        orders: toNumber(row.orders),
        discount: toNumber(row.discount),
        revenue: toNumber(row.revenue)
      };
    })
  };
}
