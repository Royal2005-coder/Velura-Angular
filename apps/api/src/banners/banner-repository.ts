import { deleteRows, insertRow, selectOne, selectRows, updateRows } from "../supabase.js";
import type { Banner, CreateBannerInput, UpdateBannerInput } from "./banner-types.js";

const BANNER_SELECT = "banner_id,placement,title,subtitle,tag_label,media_type,media_url,poster_url,button_text,link_url,is_active,sort_order,metadata,created_at,updated_at";

export interface BannerRepository {
  listBanners(filter?: { placement?: string; is_active?: boolean }): Promise<Banner[]>;
  getBannerById(id: string): Promise<Banner | null>;
  createBanner(input: CreateBannerInput): Promise<Banner>;
  updateBanner(id: string, input: UpdateBannerInput): Promise<Banner | null>;
  deleteBanner(id: string): Promise<boolean>;
}

export function createBannerRepository(): BannerRepository {
  return {
    async listBanners(filter) {
      const query: Record<string, unknown> = {
        select: BANNER_SELECT,
        order: "sort_order.asc,created_at.asc",
      };
      if (filter?.placement) {
        query.placement = `eq.${filter.placement}`;
      }
      if (typeof filter?.is_active === "boolean") {
        query.is_active = `eq.${filter.is_active}`;
      }

      const res = await selectRows("banners", query);
      return (res.rows || []) as unknown as Banner[];
    },

    async getBannerById(id: string) {
      const row = await selectOne("banners", {
        banner_id: `eq.${id}`,
        select: BANNER_SELECT,
      });
      return (row as unknown as Banner) || null;
    },

    async createBanner(input: CreateBannerInput) {
      const row = await insertRow("banners", {
        placement: input.placement,
        title: input.title,
        subtitle: input.subtitle ?? null,
        tag_label: input.tag_label ?? null,
        media_type: input.media_type || "image",
        media_url: input.media_url,
        poster_url: input.poster_url ?? null,
        button_text: input.button_text !== undefined ? input.button_text : "Khám phá ngay",
        link_url: input.link_url !== undefined ? input.link_url : "/products",
        is_active: input.is_active !== undefined ? input.is_active : true,
        sort_order: input.sort_order ?? 0,
        metadata: input.metadata || {},
      });
      return row as unknown as Banner;
    },

    async updateBanner(id: string, input: UpdateBannerInput) {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.placement !== undefined) updateData.placement = input.placement;
      if (input.title !== undefined) updateData.title = input.title;
      if (input.subtitle !== undefined) updateData.subtitle = input.subtitle;
      if (input.tag_label !== undefined) updateData.tag_label = input.tag_label;
      if (input.media_type !== undefined) updateData.media_type = input.media_type;
      if (input.media_url !== undefined) updateData.media_url = input.media_url;
      if (input.poster_url !== undefined) updateData.poster_url = input.poster_url;
      if (input.button_text !== undefined) updateData.button_text = input.button_text;
      if (input.link_url !== undefined) updateData.link_url = input.link_url;
      if (input.is_active !== undefined) updateData.is_active = input.is_active;
      if (input.sort_order !== undefined) updateData.sort_order = input.sort_order;
      if (input.metadata !== undefined) updateData.metadata = input.metadata;

      const updated = await updateRows("banners", { banner_id: `eq.${id}` }, updateData);
      return (updated[0] as unknown as Banner) || null;
    },

    async deleteBanner(id: string) {
      await deleteRows("banners", { banner_id: `eq.${id}` });
      return true;
    },
  };
}
