import { callRpc } from "./supabase.js";
import { HttpError } from "./http.js";
import { asJsonObject, isJsonObject, type JsonObject } from "./types.js";
import { loadVoiceInsights, type VoiceInsights } from "./insights.js";

const BUSINESS_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DASHBOARD_MIN_REVIEW_SAMPLE = 30;
export const DASHBOARD_MIN_CSAT_SAMPLE = 20;

function localDateParts(now = new Date()) {
  const vietnam = new Date(now.getTime() + BUSINESS_TIMEZONE_OFFSET_MS);
  return {
    year: vietnam.getUTCFullYear(),
    month: vietnam.getUTCMonth(),
    day: vietnam.getUTCDate()
  };
}

function vietnamMidnightUtc(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day) - BUSINESS_TIMEZONE_OFFSET_MS);
}

export function optionalUuid(searchParams: URLSearchParams | null, key: string): string | null {
  const value = searchParams?.get(key)?.trim() || "";
  if (!value) return null;
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "INVALID_DASHBOARD_FILTER", `${key} phải là UUID`);
  }
  return value;
}

/**
 * Resolve the dashboard reporting window. Only day / week / month — no custom dates.
 */
export function resolveDashboardPeriod(searchParams: URLSearchParams | null, now = new Date()) {
  if (searchParams?.get("from") || searchParams?.get("to")) {
    throw new HttpError(
      400,
      "CUSTOM_DASHBOARD_RANGE_DISABLED",
      "Khoảng thời gian chỉ hỗ trợ ngày, tuần hoặc tháng"
    );
  }
  const requestedRange = searchParams?.get("range") || "week";
  if (!["day", "week", "month"].includes(requestedRange)) {
    throw new HttpError(400, "INVALID_DASHBOARD_RANGE", "Khoảng xem chỉ hỗ trợ ngày, tuần hoặc tháng");
  }

  const { year, month, day } = localDateParts(now);
  const today = vietnamMidnightUtc(year, month, day);
  const days = requestedRange === "day" ? 1 : requestedRange === "week" ? 7 : 30;
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const to = new Date(today.getTime() + DAY_MS);
  return { range: requestedRange, from, to, days };
}

function asFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapBestSellers(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = isJsonObject(item) ? item : {};
    const stockStatus = String(row.stockStatus || "");
    const statusClass = String(row.statusClass || "");
    return {
      product_id: typeof row.product_id === "string" ? row.product_id : undefined,
      sku: typeof row.sku === "string" ? row.sku : undefined,
      name: String(row.name || "Sản phẩm"),
      sold: asFiniteNumber(row.sold ?? row.qty),
      revenue: asFiniteNumber(row.revenue),
      lowStock:
        row.lowStock === true ||
        stockStatus === "Sắp hết" ||
        stockStatus === "Hết hàng" ||
        statusClass === "warning" ||
        statusClass === "danger"
    };
  });
}

function mapCategories(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = isJsonObject(item) ? item : {};
    return {
      category_id: typeof row.category_id === "string" ? row.category_id : undefined,
      name: String(row.name || "Khác"),
      revenue: asFiniteNumber(row.revenue),
      pct: asFiniteNumber(row.pct)
    };
  });
}

function mapTrend(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = isJsonObject(item) ? item : {};
    return {
      date: String(row.date || ""),
      dateStr: String(row.dateStr || row.date || ""),
      revenue: asFiniteNumber(row.revenue),
      orderCount: asFiniteNumber(row.orderCount)
    };
  });
}

/**
 * Labels the KPI source and refuses to treat tiny VoC samples as planning facts.
 */
export function dashboardProvenance(olapUsed: boolean, voice: VoiceInsights | null | undefined) {
  const reviews = asFiniteNumber(voice?.productReaction?.reviewCount);
  const csat = asFiniteNumber(voice?.serviceQuality?.csatCount);
  const deliveredOrders = asFiniteNumber(voice?.coverage?.deliveredOrders);
  return {
    generatedAt: new Date().toISOString(),
    source: olapUsed ? "analytics.star" : "oltp.rpc",
    definitions: {
      revenue: "Tổng doanh thu đơn trong kỳ",
      orderCount: "Số đơn trong kỳ",
      averageOrderValue: "Doanh thu / số đơn",
      completionRate: "Tỷ lệ đơn hoàn tất trong kỳ"
    },
    samples: { reviews, csat, deliveredOrders },
    reliable: {
      reviews: reviews >= DASHBOARD_MIN_REVIEW_SAMPLE,
      csat: csat >= DASHBOARD_MIN_CSAT_SAMPLE,
      // Kỳ có nhiều dữ liệu hơn trần đọc thì mọi chỉ số tiếng nói khách hàng ở trên
      // chỉ tính trên một phần. Nói ra ở đây để giao diện không trình bày một con số
      // thiếu như thể là đủ.
      complete: !voice?.truncated
    }
  };
}

