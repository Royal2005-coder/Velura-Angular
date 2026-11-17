import { HttpError } from "../http.js";
import type { JsonObject } from "../types.js";
import { assertLinkUrl, assertMaxLength, assertMediaUrl, assertSortOrder } from "../content/cms-validation.js";
import type { Banner, BannerPlacement, CreateBannerInput, UpdateBannerInput } from "./banner-types.js";
import type { BannerRepository } from "./banner-repository.js";

const VALID_PLACEMENTS: BannerPlacement[] = ["products_hero"];
const MAX_SORT_ORDER = 2147483647;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Chuẩn hóa `metadata` của banner (`autoplay`, `sound_default`, `focal_x`, `focal_y`, `focal_zoom`)
 * và chặn dữ liệu không phải plain object hoặc số không hợp lệ.
 */
function normalizeBannerMetadata(value: unknown): JsonObject {
  if (!isPlainObject(value)) {
    throw new HttpError(400, "FIELD_INVALID", "Metadata banner không hợp lệ");
  }
  const out: JsonObject = {};
  for (const [key, rawVal] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (key === "focal_x" || key === "focal_y") {
      if (typeof rawVal !== "number" || !Number.isFinite(rawVal)) {
        throw new HttpError(400, "FIELD_INVALID", "Tọa độ khung hình banner không hợp lệ");
      }
      out[key] = Math.round(Math.min(100, Math.max(0, rawVal)) * 10) / 10;
    } else if (key === "focal_zoom") {
      if (typeof rawVal !== "number" || !Number.isFinite(rawVal)) {
        throw new HttpError(400, "FIELD_INVALID", "Độ thu phóng banner không hợp lệ");
      }
      out[key] = Math.round(Math.min(2.4, Math.max(1, rawVal)) * 100) / 100;
    } else if (key === "autoplay" || key === "sound_default") {
      if (typeof rawVal !== "boolean") {
        throw new HttpError(400, "FIELD_INVALID", `Cấu hình ${key} không hợp lệ`);
      }
      out[key] = rawVal;
    } else {
      out[key] = rawVal;
    }
  }
  return out;
}

export interface BannerService {
  listPublicBanners(placement?: string): Promise<Banner[]>;
  listAdminBanners(placement?: string): Promise<Banner[]>;
  getBanner(id: string): Promise<Banner>;
  createBanner(input: CreateBannerInput): Promise<Banner>;
  updateBanner(id: string, input: UpdateBannerInput): Promise<Banner>;
  deleteBanner(id: string): Promise<{ success: boolean }>;
}

/**
 * Kiểm các trường có mặt trong input (FR-19): độ dài, `link_url`, URL media, `sort_order`.
 * Trường chuỗi được trim; chuỗi rỗng của trường tùy chọn thành null.
 */
function normalizeBannerFields<T extends UpdateBannerInput>(input: T): T {
  const out: T = { ...input };
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title === "") throw new HttpError(400, "TITLE_REQUIRED", "Tiêu đề banner là bắt buộc");
    assertMaxLength(title, 120, "Tiêu đề banner");
    out.title = title;
  }
  const optionalText: Array<["subtitle" | "button_text", number, string]> = [
    ["subtitle", 240, "Mô tả banner"],
    ["button_text", 40, "Chữ trên nút"],
  ];
  for (const [field, max, label] of optionalText) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim() : "";
    assertMaxLength(text, max, label);
    out[field] = text === "" ? null : text;
  }
  if (input.link_url !== undefined && input.link_url !== null) {
    const link = typeof input.link_url === "string" ? input.link_url.trim() : "";
    if (link !== "") assertLinkUrl(link, "Liên kết banner");
    out[("link_url")] = link === "" ? null : link;
  }
  if (input.media_url !== undefined) {
    const media = typeof input.media_url === "string" ? input.media_url.trim() : "";
    if (media === "") throw new HttpError(400, "MEDIA_URL_REQUIRED", "Đường dẫn hình ảnh hoặc video là bắt buộc");
    assertMediaUrl(media, "Đường dẫn media");
    out.media_url = media;
  }
  if (input.poster_url !== undefined && input.poster_url !== null) {
    const poster = typeof input.poster_url === "string" ? input.poster_url.trim() : "";
    if (poster !== "") assertMediaUrl(poster, "Ảnh poster");
    out.poster_url = poster === "" ? null : poster;
  }
  if (input.sort_order !== undefined) {
    out.sort_order = assertSortOrder(input.sort_order, "Thứ tự banner", MAX_SORT_ORDER);
  }
  if (input.metadata !== undefined) {
    out.metadata = normalizeBannerMetadata(input.metadata);
  }
  return out;
}

export function createBannerService(deps: { repository: BannerRepository }): BannerService {
  const repo = deps.repository;

  return {
    async listPublicBanners(placement?: string) {
      if (placement && !VALID_PLACEMENTS.includes(placement as BannerPlacement)) {
        throw new HttpError(400, "INVALID_PLACEMENT", `Vị trí banner không hợp lệ: ${placement}`);
      }
      return repo.listBanners({ placement, is_active: true });
    },

    async listAdminBanners(placement?: string) {
      return repo.listBanners({ placement });
    },

    async getBanner(id: string) {
      const banner = await repo.getBannerById(id);
      if (!banner) {
        throw new HttpError(404, "BANNER_NOT_FOUND", "Không tìm thấy banner");
      }
      return banner;
    },

    async createBanner(input: CreateBannerInput) {
      if (!input.title || input.title.trim() === "") {
        throw new HttpError(400, "TITLE_REQUIRED", "Tiêu đề banner là bắt buộc");
      }
      if (!input.media_url || input.media_url.trim() === "") {
        throw new HttpError(400, "MEDIA_URL_REQUIRED", "Đường dẫn hình ảnh hoặc video là bắt buộc");
      }
      if (!VALID_PLACEMENTS.includes(input.placement)) {
        throw new HttpError(400, "INVALID_PLACEMENT", `Vị trí banner không hợp lệ: ${input.placement}`);
      }
      return repo.createBanner(normalizeBannerFields(input));
    },

    async updateBanner(id: string, input: UpdateBannerInput) {
      if (input.placement && !VALID_PLACEMENTS.includes(input.placement)) {
        throw new HttpError(400, "INVALID_PLACEMENT", `Vị trí banner không hợp lệ: ${input.placement}`);
      }
      const existing = await repo.getBannerById(id);
      if (!existing) {
        throw new HttpError(404, "BANNER_NOT_FOUND", "Không tìm thấy banner cần cập nhật");
      }
      const normalized = normalizeBannerFields(input);
      if (normalized.metadata !== undefined) {
        const baseMeta = isPlainObject(existing.metadata) ? existing.metadata : {};
        normalized.metadata = { ...baseMeta, ...normalized.metadata };
      }
      const updated = await repo.updateBanner(id, normalized);
      if (!updated) {
        throw new HttpError(404, "BANNER_NOT_FOUND", "Không tìm thấy banner cần cập nhật");
      }
      return updated;
    },

    async deleteBanner(id: string) {
      await repo.deleteBanner(id);
      return { success: true };
    },
  };
}
