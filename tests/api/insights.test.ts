import test from "node:test";
import assert from "node:assert/strict";
import { resolveDashboardPeriod } from "../../apps/api/src/dashboard.js";
import { buildInsightBoard, deriveVoiceInsights, moduleForInsightScope } from "../../apps/api/src/insights.js";
import type { VoiceFacts } from "../../apps/api/src/insights.js";

function facts(overrides: Partial<VoiceFacts> = {}): VoiceFacts {
  return {
    orders: [],
    reviews: [],
    returns: [],
    tickets: [],
    products: {},
    ...overrides
  };
}

test("dashboard period rejects custom from/to and only allows day week month", () => {
  const week = resolveDashboardPeriod(new URLSearchParams("range=week"), new Date("2026-07-12T02:30:00.000Z"));
  assert.equal(week.days, 7);
  assert.equal(week.range, "week");
  assert.throws(
    () => resolveDashboardPeriod(new URLSearchParams("from=2026-06-21&to=2026-06-27")),
    /ngày, tuần hoặc tháng/
  );
  assert.throws(() => resolveDashboardPeriod(new URLSearchParams("range=custom")), /ngày, tuần hoặc tháng/);
});

test("silent delivered orders block product planning", () => {
  const voice = deriveVoiceInsights(
    facts({
      orders: [
        { order_id: "o1", status: "delivered" },
        { order_id: "o2", status: "completed" }
      ]
    }),
    "week"
  );
  assert.equal(voice.coverage.deliveredOrders, 2);
  assert.equal(voice.coverage.silentOrders, 2);
  assert.equal(voice.coverage.coveragePct, 0);
  const board = buildInsightBoard("products", voice);
  const coverage = board.questions.find((item) => item.id === "coverage");
  assert.equal(coverage?.severity, "critical");
  assert.match(coverage?.answer || "", /không đánh giá/);
  assert.ok(board.actions.some((item) => item.id === "nudge-review"));
});

test("closed tickets without CSAT are an incomplete CSKH measurement", () => {
  const voice = deriveVoiceInsights(
    facts({
      tickets: [
        { ticket_id: "t1", status: "closed", csat_score: null },
        { ticket_id: "t2", status: "resolved" }
      ]
    }),
    "month"
  );
  assert.equal(voice.serviceQuality.ticketsWithoutCsat, 2);
  assert.equal(voice.serviceQuality.csatCount, 0);
  const board = buildInsightBoard("returns", voice);
  const cskh = board.questions.find((item) => item.id === "cskh");
  assert.equal(cskh?.severity, "critical");
  assert.match(cskh?.answer || "", /không chấm CSAT/);
  assert.ok(board.actions.some((item) => item.id === "force-csat"));
});

test("low product ratings map to a complained SKU and a client-steer action", () => {
  const voice = deriveVoiceInsights(
    facts({
      orders: [{ order_id: "o1", status: "delivered" }],
      reviews: [
        { order_id: "o1", product_id: "p1", rating: 1 },
        { order_id: "o1", product_id: "p1", rating: 2 }
      ],
      products: { p1: { name: "Áo lụa", sku: "AO-1" } }
    }),
    "week"
  );
  assert.equal(voice.productReaction.complained[0]?.name, "Áo lụa");
  const board = buildInsightBoard("hq", voice, { revenue: 1_000_000, orderCount: 1, comparisons: {} });
  assert.ok(board.questions.some((item) => item.id === "revenue"));
  assert.ok(board.actions.some((item) => item.clientSteer.includes("PDP")));
});

test("insight scopes map onto RBAC modules and keep HQ on dashboard", () => {
  assert.equal(moduleForInsightScope("hq"), "dashboard");
  assert.equal(moduleForInsightScope("products"), "products");
  assert.equal(moduleForInsightScope("returns"), "returns");
  assert.equal(moduleForInsightScope("logs"), "audit_logs");
});
