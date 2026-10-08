import type { JsonObject } from '../../apps/api/src/types.js';

/** Empty, synchronized operational cohort with measured counts and null missing denominators. */
export function emptyManagementFacts() {
  return {
    source: 'analytics.star.v2', dataset: 'operational', snapshotAt: '2026-10-04T00:00:00Z',
    sla: { contractualSlaAvailable: false, active_orders: 0, known_state_orders: 0, attention_orders_24h: 0, attention_rate_pct: null as number | null, average_hours_in_state: null as number | null },
    promotion: { costAvailable: false, roi: null, redemptions: 0, discountAmount: null as number | null, associatedOrderValue: null as number | null, programs: [], appliedProductPromotions: [] },
    retention: { predictedLtvAvailable: false, known_customers: 0, repeat_customers: 0, repeat_purchase_rate_pct: null as number | null, observed_lifetime_order_value_avg: null as number | null },
    refunds: { profitImpactAvailable: false, completedAmount: null, pendingAmount: null },
    csat: { tickets: 0, sample_count: 0, average_score: null as number | null, closed_without_score: 0 },
    reviewCoverage: { delivered_orders: 0, reviewed_orders: 0 },
    skuReturns: [] as JsonObject[], categoryReturns: [] as JsonObject[], returnReasons: [] as JsonObject[], discountSatisfaction: [] as JsonObject[], discountCsatJoinAvailable: false,
  };
}
