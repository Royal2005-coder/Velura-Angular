import test from "node:test";
import assert from "node:assert/strict";
import { normalizePromotionPresentation } from "../../apps/api/src/pricing/promotion-presentation.js";
import { HttpError } from "../../apps/api/src/http.js";

/** Bắt lỗi HttpError và trả về mã để khẳng định cho gọn. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

test("trường không gửi thì trả về null ở cả hai chế độ", () => {
  for (const mode of ["create", "update"] as const) {
    const result = normalizePromotionPresentation({}, mode);
    assert.deepEqual(result, {
      description: null,
      bannerImageUrl: null,
      highlightLabel: null,
      displayOrder: null,
      isFeatured: null
    });
  }
});

test("chuỗi rỗng khi sửa là lệnh xoá, khi tạo chỉ là bỏ trống", () => {
  // Đây là khác biệt quan trọng nhất giữa hai chế độ: RPC hiểu null là "giữ nguyên",
  // nên lúc sửa phải để chuỗi rỗng đi tiếp xuống thì admin mới gỡ được ảnh banner đã
  // tải nhầm. Lúc tạo thì không có gì để giữ nguyên, rỗng quy về null.
  const cleared = normalizePromotionPresentation(
    { bannerImageUrl: "", description: "  ", highlightLabel: "" },
    "update"
  );
  assert.equal(cleared.bannerImageUrl, "");
  assert.equal(cleared.description, "");
  assert.equal(cleared.highlightLabel, "");

  const created = normalizePromotionPresentation(
    { bannerImageUrl: "", description: "  ", highlightLabel: "" },
    "create"
  );
  assert.equal(created.bannerImageUrl, null);
  assert.equal(created.description, null);
  assert.equal(created.highlightLabel, null);
});

test("khoảng trắng thừa bị cắt", () => {
  const result = normalizePromotionPresentation(
    { description: "  Sale cuối tuần  ", highlightLabel: " Chỉ còn 2 ngày " },
    "create"
  );
  assert.equal(result.description, "Sale cuối tuần");
  assert.equal(result.highlightLabel, "Chỉ còn 2 ngày");
});

test("nhãn nổi bật quá 60 ký tự bị chặn tại biên", () => {
  // Cột là varchar(60). Không chặn ở đây thì cơ sở dữ liệu ném 22001, một mã lỗi mà
  // người vận hành không hiểu gì.
  assert.equal(normalizePromotionPresentation({ highlightLabel: "x".repeat(60) }, "create").highlightLabel, "x".repeat(60));
  assert.equal(codeOf(() => normalizePromotionPresentation({ highlightLabel: "x".repeat(61) }, "create")), "VALIDATION_ERROR");
});

test("ảnh banner chỉ nhận http(s) hoặc đường dẫn nội bộ", () => {
  const ok = ["https://cdn.velura.vn/banner.jpg", "http://localhost:4200/a.png", "/assets/banner.webp"];
  for (const url of ok) {
    assert.equal(normalizePromotionPresentation({ bannerImageUrl: url }, "create").bannerImageUrl, url);
  }

  // Chuỗi này đi thẳng vào thuộc tính src phía khách; các lược đồ khác không có việc gì ở đó.
  const rejected = ["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "ftp://x/y.png", "cdn.velura.vn/a.jpg"];
  for (const url of rejected) {
    assert.equal(codeOf(() => normalizePromotionPresentation({ bannerImageUrl: url }, "create")), "VALIDATION_ERROR", url);
  }
});

test("thứ tự hiển thị phải là số nguyên không âm", () => {
  assert.equal(normalizePromotionPresentation({ displayOrder: 0 }, "create").displayOrder, 0);
  assert.equal(normalizePromotionPresentation({ displayOrder: "7" }, "create").displayOrder, 7);
  assert.equal(codeOf(() => normalizePromotionPresentation({ displayOrder: -1 }, "create")), "VALIDATION_ERROR");
  assert.equal(codeOf(() => normalizePromotionPresentation({ displayOrder: 1.5 }, "create")), "VALIDATION_ERROR");
  assert.equal(codeOf(() => normalizePromotionPresentation({ displayOrder: "nhiều" }, "create")), "VALIDATION_ERROR");
});

test("cờ nổi bật nhận cả boolean lẫn chuỗi từ form", () => {
  assert.equal(normalizePromotionPresentation({ isFeatured: true }, "create").isFeatured, true);
  assert.equal(normalizePromotionPresentation({ isFeatured: "false" }, "create").isFeatured, false);
  // Không gửi khác với gửi false: một cái là giữ nguyên, một cái là tắt.
  assert.equal(normalizePromotionPresentation({}, "update").isFeatured, null);
  assert.equal(codeOf(() => normalizePromotionPresentation({ isFeatured: "có" }, "create")), "VALIDATION_ERROR");
});

test("kiểu sai bị từ chối thay vì âm thầm ép kiểu", () => {
  assert.equal(codeOf(() => normalizePromotionPresentation({ description: 123 }, "create")), "VALIDATION_ERROR");
  assert.equal(codeOf(() => normalizePromotionPresentation({ bannerImageUrl: {} }, "create")), "VALIDATION_ERROR");
});
