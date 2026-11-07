import test from "node:test";
import assert from "node:assert/strict";
import { searchFold, searchMatches } from "../../apps/api/src/search-text.js";

test("search folding ignores case, Vietnamese diacritics and the letter đ", () => {
  assert.equal(searchFold("Giáo Dục"), "giao duc");
  assert.equal(searchFold("TÚI XÁCH"), "tui xach");
  assert.equal(searchFold("Đơn hàng đã huỷ"), "don hang da huy");
  assert.equal(searchFold("  VLR-001 "), "vlr-001");
  assert.equal(searchFold("Nguyễn Thị Ươm"), "nguyen thi uom");
});

test("folded match spans multiple fields and accepts partial keywords", () => {
  assert.equal(searchMatches("giao duc", "Áo thun", "Giáo dục"), true);
  assert.equal(searchMatches("tui", "Túi xách da"), true);
  assert.equal(searchMatches("vlr", "VLR-001"), true);
  assert.equal(searchMatches("thu dong", "Thu đông 2026"), true);
  assert.equal(searchMatches("khong co", "VLR-001", "Nguyễn A"), false);
});

test("an empty query matches every row so callers can skip filtering", () => {
  assert.equal(searchMatches("", "anything"), true);
  assert.equal(searchMatches("   ", "anything"), true);
});
