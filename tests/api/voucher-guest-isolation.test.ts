import test from "node:test";
import assert from "node:assert/strict";
import { filterMatchingEmailUserIds } from "../../apps/api/src/user/vouchers.js";

test("KAN-122: filterMatchingEmailUserIds excludes accounts owned by a different phone number", () => {
  const rows = [
    { user_id: "u-same-local", phone: "0912345678" },
    { user_id: "u-same-intl", phone: "+84912345678" },
    { user_id: "u-no-phone", phone: null },
    { user_id: "u-other-member", phone: "0988777666" }
  ];

  assert.deepEqual(
    filterMatchingEmailUserIds(rows, "0912345678"),
    ["u-same-local", "u-same-intl", "u-no-phone"]
  );
  assert.deepEqual(
    filterMatchingEmailUserIds(rows, ""),
    ["u-same-local", "u-same-intl", "u-no-phone", "u-other-member"]
  );
});
