import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagementInsights } from '../../apps/api/src/insights/management-insights.js';
import type { VoiceInsights } from '../../apps/api/src/insights.js';

function voice(): VoiceInsights {
  return {
    range: 'week', periodLabel: '7 ngày gần nhất', truncated: false,
    coverage: { deliveredOrders: 10, reviewedOrders: 2, silentOrders: 8, coveragePct: 20 },
    productReaction: { reviewCount: 2, avgRating: 5, loved: [], complained: [] },
    serviceQuality: { tickets: 1, closedTickets: 1, csatCount: 1, csatAvg: 5, ticketsWithoutCsat: 0, returns: 2, returnRatePct: 20, returnReasons: [] },
    orderFriction: { orderCount: 10, completedOrders: 10, cancelledOrders: 0, failedDelivery: 0, cancelReasons: [] },
  };
}

test('management reports all nine requirements without fabricating ROI or cohort data', () => {
  const result = buildManagementInsights({ business: { revenue: 1000000, orderCount: 10, averageOrderValue: 100000, promotionRevenue: 500000, comparisons: { revenuePct: null } } }, voice(), false);
  assert.equal(result.groups.length, 9);
  assert.equal(result.groups[0].availability, 'oltp_fallback');
  assert.match(result.groups[0].magnitude!, /Chưa có dữ liệu kỳ trước/);
  for (const index of [1, 2, 4, 5, 7, 8]) assert.equal(result.groups[index].availability, 'insufficient_data');
  assert.equal('lastSyncedAt' in result, false);
  for (const group of result.groups.filter((group) => group.availability !== 'insufficient_data')) {
    assert.ok(group.phenomenon && group.scope && group.magnitude && group.consequence);
  }
});

test('partial voice data cannot become a complete management conclusion', () => {
  const result = buildManagementInsights({}, { ...voice(), truncated: true }, true, '2026-10-03T10:00:00Z');
  assert.equal(result.groups[3].availability, 'insufficient_data');
  assert.equal(result.groups[4].availability, 'insufficient_data');
  assert.equal(result.groups[6].availability, 'insufficient_data');
  assert.equal(result.lastSyncedAt, '2026-10-03T10:00:00Z');
});

test('sufficient CSAT is measured without inventing a two-week trend', () => {
  const facts = voice();
  facts.serviceQuality.csatCount = 20;
  facts.serviceQuality.csatAvg = 2.5;
  const result = buildManagementInsights({}, facts, true);
  assert.equal(result.groups[4].availability, 'ready');
  assert.equal(result.groups[4].severity, 'high');
  assert.match(result.groups[4].dataNote!, /chưa kết luận xu hướng/);
});
