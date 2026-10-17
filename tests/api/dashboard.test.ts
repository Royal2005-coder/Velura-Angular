import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSummary, refreshDashboard, normalizeDashboardSummary, resolveDashboardPeriod, dashboardProvenance } from "../../apps/api/src/dashboard.js";
import type { AnalyticsRepository } from "../../apps/api/src/insights/analytics-repository.js";
import { emptyManagementFacts } from './analytics-fixtures.js';
import { HttpError } from '../../apps/api/src/http.js';
import { handleDashboardRoute } from '../../apps/api/src/dashboard-router.js';
import type { RouteArgs } from '../../apps/api/src/types.js';

test("dashboard week is seven complete Vietnam calendar days", () => {
  const params = new URLSearchParams("range=week");
  const period = resolveDashboardPeriod(params, new Date("2026-07-12T02:30:00.000Z"));
  assert.equal(period.days, 7);
  assert.equal(period.from.toISOString(), "2026-07-05T17:00:00.000Z");
  assert.equal(period.to.toISOString(), "2026-07-12T17:00:00.000Z");
});

test("dashboard day and month stay on Vietnam business midnights", () => {
  const day = resolveDashboardPeriod(new URLSearchParams("range=day"), new Date("2026-07-12T02:30:00.000Z"));
  assert.equal(day.days, 1);
  assert.equal(day.range, "day");
  const month = resolveDashboardPeriod(new URLSearchParams("range=month"), new Date("2026-07-12T02:30:00.000Z"));
  assert.equal(month.days, 30);
  assert.equal(month.range, "month");
});

test("dashboard rejects custom date ranges", () => {
  assert.throws(() => resolveDashboardPeriod(new URLSearchParams("from=2026-06-21&to=2026-06-27")), /ngày, tuần hoặc tháng/);
  assert.throws(() => resolveDashboardPeriod(new URLSearchParams("range=custom")), /ngày, tuần hoặc tháng/);
});

test("dashboard DTO maps OLAP qty/stockStatus onto sold/lowStock and customers", () => {
  const mapped = normalizeDashboardSummary({
    operations: { pendingOrders: "2", paymentErrors: 1 },
    business: {
      revenue: "1500000",
      customerCount: 4,
      bestSellers: [{ name: "Áo", qty: 8, revenue: 900, stockStatus: "Sắp hết" }],
      categoryContributions: [{ category_id: "c1", name: "Áo", revenue: 900, pct: 100 }],
      revenueTrend: [{ date: "2026-07-01", dateStr: "01/07", revenue: 100, orderCount: 2 }],
      comparisons: { orderCountPct: null, completionRatePoints: 4 }
    }
  });
  const business = mapped.business;
  assert.equal(business.customers, 4);
  assert.equal(business.revenue, 1500000);
  assert.deepEqual(business.bestSellers, [
    { product_id: undefined, sku: undefined, name: "Áo", sold: 8, revenue: 900, lowStock: true }
  ]);
  assert.equal(business.revenueTrend[0].date, "2026-07-01");
  assert.equal(business.comparisons.completionRatePoints, null);
});

test("dashboard provenance refuses to treat a single review or CSAT as reliable", () => {
  const tiny = dashboardProvenance(false, {
    range: "week",
    periodLabel: "7 ngày gần nhất",
    coverage: { deliveredOrders: 1, reviewedOrders: 0, silentOrders: 1, coveragePct: 0 },
    productReaction: { reviewCount: 1, avgRating: 5, loved: [], complained: [] },
    serviceQuality: {
      tickets: 1,
      closedTickets: 1,
      csatCount: 0,
      csatAvg: null,
      ticketsWithoutCsat: 1,
      returns: 1,
      returnRatePct: 100
    },
    orderFriction: { orderCount: 1, completedOrders: 1, cancelledOrders: 0, failedDelivery: 0, cancelReasons: [] }
  });
  assert.equal(tiny.source, "oltp.rpc");
  assert.equal(tiny.reliable.reviews, false);
  assert.equal(tiny.reliable.csat, false);
  const enough = dashboardProvenance(true, {
    range: "month",
    periodLabel: "30 ngày gần nhất",
    coverage: { deliveredOrders: 80, reviewedOrders: 40, silentOrders: 40, coveragePct: 50 },
    productReaction: { reviewCount: 40, avgRating: 4.2, loved: [], complained: [] },
    serviceQuality: {
      tickets: 25,
      closedTickets: 25,
      csatCount: 20,
      csatAvg: 4.1,
      ticketsWithoutCsat: 0,
      returns: 3,
      returnRatePct: 3.8
    },
    orderFriction: { orderCount: 80, completedOrders: 70, cancelledOrders: 4, failedDelivery: 1, cancelReasons: [] }
  });
  assert.equal(enough.source, "analytics.star");
  assert.equal(enough.reliable.reviews, true);
  assert.equal(enough.reliable.csat, true);
});

