import { HttpError } from '../http.js';
import { isJsonObject, type JsonObject } from '../types.js';
import { managementFactRepository, type ManagementFactQuery, type ManagementFactRepository } from './management-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS = ['sla', 'promotion', 'retention', 'csat', 'reviewCoverage', 'refunds'] as const;
const COLLECTIONS = ['skuReturns', 'categoryReturns', 'returnReasons', 'discountSatisfaction'] as const;

/**
 * Validated evidence joins. A missing watermark is unavailable, not a new zero-value snapshot.
 * Observed order value is not predicted LTV; 24h attention is not a contractual SLA;
 * discounted-order ratings do not establish causation or an order-linked support CSAT score.
 */
export interface ManagementSourceResult {
  availability: 'ready' | 'insufficient_data';
  facts: JsonObject | null;
  reason?: string;
}

/**
 * Validate cohort bounds and the persisted source envelope before exposing analytical evidence.
 * Auth/RBAC belongs to the calling dashboard router; infrastructure errors propagate to its fallback.
 */
export async function loadManagementFacts(
  query: ManagementFactQuery,
  repository: ManagementFactRepository = managementFactRepository,
): Promise<ManagementSourceResult> {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to ||
    (query.categoryId && !UUID.test(query.categoryId)) || (query.productId && !UUID.test(query.productId))) {
    throw new HttpError(400, 'INVALID_ANALYTICS_FILTER', 'Khoảng thời gian hoặc bộ lọc phân tích không hợp lệ.');
  }
  const raw = await repository.read(query);
  return validateManagementFacts(raw);
}

/** Validate the source envelope and measured numeric domains before any rule consumes a fact. */
export function validateManagementFacts(raw: unknown): ManagementSourceResult {
  if (!isJsonObject(raw) || raw.source !== 'analytics.star.v2' || raw.dataset !== 'operational' ||
    typeof raw.snapshotAt !== 'string' || !Number.isFinite(Date.parse(raw.snapshotAt))) {
    return { availability: 'insufficient_data', facts: null, reason: 'Kho phân tích chưa có bản đồng bộ đã xác minh.' };
  }
  if (SECTIONS.some(key => !isJsonObject(raw[key])) || COLLECTIONS.some(key =>
    !Array.isArray(raw[key]) || !raw[key].every(isJsonObject))) {
    return { availability: 'insufficient_data', facts: null, reason: 'Bản đồng bộ thiếu nhóm dữ liệu đối chiếu.' };
  }
  // Guard against an accidental cost/causation claim from a future incompatible RPC deployment.
  const promotion = raw.promotion as JsonObject, retention = raw.retention as JsonObject;
  const sla = raw.sla as JsonObject, refunds = raw.refunds as JsonObject;
  if (promotion.costAvailable !== false || promotion.roi !== null || retention.predictedLtvAvailable !== false ||
    sla.contractualSlaAvailable !== false || refunds.profitImpactAvailable !== false || raw.discountCsatJoinAvailable !== false) {
    return { availability: 'insufficient_data', facts: null, reason: 'Định nghĩa nguồn dữ liệu đã thay đổi; cần đối chiếu trước khi kết luận.' };
  }
  const counts: Record<string, readonly string[]> = {
    sla: ['active_orders', 'known_state_orders', 'attention_orders_24h'],
    promotion: ['redemptions'],
    retention: ['known_customers', 'repeat_customers'],
    csat: ['tickets', 'sample_count', 'closed_without_score'],
    reviewCoverage: ['delivered_orders', 'reviewed_orders'],
  };
  const measurements: Record<string, readonly string[]> = {
    sla: ['attention_rate_pct', 'average_hours_in_state'],
    promotion: ['discountAmount', 'associatedOrderValue'],
    retention: ['repeat_purchase_rate_pct', 'observed_lifetime_order_value_avg'],
    csat: ['average_score'],
    refunds: ['completedAmount', 'pendingAmount'],
  };
  const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validCount = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
  const nullable = (row: JsonObject, key: string): boolean => key in row && (row[key] === null || nonnegative(row[key]));
  const ratio = (value: unknown, numerator: number, denominator: number): boolean =>
    denominator === 0 ? value === null : nonnegative(value) && Math.abs(value - numerator / denominator * 100) <= 0.011;
  const rating = (value: unknown, sample: number): boolean =>
    sample === 0 ? value === null : nonnegative(value) && value >= 1 && value <= 5;
  const invalid = (): ManagementSourceResult => ({ availability: 'insufficient_data', facts: null, reason: 'Mẫu số và chỉ số nguồn không đối chiếu được.' });
  for (const [section, keys] of Object.entries(counts)) {
    const value = raw[section] as JsonObject;
    if (keys.some(key => !validCount(value[key]))) return invalid();
  }
  for (const [section, keys] of Object.entries(measurements)) {
    if (keys.some(key => !nullable(raw[section] as JsonObject, key))) return invalid();
  }
  const coverage = raw.reviewCoverage as JsonObject, csat = raw.csat as JsonObject;
  if (Number(coverage.reviewed_orders) > Number(coverage.delivered_orders) ||
    Number(csat.sample_count) + Number(csat.closed_without_score) > Number(csat.tickets) ||
    !rating(csat.average_score, Number(csat.sample_count)) ||
    Number(sla.attention_orders_24h) > Number(sla.known_state_orders) ||
    Number(sla.known_state_orders) > Number(sla.active_orders) ||
    !ratio(sla.attention_rate_pct, Number(sla.attention_orders_24h), Number(sla.known_state_orders)) ||
    (Number(sla.known_state_orders) === 0 ? sla.average_hours_in_state !== null : sla.average_hours_in_state === null) ||
    Number(retention.repeat_customers) > Number(retention.known_customers) ||
    !ratio(retention.repeat_purchase_rate_pct, Number(retention.repeat_customers), Number(retention.known_customers))) return invalid();
  const collectionCounts: Record<typeof COLLECTIONS[number], readonly string[]> = {
    skuReturns: ['delivered_units', 'requested_units', 'received_units', 'rating_count', 'low_rating_count'],
    categoryReturns: ['delivered_units', 'requested_units', 'received_units'],
    returnReasons: ['requested_units'],
    discountSatisfaction: ['orders', 'reviewed_orders', 'review_count', 'low_rating_count'],
  };
  for (const key of COLLECTIONS) {
    for (const row of raw[key] as JsonObject[]) {
      if (collectionCounts[key].some(name => !validCount(row[name]))) return invalid();
      if (key === 'skuReturns' || key === 'categoryReturns') {
        if (Number(row.received_units) > Number(row.requested_units) || Number(row.requested_units) > Number(row.delivered_units) ||
          !ratio(row.requested_rate_pct, Number(row.requested_units), Number(row.delivered_units)) ||
          !ratio(row.received_rate_pct, Number(row.received_units), Number(row.delivered_units))) return invalid();
      }
      if (key === 'skuReturns' && (!nullable(row, 'net_item_value') ||
        Number(row.low_rating_count) > Number(row.rating_count) || !rating(row.average_rating, Number(row.rating_count)))) return invalid();
      if (key === 'discountSatisfaction' && (Number(row.reviewed_orders) > Number(row.orders) ||
        Number(row.reviewed_orders) > Number(row.review_count) ||
        Number(row.low_rating_count) > Number(row.review_count) || !rating(row.average_rating, Number(row.review_count)))) return invalid();
    }
  }
  return { availability: 'ready', facts: raw };
}
