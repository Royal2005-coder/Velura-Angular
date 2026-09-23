import test from "node:test";
import assert from "node:assert/strict";
import { quotePostgrestValue } from "../../apps/api/src/reviews/review-repository.js";

const BACKSLASH = String.fromCharCode(92);

test("a comma in the search box is data, not a filter separator", () => {
  // Đây là ca đã làm hỏng ô tìm kiếm thật: PostgREST tách `or=(...)` ở mọi dấu phẩy
  // không được bọc, nên `Áo dài, đẹp` sinh ra một mệnh đề cụt và máy chủ trả 400
  // PGRST100. Bọc trong nháy kép khiến dấu phẩy nằm trong giá trị.
  assert.equal(quotePostgrestValue("*Ao dai, dep*"), '"*Ao dai, dep*"');
});

test("parentheses cannot close the filter group early", () => {
  assert.equal(quotePostgrestValue("*ao (dai)*"), '"*ao (dai)*"');
});

test("a double quote in the search term is escaped, not left to close the quoting", () => {
  assert.equal(quotePostgrestValue('say "hello"'), '"say ' + BACKSLASH + '"hello' + BACKSLASH + '""');
});

test("a backslash is escaped before the quote escaping, so it cannot eat the next character", () => {
  // Thứ tự quan trọng: thoát dấu chéo ngược trước, rồi mới tới nháy kép. Làm ngược lại
  // thì `\"` do bước sau sinh ra sẽ bị bước trước nhân đôi thành `\\"` và nháy kép lại
  // thoát ra ngoài.
  assert.equal(quotePostgrestValue("back" + BACKSLASH + "slash"), '"back' + BACKSLASH + BACKSLASH + 'slash"');
  assert.equal(
    quotePostgrestValue(BACKSLASH + '"'),
    '"' + BACKSLASH + BACKSLASH + BACKSLASH + '""'
  );
});

test("an empty search term still produces a well-formed quoted value", () => {
  assert.equal(quotePostgrestValue("**"), '"**"');
});
