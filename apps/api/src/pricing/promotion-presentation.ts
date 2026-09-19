import { HttpError } from "../http.js";

/**
 * Kiểm tra và chuẩn hoá phần nội dung trình bày của chiến dịch khuyến mãi.
 *
 * Đây là những trường khách nhìn thấy trên trang Ưu đãi — mô tả, ảnh banner, nhãn nổi
 * bật — nên chúng phải được chặn ngay tại biên chứ không chờ tới lúc cơ sở dữ liệu
 * ném lỗi 22001 khó đọc hoặc lúc trình duyệt dựng một thuộc tính src lạ.
 *
 * Không đụng I/O để test thẳng được.
 */

/** Độ dài tối đa của nhãn nổi bật, bằng đúng varchar(60) của cột. */
const HIGHLIGHT_LABEL_MAX = 60;

/** Trần mô tả. Cột là text nên không có giới hạn tự nhiên; đặt một mức đủ dùng. */
const DESCRIPTION_MAX = 2000;

/** Chỉ nhận đường dẫn http(s) hoặc đường dẫn nội bộ bắt đầu bằng "/". */
const SAFE_IMAGE_URL = /^(https?:\/\/|\/)/i;

export interface PromotionPresentation {
  description: string | null;
  bannerImageUrl: string | null;
  highlightLabel: string | null;
  displayOrder: number | null;
  isFeatured: boolean | null;
}

/**
 * `create`: trường bỏ trống trở thành null để bản ghi mới nhận giá trị mặc định.
 * `update`: trường bỏ trống trở thành null nghĩa là "giữ nguyên"; muốn xoá thì gửi
 * chuỗi rỗng, và chuỗi rỗng được giữ nguyên để RPC hiểu là lệnh xoá.
 */
export type PresentationMode = "create" | "update";

/**
 * Chuẩn hoá năm trường trình bày. Ném HttpError 422 nếu giá trị không hợp lệ.
 */
export function normalizePromotionPresentation(
  body: Record<string, unknown> | null | undefined,
  mode: PresentationMode
): PromotionPresentation {
  const source = body || {};
  return {
    description: textField(source.description, "description", DESCRIPTION_MAX, mode),
    bannerImageUrl: imageUrlField(source.bannerImageUrl, mode),
    highlightLabel: textField(source.highlightLabel, "highlightLabel", HIGHLIGHT_LABEL_MAX, mode),
    displayOrder: displayOrderField(source.displayOrder),
    isFeatured: booleanField(source.isFeatured)
  };
}

/** Chuỗi có giới hạn độ dài. */
function textField(value: unknown, field: string, max: number, mode: PresentationMode): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "VALIDATION_ERROR", `${field} phải là chuỗi`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(422, "VALIDATION_ERROR", `${field} tối đa ${max} ký tự`);
  }
  // Lúc tạo mới, chuỗi rỗng và không gửi là một. Lúc sửa, chuỗi rỗng là lệnh xoá nên
  // phải đi tiếp xuống RPC thay vì bị quy về null (null ở đó nghĩa là giữ nguyên).
  if (trimmed === "") return mode === "update" ? "" : null;
  return trimmed;
}

/** Đường dẫn ảnh banner. */
function imageUrlField(value: unknown, mode: PresentationMode): string | null {
  const text = textField(value, "bannerImageUrl", 500, mode);
  if (text === null || text === "") return text;
  if (!SAFE_IMAGE_URL.test(text)) {
    throw new HttpError(422, "VALIDATION_ERROR", "bannerImageUrl phải là đường dẫn http(s) hoặc bắt đầu bằng /");
  }
  return text;
}

/** Thứ tự hiển thị: số nguyên không âm. */
function displayOrderField(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "displayOrder phải là số nguyên không âm");
  }
  return parsed;
}

/** Cờ nổi bật. Chấp nhận cả chuỗi "true"/"false" vì form gửi lên dạng chuỗi. */
function booleanField(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(422, "VALIDATION_ERROR", "isFeatured phải là true hoặc false");
}
