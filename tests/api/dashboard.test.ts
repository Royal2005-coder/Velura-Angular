import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardSummary, resolveDashboardPeriod, dashboardProvenance } from "../../apps/api/src/dashboard.js";

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
