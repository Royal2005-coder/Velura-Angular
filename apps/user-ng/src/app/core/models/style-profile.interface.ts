import type { ProductSummary } from './product.interface';

/** Existing Style Quiz answers; Personal Color must extend this profile once its provider contract is agreed. */
export interface StyleQuizAnswers {
  height_cm: number;
  weight_kg: number;
  chest_cm: number;
  waist_cm: number;
  hip_cm: number;
  body_shape: string;
  skin_tone: string;
  style_tags: string[];
  preferred_occasions: string[];
  favorite_brands: string[];
  budget_range: string;
  age_group: string;
  favorite_colors: string[];
}

/** Incomplete same-tab quiz state; it is not a completed Style Profile. */
export interface StyleQuizDraft {
  step: number;
  answers: Partial<StyleQuizAnswers>;
}

/** Persisted profile fields consumed by existing personalization. */
export interface StyleQuizRecord {
  height_cm?: number | null;
  weight_kg?: number | null;
  chest_cm?: number | null;
  waist_cm?: number | null;
  hip_cm?: number | null;
  body_shape?: string | null;
  style_tags?: string[] | string | null;
  skin_tone?: string | null;
  preferred_occasions?: string[] | string | null;
  favorite_brands?: string[] | string | null;
  budget_range?: string | null;
  age_group?: string | null;
  favorite_colors?: string[] | string | null;
}

/** Actual products in a recommended outfit; purchasable variants still require inventory validation. */
export interface OutfitCombo {
  name: string;
  reason?: string;
  description?: string;
  sale_price?: number;
  base_price?: number;
  images?: string[];
  products: ProductSummary[];
}

/** One server-generated category of recommendations. */
export interface RecommendationCategory {
  category_id: string;
  category_name: string;
  products: ProductSummary[];
}

/** Recommendations and the single effective Style Profile returned by the existing API. */
export interface StyleProfileRecommendations {
  success?: boolean;
  quiz?: StyleQuizRecord | null;
  combos?: OutfitCombo[];
  categories?: RecommendationCategory[];
  source?: string;
}
