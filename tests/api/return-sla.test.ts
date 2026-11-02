import test from "node:test";
import assert from "node:assert/strict";
import {
  REFUND_SLA_MAX_WORKING_DAYS, REFUND_SLA_MIN_WORKING_DAYS, addWorkingDays, refundDueAt, refundSlaState
} from "../../apps/api/src/returns/return-sla.js";

test("refund SLA constants follow the BA promise of 4-5 working days", () => {
  assert.equal(REFUND_SLA_MIN_WORKING_DAYS, 4);
  assert.equal(REFUND_SLA_MAX_WORKING_DAYS, 5);
});

test("working-day math skips Saturday and Sunday in Vietnam time", () => {
  // 2026-11-06 is a Friday, 10:00 in Vietnam.
  const friday = new Date("2026-11-06T03:00:00Z");
  assert.equal(addWorkingDays(friday, 0).toISOString(), friday.toISOString());
  assert.equal(addWorkingDays(friday, 1).toISOString(), "2026-11-09T03:00:00.000Z");
  assert.equal(addWorkingDays(friday, 5).toISOString(), "2026-11-13T03:00:00.000Z");
  const monday = new Date("2026-11-02T03:00:00Z");
  assert.equal(addWorkingDays(monday, 5).toISOString(), "2026-11-09T03:00:00.000Z");
  assert.equal(addWorkingDays(monday, 4).toISOString(), "2026-11-06T03:00:00.000Z");
});

test("a weekend start counts from the next Monday and the Vietnam calendar day decides the weekday", () => {
  const saturday = new Date("2026-11-07T03:00:00Z");
  assert.equal(addWorkingDays(saturday, 1).toISOString(), "2026-11-09T03:00:00.000Z");
  // 18:00 UTC Friday is already 01:00 Saturday in Vietnam.
  assert.equal(addWorkingDays(new Date("2026-11-06T18:00:00Z"), 1).toISOString(), "2026-11-08T18:00:00.000Z");
});

test("refund deadline uses the upper SLA bound and rejects invalid input", () => {
  const received = new Date("2026-11-02T03:00:00Z");
  assert.equal(refundDueAt(received).toISOString(), addWorkingDays(received, REFUND_SLA_MAX_WORKING_DAYS).toISOString());
  assert.throws(() => addWorkingDays(received, -1), RangeError);
  assert.throws(() => addWorkingDays(received, 1.5), RangeError);
  assert.throws(() => addWorkingDays(new Date("nope"), 1), RangeError);
});

test("SLA state distinguishes none, on track, due soon and overdue", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  assert.equal(refundSlaState(null, now), "none");
  assert.equal(refundSlaState("not-a-date", now), "none");
  assert.equal(refundSlaState("2026-11-14T00:00:00Z", now), "on_track");
  assert.equal(refundSlaState("2026-11-10T12:00:00Z", now), "due_soon");
  assert.equal(refundSlaState("2026-11-09T23:59:59Z", now), "overdue");
});
