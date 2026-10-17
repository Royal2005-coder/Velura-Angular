import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagementInsights, type ManagementInsight } from '../../apps/api/src/insights/management-insights.js';
import { emptyManagementFacts } from './analytics-fixtures.js';

const business = { revenue: 1_000_000, orderCount: 10, averageOrderValue: 100_000, comparisons: { revenuePct: null } };
const card = (result: { groups: readonly ManagementInsight[] }, id: string) => {
  const group = result.groups.find(item => item.id === id);
  assert.ok(group, `Missing required report ${id}`);
  return group;
};

test('unvalidated OLTP values cannot become financial or analytical conclusions', () => {
  const result = buildManagementInsights({ business }, false, undefined, emptyManagementFacts());
  for (const group of result.groups) {
    assert.equal(group.availability, 'insufficient_data');
    assert.equal(group.source, 'unavailable');
    assert.equal(group.phenomenon, undefined);
  }
  assert.equal('evidence' in result, false);
  assert.equal('lastSyncedAt' in result, false);
});

test('the nine report domains keep unavailable costs, SLA, LTV and joined CSAT explicit', () => {
  const facts = emptyManagementFacts();
  const result = buildManagementInsights({ business }, true, facts.snapshotAt, facts);
  assert.deepEqual(result.groups.map(group => group.id), ['AD_DB_01','AD_DB_02','AD_DB_03','AD_DB_04','AD_DB_05','AD_DB_06','AD_DB_07','AD_DB_08','AD_DB_09']);
  assert.deepEqual(card(result, 'AD_DB_01').kpis, { revenue: 1_000_000, orders: 10, aov: 100_000, revenueGrowthPct: null });
  assert.equal(card(result, 'AD_DB_06').kpis?.roi, null);
  for (const id of ['AD_DB_02','AD_DB_03','AD_DB_04','AD_DB_05','AD_DB_07','AD_DB_08','AD_DB_09']) assert.equal(card(result, id).availability, 'insufficient_data');
  assert.equal(card(result, 'AD_DB_05').kpis?.csatAverage, null);
  assert.equal(result.lastSyncedAt, facts.snapshotAt);
});

test('CSAT needs twenty real samples and retains a null average when none exist', () => {
  for (const sample of [0, 19, 20]) {
    const facts = emptyManagementFacts();
    facts.csat = { tickets: 25, sample_count: sample, average_score: sample ? 2.5 : null, closed_without_score: 25 - sample };
    const group = card(buildManagementInsights({}, true, facts.snapshotAt, facts), 'AD_DB_05');
    assert.equal(group.availability, sample === 20 ? 'ready' : 'insufficient_data');
    assert.equal(group.kpis?.sampleCount, sample);
    assert.equal(group.kpis?.csatAverage, sample ? 2.5 : null);
    if (sample === 20) {
      assert.equal(group.severity, 'high');
      assert.ok(group.phenomenon && group.scope && group.magnitude && group.consequence);
      assert.equal(group.kpis?.twoWeekTrend, undefined);
    }
  }
});

test('cohort returns, review coverage, attention and retention use their own denominators', () => {
  const facts = emptyManagementFacts();
  facts.sla = { ...facts.sla, active_orders: 4, known_state_orders: 2, attention_orders_24h: 1, attention_rate_pct: 50, average_hours_in_state: 18 };
  facts.skuReturns = [{ product_name: 'Áo linen', sku: 'AO-1', delivered_units: 8, requested_units: 2, received_units: 1, net_item_value: 100, rating_count: 2, low_rating_count: 1, average_rating: 3, requested_rate_pct: 25, received_rate_pct: 12.5 }];
  facts.categoryReturns = [{ category_name: 'Áo', delivered_units: 8, requested_units: 2, received_units: 1, requested_rate_pct: 25, received_rate_pct: 12.5 }];
  facts.reviewCoverage = { delivered_orders: 4, reviewed_orders: 1 };
  facts.retention = { ...facts.retention, known_customers: 4, repeat_customers: 1, repeat_purchase_rate_pct: 25, observed_lifetime_order_value_avg: 500 };
  facts.discountSatisfaction = [{ bracket: 'over_30_percent', orders: 4, reviewed_orders: 1, review_count: 2, low_rating_count: 1, average_rating: 3 }];
  const result = buildManagementInsights({}, true, facts.snapshotAt, facts);
  assert.equal(card(result, 'AD_DB_02').kpis?.attentionRatePct, 50);
  assert.equal(card(result, 'AD_DB_02').kpis?.contractualSla, null);
  assert.equal(card(result, 'AD_DB_03').kpis?.requestedRatePct, 25);
  assert.equal(card(result, 'AD_DB_04').kpis?.unreviewedRatePct, 75);
  assert.deepEqual(card(result, 'AD_DB_07').kpis, { deliveredUnits: 8, requestedUnits: 2, receivedUnits: 1, requestedRatePct: 25, receivedRatePct: 12.5 });
  assert.equal(card(result, 'AD_DB_08').kpis?.linkedCsat, null);
  assert.equal(card(result, 'AD_DB_09').kpis?.repeatRatePct, 25);
  assert.equal(card(result, 'AD_DB_09').kpis?.observedLifetimeValue, 500);
  assert.equal(card(result, 'AD_DB_09').kpis?.predictedLtv, null);
});

test('a malformed direct report source cannot throw or turn missing counts into zeros', () => {
  const facts = emptyManagementFacts();
  const result = buildManagementInsights({}, true, facts.snapshotAt, { ...facts, csat: {} });
  assert.ok(result.groups.every(group => group.availability === 'insufficient_data'));
  assert.equal('evidence' in result, false);
});