/**
 * Maps RPC JSON (OLAP or legacy OLTP) onto the Angular dashboard contract.
 */
export function normalizeDashboardSummary(summary: JsonObject): JsonObject {
  const business = isJsonObject(summary.business) ? { ...summary.business } : {};
  const operations = isJsonObject(summary.operations) ? { ...summary.operations } : {};
  const comparisons = isJsonObject(business.comparisons) ? { ...business.comparisons } : {};
  if (comparisons.orderCountPct === null) {
    comparisons.completionRatePoints = null;
  }
  const customers = asFiniteNumber(business.customers ?? business.customerCount);

  return {
    ...summary,
    operations: {
      pendingOrders: asFiniteNumber(operations.pendingOrders),
      paymentErrors: asFiniteNumber(operations.paymentErrors),
      openReturns: asFiniteNumber(operations.openReturns),
      openSupportTickets: asFiniteNumber(operations.openSupportTickets),
      lowStockProducts: asFiniteNumber(operations.lowStockProducts),
      urgentReviews: asFiniteNumber(operations.urgentReviews),
      returnsDueSoon: asFiniteNumber(operations.returnsDueSoon)
    },
    business: {
      ...business,
      revenue: asFiniteNumber(business.revenue),
      orderCount: asFiniteNumber(business.orderCount),
      customers,
      customerCount: customers,
      averageOrderValue: asFiniteNumber(business.averageOrderValue),
      completionRate: asFiniteNumber(business.completionRate),
      promotionRevenue: asFiniteNumber(business.promotionRevenue),
      promotionRevenueShare: asFiniteNumber(business.promotionRevenueShare),
      pendingReviews: asFiniteNumber(business.pendingReviews),
      comparisons,
      categoryContributions: mapCategories(business.categoryContributions),
      bestSellers: mapBestSellers(business.bestSellers),
      revenueTrend: mapTrend(business.revenueTrend)
    }
  };
}

async function loadOlapSummary(
  period: { from: Date; to: Date },
  categoryId: string | null,
  productId: string | null
): Promise<JsonObject | null> {
  try {
    await callRpc(
      "refresh_analytics_star",
      { p_max_age: "5 minutes" },
      { silentError: true }
    );
    const summary = await callRpc(
      "get_admin_olap_summary",
      {
        p_from: period.from.toISOString(),
        p_to: period.to.toISOString(),
        p_category_id: categoryId,
        p_product_id: productId
      },
      { silentError: true }
    );
    if (!summary || typeof summary !== "object") return null;
    return asJsonObject(summary);
  } catch {
    return null;
  }
}

/**
 * Build the admin dashboard summary for a query range, or the default week when params are null.
 */
export async function buildDashboardSummary(searchParams: URLSearchParams | null, now = new Date()) {
  const period = resolveDashboardPeriod(searchParams, now);
  const categoryId = optionalUuid(searchParams, "categoryId");
  const productId = optionalUuid(searchParams, "productId");
  const olap = await loadOlapSummary(period, categoryId, productId);
  const summary =
    olap ||
    (await callRpc("get_admin_dashboard_summary", {
      p_from: period.from.toISOString(),
      p_to: period.to.toISOString()
    }));

  if (!summary || typeof summary !== "object") {
    throw new HttpError(502, "INVALID_DASHBOARD_SUMMARY", "Supabase không trả về dữ liệu dashboard hợp lệ");
  }

  const mapped = normalizeDashboardSummary(asJsonObject(summary));
  const voice = await loadVoiceInsights(period, productId);
  const existingMeta = isJsonObject(mapped.meta) ? mapped.meta : {};
  return {
    ...mapped,
    operations: mapped.operations,
    business: mapped.business,
    range: period.range,
    from: period.from.toISOString(),
    to: new Date(period.to.getTime() - 1).toISOString(),
    periodDays: period.days,
    filters: {
      categoryId,
      productId
    },
    voice,
    meta: {
      ...existingMeta,
      ...dashboardProvenance(Boolean(olap), voice)
    }
  };
}
