import { HttpError } from "../http.js";
import type { Banner, BannerPlacement, CreateBannerInput, UpdateBannerInput } from "./banner-types.js";
import type { BannerRepository } from "./banner-repository.js";

const VALID_PLACEMENTS: BannerPlacement[] = ["home_hero", "products_hero", "collections_hero"];

export interface BannerService {
  listPublicBanners(placement?: string): Promise<Banner[]>;
  listAdminBanners(placement?: string): Promise<Banner[]>;
  getBanner(id: string): Promise<Banner>;
  createBanner(input: CreateBannerInput): Promise<Banner>;
  updateBanner(id: string, input: UpdateBannerInput): Promise<Banner>;
  deleteBanner(id: string): Promise<{ success: boolean }>;
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
      return repo.createBanner({
        ...input,
        title: input.title.trim(),
        media_url: input.media_url.trim(),
      });
    },

    async updateBanner(id: string, input: UpdateBannerInput) {
      if (input.placement && !VALID_PLACEMENTS.includes(input.placement)) {
        throw new HttpError(400, "INVALID_PLACEMENT", `Vị trí banner không hợp lệ: ${input.placement}`);
      }
      const updated = await repo.updateBanner(id, input);
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
