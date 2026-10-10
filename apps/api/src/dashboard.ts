import { HttpError } from './http.js';
import { isJsonObject, type JsonObject } from './types.js';
import type { VoiceInsights } from './insights.js';
import { buildManagementInsights } from './insights/management-insights.js';
import { analyticsRepository, type AnalyticsRepository } from './insights/analytics-repository.js';
import { validateManagementFacts } from './insights/management-source-service.js';

const OFFSET = 7 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DASHBOARD_MIN_REVIEW_SAMPLE = 30;
export const DASHBOARD_MIN_CSAT_SAMPLE = 20;

/** Validate a dimension filter before querying private analytics. */
export function optionalUuid(params: URLSearchParams | null, key: string): string | null {
  const value = params?.get(key)?.trim() || '';
  if (!value) return null;
  if (!UUID.test(value)) throw new HttpError(400, 'INVALID_DASHBOARD_FILTER', `${key} phải là UUID`);
  return value;
}
/** Rolling complete Vietnam business-day windows, with an adjacent equally sized previous period. */
export function resolveDashboardPeriod(params: URLSearchParams | null, now = new Date()) {
  if (params?.get('from') || params?.get('to')) throw new HttpError(400, 'CUSTOM_DASHBOARD_RANGE_DISABLED', 'Khoảng thời gian chỉ hỗ trợ ngày, tuần hoặc tháng');
  const range = params?.get('range') || 'week';
  if (!['day', 'week', 'month'].includes(range)) throw new HttpError(400, 'INVALID_DASHBOARD_RANGE', 'Khoảng xem chỉ hỗ trợ ngày, tuần hoặc tháng');
  const local = new Date(now.getTime() + OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET;
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
  const from = new Date(midnight - (days - 1) * DAY), to = new Date(midnight + DAY);
  return { range, days, from, to, previousFrom: new Date(from.getTime() - days * DAY), previousTo: from };
}
/** Missing/invalid values are unavailable, never fabricated zero observations. */
export function dashboardNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
const object = (value: unknown): JsonObject => isJsonObject(value) ? value : {};
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];

