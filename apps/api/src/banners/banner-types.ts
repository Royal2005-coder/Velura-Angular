import type { JsonObject } from "../types.js";

/** Vị trí banner. Chỉ `products_hero` có nơi hiển thị thật (trang /products). */
export type BannerPlacement = "products_hero";
export type BannerMediaType = "image" | "video";

export interface Banner {
  banner_id: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string | null;
  tag_label: string | null;
  media_type: BannerMediaType;
  media_url: string;
  poster_url: string | null;
  button_text: string | null;
  link_url: string | null;
  is_active: boolean;
  sort_order: number;
  metadata: JsonObject;
  created_at?: string;
  updated_at?: string;
}

export interface CreateBannerInput {
  placement: BannerPlacement;
  title: string;
  subtitle?: string | null;
  tag_label?: string | null;
  media_type?: BannerMediaType;
  media_url: string;
  poster_url?: string | null;
  button_text?: string | null;
  link_url?: string | null;
  is_active?: boolean;
  sort_order?: number;
  metadata?: JsonObject;
}

export interface UpdateBannerInput {
  placement?: BannerPlacement;
  title?: string;
  subtitle?: string | null;
  tag_label?: string | null;
  media_type?: BannerMediaType;
  media_url?: string;
  poster_url?: string | null;
  button_text?: string | null;
  link_url?: string | null;
  is_active?: boolean;
  sort_order?: number;
  metadata?: JsonObject;
}
