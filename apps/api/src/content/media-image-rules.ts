import sharp from "sharp";
import { HttpError } from "../http.js";
import { VIDEO_MIME_TYPES } from "../storage.js";

/** Danh mục tải media CMS hợp lệ (FR-S2). `media` là mặc định, dùng cho blog. */
export type CmsUploadCategory = "banner" | "collection-cover" | "collection-model" | "media";

/** Thư mục lưu trong storage theo danh mục. */
export const CMS_UPLOAD_PREFIX: Record<CmsUploadCategory, string> = {
  banner: "banners",
  "collection-cover": "collections/covers",
  "collection-model": "collections/models",
  media: "cms-media",
};

/** Ngưỡng của ảnh người mẫu đã xóa nền (FR-11). */
const MODEL_MIN_WIDTH = 600;
const MODEL_MIN_RATIO = 1.2;
const MODEL_MAX_RATIO = 2.4;
const CORNER_PATCH = 4;
const CORNER_MAX_ALPHA = 10;
const TRANSPARENT_MAX_ALPHA = 10;
const OPAQUE_MIN_ALPHA = 128;
const MIN_TRANSPARENT_SHARE = 0.15;
const MIN_OPAQUE_SHARE = 0.05;
/** Ảnh phân tích được thu nhỏ về chiều rộng này (nearest) để giới hạn bộ nhớ. */
const ANALYSIS_WIDTH = 480;
/** Chặn ảnh quá lớn trước khi giải mã. */
const MAX_PIXELS = 50_000_000;

/** Ngưỡng của ảnh bìa bộ sưu tập (FR-S2). */
const COVER_MIN_WIDTH = 1280;
const COVER_MIN_RATIO = 1.5;
const COVER_MAX_RATIO = 2.4;

/**
 * Chuẩn hóa tham số `category` của upload.
 * @throws HttpError 400 `INVALID_UPLOAD_CATEGORY` khi giá trị lạ (kể cả `collection` cũ).
 */
export function parseUploadCategory(raw: string | null | undefined): CmsUploadCategory {
  const value = raw && raw !== "" ? raw : "media";
  if (value === "banner" || value === "collection-cover" || value === "collection-model" || value === "media") {
    return value;
  }
  throw new HttpError(
    400,
    "INVALID_UPLOAD_CATEGORY",
    "Danh mục tải lên không hợp lệ (banner, collection-cover, collection-model hoặc media)"
  );
}

/** Danh mục nào nhận video: chỉ banner. */
export function categoryAllowsVideo(category: CmsUploadCategory): boolean {
  return category === "banner";
}

interface ImageInfo {
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

async function readImageInfo(buffer: Buffer): Promise<ImageInfo | null> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.format || !meta.width || !meta.height) return null;
    return { format: meta.format, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha === true };
  } catch {
    return null;
  }
}

function formatError(message: string): HttpError {
  return new HttpError(422, "MODEL_FORMAT_INVALID", message);
}

function dimensionsError(message: string): HttpError {
  return new HttpError(422, "MODEL_DIMENSIONS_INVALID", message);
}

function alphaError(message: string): HttpError {
  return new HttpError(422, "MODEL_ALPHA_REQUIRED", message);
}

