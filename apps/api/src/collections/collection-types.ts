import type { JsonObject } from "../types.js";

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
  is_active: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateCollectionInput {
  code: string;
  name: string;
  label: string;
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
  is_active?: boolean;
  sort_order?: number;
}
