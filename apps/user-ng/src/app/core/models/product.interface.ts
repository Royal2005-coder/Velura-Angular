export interface ProductSummary {
  product_id: string;
  name: string;
  slug?: string;
  brand?: string;
  base_price?: number;
  sale_price?: number | null;
  is_featured?: boolean;
  is_combo?: boolean;
  sold_count?: number;
  status?: string;
  thumbnail_url?: string | null;
  images?: string[];
  rating_value?: number;
  rating_count?: number;
  category_slug?: string | null;
  category_name?: string | null;
  collection?: string | null;
  color_tone?: string;
  style_tags?: string[];
  occasions?: string[];
  suitable_body_shapes?: string[];
  sku?: string;
  created_at?: string | null;
  updated_at?: string | null;
  description?: string;
  variants?: ProductVariant[];
  combo_components?: ComboComponent[];
  reviews?: ProductReview[];
}

export interface ComboComponent {
  product_id: string;
  name: string;
  slug?: string;
  images?: string[];
  base_price?: number;
  sale_price?: number | null;
  category_name?: string;
  quantity?: number;
  variants?: ProductVariant[];
}

export interface ProductReview {
  rating?: number;
  comment?: string;
  user_full_name?: string;
  created_at?: string;
}

export interface ProductColorOption {
  name: string;
  hex: string;
}

export interface ProductVariant {
  variant_id: string;
  color?: string;
  color_hex?: string;
  size?: string;
  stock_quantity?: number;
  reserved_quantity?: number;
}

export interface CategorySummary {
  category_id: string;
  name: string;
  slug?: string;
  product_count?: number;
}
