import test from "node:test";
import assert from "node:assert/strict";
import { RETURN_WINDOW_DAYS, returnWindowOpen } from "../../apps/api/src/user/return-window.js";

test("the delivery window is exactly seven inclusive elapsed days and fails closed", () => {
  assert.equal(RETURN_WINDOW_DAYS, 7);
  const delivered = new Date("2026-09-16T00:00:00.000Z");
  assert.equal(returnWindowOpen(delivered, new Date("2026-09-23T00:00:00.000Z")), true);
  assert.equal(returnWindowOpen(delivered, new Date("2026-09-23T00:00:00.001Z")), false);
  assert.equal(returnWindowOpen(delivered, new Date("2026-09-15T23:59:59.999Z")), false);
  assert.equal(returnWindowOpen(new Date("invalid"), new Date()), false);
});
