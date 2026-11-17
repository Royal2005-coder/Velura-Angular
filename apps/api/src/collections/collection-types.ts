import type { JsonObject } from "../types.js";

/** Chế độ hiển thị hero trang /collections. */
export type CollectionHeroMode = "models" | "cover";

export interface Collection {
  collection_id: string;
  code: string;
  name: string;
  label: string;
  banner_url?: string | null;
  decor_url?: string | null;
  home_story?: string | null;
  col_number: string;
  script: string;
  hero_gradient: string;
  badge: string;
  kicker: string;
  story_headline: string;
  story_desc: string;
  explore_cta: string;
  category_link: string;
  products_sub: string;
  products_title: string;
  closing_quote: string;
  quote?: string | null;
  models: string[];
  story_paragraphs: string[];
  styling_metadata?: JsonObject;
  /** Chế độ hero của trang /collections: bố cục 5 người mẫu hoặc ảnh bìa full-bleed. */
  hero_mode: CollectionHeroMode;
  /** Ảnh cutout riêng của người mẫu trên trang chủ. */
  home_model_url: string | null;
  /** Có tham gia runway 5 người mẫu trang chủ hay không. */
  show_on_home: boolean;
  home_sort_order: number;
  /** Id combo/set theo thứ tự hiển thị (tối đa 10). */
  product_ids: string[];
  is_active: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateCollectionInput {
  code: string;
  name: string;
  label?: string;
  banner_url?: string | null;
  decor_url?: string | null;
  home_story?: string | null;
  col_number?: string;
  script?: string;
  hero_gradient?: string;
  badge?: string;
  kicker?: string;
  story_headline?: string;
  story_desc: string;
  explore_cta?: string;
  category_link?: string;
  products_sub?: string;
  products_title?: string;
  closing_quote?: string;
  quote?: string | null;
  models?: string[];
  story_paragraphs?: string[];
  styling_metadata?: JsonObject;
  hero_mode?: CollectionHeroMode;
  home_model_url?: string | null;
  show_on_home?: boolean;
  home_sort_order?: number;
  product_ids?: string[];
  is_active?: boolean;
  sort_order?: number;
}

export interface UpdateCollectionInput {
  code?: string;
  name?: string;
  label?: string;
  banner_url?: string | null;
  decor_url?: string | null;
  home_story?: string | null;
  col_number?: string;
  script?: string;
  hero_gradient?: string;
  badge?: string;
  kicker?: string;
  story_headline?: string;
  story_desc?: string;
  explore_cta?: string;
  category_link?: string;
  products_sub?: string;
  products_title?: string;
  closing_quote?: string;
  quote?: string | null;
  models?: string[];
  story_paragraphs?: string[];
  styling_metadata?: JsonObject;
  hero_mode?: CollectionHeroMode;
  home_model_url?: string | null;
  show_on_home?: boolean;
  home_sort_order?: number;
  product_ids?: string[];
  is_active?: boolean;
  sort_order?: number;
}
