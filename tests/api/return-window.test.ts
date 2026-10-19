import test from "node:test";
import assert from "node:assert/strict";
import { RETURN_WINDOW_DAYS, returnWindowOpen } from "../../apps/api/src/user/return-window.js";

test("a delivered order can be returned for 7 days", () => {
  assert.equal(RETURN_WINDOW_DAYS, 7);
  const delivered = new Date("2026-08-24T00:00:00.000Z");
  assert.equal(returnWindowOpen(delivered, new Date("2026-08-31T00:00:00.000Z")), true);
  assert.equal(returnWindowOpen(delivered, new Date("2026-08-31T00:00:01.000Z")), false);
});
