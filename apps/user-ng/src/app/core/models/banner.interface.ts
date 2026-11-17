export type BannerPlacement = 'products_hero';
export type BannerMediaType = 'image' | 'video';

export interface BannerSummary {
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
  metadata?: {
    autoplay?: boolean;
    sound_default?: boolean;
    [key: string]: unknown;
  };
}