/** Normalize only observed scalar values; null denominators remain null. */
export function normalizeDashboardSummary(summary: JsonObject): JsonObject {
  const b = object(summary.business), o = object(summary.operations), comparisons = { ...object(b.comparisons) };
  if (comparisons.orderCountPct === null) comparisons.completionRatePoints = null;
  const business: JsonObject = { ...b, comparisons };
  for (const key of ['revenue','orderCount','averageOrderValue','completionRate','promotionRevenue','promotionRevenueShare','pendingReviews']) business[key] = dashboardNumber(b[key]);
  business.customers = business.customerCount = dashboardNumber(b.customers ?? b.customerCount);
  const operations: JsonObject = {};
  for (const key of ['pendingOrders','paymentErrors','openReturns','openSupportTickets','lowStockProducts','urgentReviews','returnsDueSoon']) operations[key] = dashboardNumber(o[key]);
  business.bestSellers = rows(b.bestSellers).map(row => ({
    product_id: typeof row.product_id === 'string' ? row.product_id : undefined,
    sku: typeof row.sku === 'string' ? row.sku : undefined, name: String(row.name || 'Sản phẩm'),
    sold: dashboardNumber(row.sold ?? row.qty), revenue: dashboardNumber(row.revenue),
    lowStock: row.lowStock === true || ['Sắp hết','Hết hàng'].includes(String(row.stockStatus)) || ['warning','danger'].includes(String(row.statusClass)),
  }));
  business.categoryContributions = rows(b.categoryContributions).map(row => ({ ...row, revenue: dashboardNumber(row.revenue), pct: dashboardNumber(row.pct) }));
  business.revenueTrend = rows(b.revenueTrend).map(row => ({ ...row, revenue: dashboardNumber(row.revenue), orderCount: dashboardNumber(row.orderCount) }));
  return { ...summary, operations, business };
}
/** Sample size describes observed rows; completeness additionally requires an uncapped source. */
export function dashboardProvenance(olap: boolean, voice: VoiceInsights | JsonObject | null | undefined) {
  const payload = object(voice), meta = object(payload.meta);
  const reviews = dashboardNumber(object(payload.productReaction).reviewCount), csat = dashboardNumber(object(payload.serviceQuality).csatCount);
  const truncated = payload.truncated === true || payload.rowsCapped === true || meta.truncated === true || meta.rowsCapped === true;
  return { source: olap ? 'analytics.star' : 'oltp.rpc',
    samples: { reviews, csat, deliveredOrders: dashboardNumber(object(payload.coverage).deliveredOrders) },
    reliable: { reviews: reviews !== null && reviews >= DASHBOARD_MIN_REVIEW_SAMPLE, csat: csat !== null && csat >= DASHBOARD_MIN_CSAT_SAMPLE, complete: !!voice && !truncated },
  };
}
/** Read validated persisted snapshots without refreshing as a side effect of GET. */
export async function buildDashboardSummary(params: URLSearchParams | null, now = new Date(), repository: AnalyticsRepository = analyticsRepository) {
  const period = resolveDashboardPeriod(params, now), categoryId = optionalUuid(params, 'categoryId'), productId = optionalUuid(params, 'productId');
  const raw = await repository.read({ from: period.from.toISOString(), to: period.to.toISOString(), categoryId, productId });
  if (!isJsonObject(raw) || raw.schemaVersion !== 3 || raw.dataset !== 'operational' || raw.source !== 'analytics.star.v3' || !isJsonObject(raw.summary) || !['fresh','stale','unavailable'].includes(String(raw.freshness))) {
    throw new HttpError(502, 'INVALID_DASHBOARD_SOURCE', 'Nguồn phân tích chưa có hợp đồng dữ liệu hợp lệ.');
  }
  const snapshotAt = typeof raw.snapshotAt === 'string' && Number.isFinite(Date.parse(raw.snapshotAt)) && Date.parse(raw.snapshotAt) <= now.getTime() + 60_000 ? raw.snapshotAt : undefined;
  const lastSyncedAt = raw.reconciled === true ? snapshotAt : undefined;
  const validated = lastSyncedAt && raw.freshness !== 'unavailable' && isJsonObject(raw.facts) && raw.facts.snapshotAt === lastSyncedAt ? validateManagementFacts(raw.facts) : null;
  const facts = validated?.availability === 'ready' ? validated.facts : null;
  const mapped = normalizeDashboardSummary(raw.summary);
  if (!facts) {
    const b = object(mapped.business);
    for (const key of ['revenue','orderCount','customers','customerCount','averageOrderValue','completionRate','promotionRevenue','promotionRevenueShare']) b[key] = null;
    b.comparisons = {}; b.bestSellers = []; b.categoryContributions = []; b.revenueTrend = []; b.insights = {};
  }
  const management = buildManagementInsights(mapped, !!facts, lastSyncedAt, facts);
  return { ...mapped, range: period.range, from: period.from.toISOString(), to: new Date(period.to.getTime()-1).toISOString(),
    toExclusive: period.to.toISOString(), previousFrom: period.previousFrom.toISOString(), previousToExclusive: period.previousTo.toISOString(),
    periodDays: period.days, filters: { categoryId, productId }, voice: null, management,
    meta: { ...object(raw.summary.meta), ...dashboardProvenance(!!facts, null), generatedAt: lastSyncedAt ?? null,
      updated_at: lastSyncedAt ?? null, source: facts ? 'analytics.star' : 'unavailable', freshness: facts ? raw.freshness : 'unavailable',
      validated: !!facts, reconciled: raw.reconciled === true, pendingEvents: dashboardNumber(raw.pendingEvents),
      operationsSource: 'oltp.live-queues', lastSync: raw.lastSync, schemaVersion: 3,
      sourceWarning: facts ? null : validated?.reason ?? 'Đồng bộ và đối chiếu nguồn trước khi sử dụng KPI kinh doanh.',
      openDefinitions: ['contractual_sla','promotion_roi_costs','predicted_ltv','discount_to_csat_join'],
    },
  };
}
/** Surface persisted throttling/failure as non-success; the last verified snapshot is unchanged. */
export async function refreshDashboard(actorId: string, repository: AnalyticsRepository = analyticsRepository): Promise<JsonObject> {
  const result = await repository.refresh(actorId);
  if (!isJsonObject(result)) throw new HttpError(502, 'INVALID_ANALYTICS_SYNC', 'Không nhận được kết quả đồng bộ hợp lệ.');
  if (result.success !== true || result.status !== 'succeeded' || typeof result.snapshotAt !== 'string' || !Number.isFinite(Date.parse(result.snapshotAt))) {
    const throttled = result.status === 'busy' || result.status === 'throttled';
    throw new HttpError(throttled ? 429 : 502, throttled ? 'ANALYTICS_REFRESH_THROTTLED' : 'ANALYTICS_SYNC_FAILED', throttled ? 'Chờ 10 giây trước khi đồng bộ lại.' : 'Đồng bộ thất bại; giữ bản đã xác minh gần nhất.', result);
  }
  return result;
}