test("capped rows keep observed sample reliability distinct from complete period coverage", () => {
  const voice = { productReaction: { reviewCount: 40 }, serviceQuality: { csatCount: 25 }, coverage: { deliveredOrders: 100 } };
  for (const flags of [{ truncated: true }, { meta: { truncated: true } }, { rowsCapped: true }, { meta: { rowsCapped: true } }]) {
    const capped = dashboardProvenance(false, { ...voice, ...flags });
    assert.equal(capped.reliable.complete, false);
    assert.equal(capped.reliable.reviews, true);
    assert.equal(capped.reliable.csat, true);
  }
  assert.equal(dashboardProvenance(false, { ...voice, truncated: false }).reliable.complete, true);
});

test("missing voice has no complete period or reliable samples", () => {
  for (const voice of [null, undefined]) {
    assert.deepEqual(dashboardProvenance(false, voice).reliable, { complete: false, reviews: false, csat: false });
  }
});

const now = new Date('2026-10-04T01:00:00Z');
function analyticsSnapshot() {
  return {
    schemaVersion: 3, source: 'analytics.star.v3', dataset: 'operational',
    snapshotAt: '2026-10-04T00:00:00Z', reconciled: true, freshness: 'stale', pendingEvents: 2,
    lastSync: { status: 'failed' },
    facts: emptyManagementFacts(),
    summary: { operations: { pendingOrders: 2 }, business: { revenue: 100, orderCount: 2, averageOrderValue: 50 } },
  };
}
const repositoryFor = (value: unknown): AnalyticsRepository => ({
  read: async () => value,
  refresh: async () => { throw new Error('GET must never refresh'); },
});

test('a failed latest sync does not invalidate or redate the last verified snapshot', async () => {
  const result = await buildDashboardSummary(null, now, repositoryFor(analyticsSnapshot()));
  assert.equal(result.business.revenue, 100);
  assert.equal(result.meta.validated, true);
  assert.equal(result.meta.freshness, 'stale');
  assert.equal(result.meta.updated_at, '2026-10-04T00:00:00Z');
  assert.equal(result.meta.lastSync.status, 'failed');
  assert.equal(result.management.groups[0].kpis?.aov, 50);
});

test('unverified, mismatched or unavailable snapshots cannot expose business metrics as zero or OLTP fallback', async () => {
  const valid = analyticsSnapshot();
  for (const source of [
    { ...valid, reconciled: false }, { ...valid, snapshotAt: null },
    { ...valid, snapshotAt: '2099-01-01T00:00:00Z' },
    { ...valid, facts: { ...valid.facts, snapshotAt: '2026-10-03T00:00:00Z' } },
    { ...valid, freshness: 'unavailable' }, { ...valid, facts: null },
  ]) {
    const result = await buildDashboardSummary(null, now, repositoryFor(source));
    assert.equal(result.business.revenue, null);
    assert.equal(result.business.averageOrderValue, null);
    assert.equal(result.operations.pendingOrders, 2);
    assert.equal(result.meta.source, 'unavailable');
    assert.equal(result.meta.freshness, 'unavailable');
    assert.equal(result.meta.validated, false);
    assert.ok(result.management.groups.every(group => group.availability === 'insufficient_data'));
    if (source.reconciled === false || !source.snapshotAt || source.snapshotAt.startsWith('2099')) assert.equal(result.meta.updated_at, null);
  }
});

test('dashboard reads preserve fixed period and dimension filters without synchronization', async () => {
  let readQuery: unknown;
  const source = analyticsSnapshot();
  const repository: AnalyticsRepository = {
    read: async query => { readQuery = query; return source; },
    refresh: async () => { throw new Error('Unexpected refresh'); },
  };
  const result = await buildDashboardSummary(new URLSearchParams('range=day&productId=00000000-0000-4000-8000-000000000001'), now, repository);
  assert.deepEqual(readQuery, { from: result.from, to: result.toExclusive, categoryId: null, productId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(result.previousToExclusive, result.from);
  assert.equal(Date.parse(result.toExclusive) - Date.parse(result.from), 86400000);
});

test('busy, throttled, failed and malformed sync results reject instead of reporting success', async () => {
  for (const status of ['busy', 'throttled', 'failed', 'succeeded']) {
    const repository: AnalyticsRepository = { read: async () => null, refresh: async () => ({ status, success: status === 'succeeded', snapshotAt: null }) };
    await assert.rejects(() => refreshDashboard('actor', repository), (error: unknown) =>
      error instanceof HttpError && error.status === (status === 'busy' || status === 'throttled' ? 429 : 502));
  }
});

test('dashboard viewer writes are denied before reaching the refresh repository', async () => {
  const args = {
    req: { method: 'POST' }, res: {}, url: new URL('https://velura.test/api/v1/admin/dashboard/refresh'),
    parts: ['api', 'v1', 'admin', 'dashboard', 'refresh'], headers: {},
    context: { authUser: { id: 'viewer' }, roleCode: 'admin_viewer', isAdmin: true, allowedModules: ['dashboard'], profile: { user_id: 'viewer', role: 'admin', admin_role: 'admin_viewer', is_active: true } },
  } as unknown as RouteArgs;
  await assert.rejects(() => handleDashboardRoute(args), (error: unknown) => error instanceof HttpError && error.status === 403);
});
