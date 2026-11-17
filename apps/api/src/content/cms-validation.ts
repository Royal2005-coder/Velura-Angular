import { HttpError } from "../http.js";

/** Độ dài tối đa của một URL ảnh/video/liên kết do CMS lưu. */
export const CMS_URL_MAX_LENGTH = 500;

/**
 * Chặn chuỗi vượt quá độ dài cho phép.
 * @throws HttpError 400 `FIELD_TOO_LONG`.
 */
export function assertMaxLength(value: string, max: number, label: string): void {
  if (value.length > max) {
    throw new HttpError(400, "FIELD_TOO_LONG", `${label} tối đa ${max} ký tự`);
  }
}

/**
 * URL media lưu trong CMS: `https://…` (bất kỳ host) hoặc đường dẫn `/assets/…`.
 * Chặn `javascript:`, `data:`, `//host` và độ dài > 500.
 */
export function isValidMediaUrl(value: string): boolean {
  if (value.length === 0 || value.length > CMS_URL_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("/assets/")) return !value.includes("..");
  return /^https:\/\/[^/\s]+/i.test(value);
}

/**
 * Kiểm URL media của CMS.
 * @throws HttpError 400 `INVALID_MEDIA_URL`.
 */
export function assertMediaUrl(value: string, label: string): void {
  if (!isValidMediaUrl(value)) {
    throw new HttpError(
      400,
      "INVALID_MEDIA_URL",
      `${label} phải bắt đầu bằng https:// hoặc /assets/ và tối đa ${CMS_URL_MAX_LENGTH} ký tự`
    );
  }
}

/**
 * Liên kết điều hướng: đường dẫn nội bộ bắt đầu bằng `/` (không phải `//`) hoặc `https://`.
 * @throws HttpError 400 `INVALID_LINK_URL`.
 */
export function assertLinkUrl(value: string, label: string, max = CMS_URL_MAX_LENGTH): void {
  const internal = value.startsWith("/") && !value.startsWith("//");
  const external = /^https:\/\/[^/\s]+/i.test(value);
  if (!(internal || external) || /\s/.test(value) || value.length > max) {
    throw new HttpError(
      400,
      "INVALID_LINK_URL",
      `${label} phải bắt đầu bằng / hoặc https:// và tối đa ${max} ký tự`
    );
  }
}

/**
 * Kiểm số nguyên thứ tự trong khoảng [0, max] (mặc định 9999).
 * @throws HttpError 400 `INVALID_SORT_ORDER`.
 */
export function assertSortOrder(value: unknown, label: string, max = 9999): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new HttpError(400, "INVALID_SORT_ORDER", `${label} phải là số nguyên từ 0 đến ${max}`);
  }
  return value;
}
