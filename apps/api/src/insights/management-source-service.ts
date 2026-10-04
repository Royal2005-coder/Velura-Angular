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
  return { availability: 'ready', facts: raw };
}