/** Ảnh người mẫu: PNG/WebP, có alpha, góc trong suốt, đủ vùng trong suốt và vùng đục, đủ kích thước. */
async function validateModelImage(buffer: Buffer): Promise<void> {
  const info = await readImageInfo(buffer);
  if (!info || (info.format !== "png" && info.format !== "webp")) {
    throw formatError("Ảnh người mẫu phải là PNG hoặc WebP đã xóa nền");
  }
  if (info.width * info.height > MAX_PIXELS) {
    throw dimensionsError("Ảnh người mẫu quá lớn (tối đa 50 triệu điểm ảnh)");
  }
  const ratio = info.height / info.width;
  if (info.width < MODEL_MIN_WIDTH || ratio < MODEL_MIN_RATIO || ratio > MODEL_MAX_RATIO) {
    throw dimensionsError(
      `Ảnh người mẫu cần rộng tối thiểu ${MODEL_MIN_WIDTH}px và tỉ lệ cao/rộng từ ${MODEL_MIN_RATIO} đến ${MODEL_MAX_RATIO} (hiện ${info.width}×${info.height})`
    );
  }
  if (!info.hasAlpha) {
    throw alphaError("Ảnh người mẫu phải có nền trong suốt (kênh alpha). Hãy xóa nền trước khi tải lên");
  }

  let raw: { data: Buffer; width: number; height: number };
  try {
    const pipeline = sharp(buffer).ensureAlpha();
    const resized = info.width > ANALYSIS_WIDTH ? pipeline.resize({ width: ANALYSIS_WIDTH, kernel: "nearest" }) : pipeline;
    const result = await resized.raw().toBuffer({ resolveWithObject: true });
    raw = { data: result.data, width: result.info.width, height: result.info.height };
  } catch {
    throw formatError("Không đọc được ảnh người mẫu");
  }

  const { data, width, height } = raw;
  const alphaAt = (x: number, y: number): number => data[(y * width + x) * 4 + 3];

  const patchW = Math.min(CORNER_PATCH, width);
  const patchH = Math.min(CORNER_PATCH, height);
  const origins: Array<[number, number]> = [
    [0, 0],
    [width - patchW, 0],
    [0, height - patchH],
    [width - patchW, height - patchH],
  ];
  for (const [ox, oy] of origins) {
    for (let y = oy; y < oy + patchH; y += 1) {
      for (let x = ox; x < ox + patchW; x += 1) {
        if (alphaAt(x, y) > CORNER_MAX_ALPHA) {
          throw alphaError("Bốn góc ảnh phải trong suốt: ảnh vẫn còn nền, hãy xóa nền trước khi tải lên");
        }
      }
    }
  }

  let transparent = 0;
  let opaque = 0;
  const total = width * height;
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha <= TRANSPARENT_MAX_ALPHA) transparent += 1;
    else if (alpha >= OPAQUE_MIN_ALPHA) opaque += 1;
  }
  if (transparent / total < MIN_TRANSPARENT_SHARE) {
    throw alphaError(
      `Ảnh cần có tối thiểu ${Math.round(MIN_TRANSPARENT_SHARE * 100)}% vùng trong suốt (nền đã xóa)`
    );
  }
  if (opaque / total < MIN_OPAQUE_SHARE) {
    throw alphaError(
      `Ảnh cần có tối thiểu ${Math.round(MIN_OPAQUE_SHARE * 100)}% vùng đục (người mẫu); ảnh gần như trong suốt hoàn toàn`
    );
  }
}

/** Ảnh bìa bộ sưu tập: JPEG/PNG/WebP, rộng ≥ 1280px, tỉ lệ rộng/cao 1.5–2.4. */
async function validateCoverImage(buffer: Buffer): Promise<void> {
  const info = await readImageInfo(buffer);
  if (!info || (info.format !== "jpeg" && info.format !== "png" && info.format !== "webp")) {
    throw formatError("Ảnh bìa phải là JPEG, PNG hoặc WebP");
  }
  if (info.width * info.height > MAX_PIXELS) {
    throw dimensionsError("Ảnh bìa quá lớn (tối đa 50 triệu điểm ảnh)");
  }
  const ratio = info.width / info.height;
  if (info.width < COVER_MIN_WIDTH || ratio < COVER_MIN_RATIO || ratio > COVER_MAX_RATIO) {
    throw dimensionsError(
      `Ảnh bìa cần rộng tối thiểu ${COVER_MIN_WIDTH}px và tỉ lệ rộng/cao từ ${COVER_MIN_RATIO} đến ${COVER_MAX_RATIO} (hiện ${info.width}×${info.height})`
    );
  }
}

/**
 * Kiểm tệp tải lên theo danh mục (hàm thuần: chỉ nhận buffer, không chạm storage).
 * - Video chỉ hợp lệ với `banner` (ngược lại 400 `VIDEO_NOT_ALLOWED`).
 * - `collection-model`: PNG/WebP có alpha, góc trong suốt, đủ vùng trong/đục, rộng ≥ 600px, cao/rộng 1.2–2.4.
 * - `collection-cover`: JPEG/PNG/WebP, rộng ≥ 1280px, rộng/cao 1.5–2.4.
 * @throws HttpError 400 `VIDEO_NOT_ALLOWED`; 422 `MODEL_FORMAT_INVALID` | `MODEL_DIMENSIONS_INVALID` | `MODEL_ALPHA_REQUIRED`.
 */
export async function validateCmsUpload(args: {
  category: CmsUploadCategory;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ ok: true }> {
  const { category, buffer, mimeType } = args;
  if (VIDEO_MIME_TYPES.includes(mimeType)) {
    if (!categoryAllowsVideo(category)) {
      throw new HttpError(400, "VIDEO_NOT_ALLOWED", "Danh mục này chỉ nhận ảnh; video chỉ dùng cho banner");
    }
    return { ok: true };
  }
  if (category === "collection-model") await validateModelImage(buffer);
  else if (category === "collection-cover") await validateCoverImage(buffer);
  return { ok: true };
}
