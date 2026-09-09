import test from "node:test";
import assert from "node:assert/strict";
import { resolveDashboardPeriod } from "../../apps/api/src/dashboard.js";

test("dashboard week is seven complete Vietnam calendar days", () => {
  const params = new URLSearchParams("range=week");
  const period = resolveDashboardPeriod(params, new Date("2026-07-12T02:30:00.000Z"));
  assert.equal(period.days, 7);
  assert.equal(period.from.toISOString(), "2026-07-05T17:00:00.000Z");
  assert.equal(period.to.toISOString(), "2026-07-12T17:00:00.000Z");
});

test("dashboard custom range includes the full ending business day", () => {
  const params = new URLSearchParams("from=2026-06-21&to=2026-06-27");
  const period = resolveDashboardPeriod(params);
  assert.equal(period.range, "custom");
  assert.equal(period.days, 7);
  assert.equal(period.from.toISOString(), "2026-06-20T17:00:00.000Z");
  assert.equal(period.to.toISOString(), "2026-06-27T17:00:00.000Z");
});

test("dashboard rejects partial and invalid custom ranges", () => {
  assert.throws(() => resolveDashboardPeriod(new URLSearchParams("from=2026-06-21")), /đủ ngày/);
  assert.throws(() => resolveDashboardPeriod(new URLSearchParams("from=2026-02-30&to=2026-03-01")), /không phải ngày hợp lệ/);
});
