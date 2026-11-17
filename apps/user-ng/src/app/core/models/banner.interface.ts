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
    focal_x?: number;
    focal_y?: number;
    focal_zoom?: number;
    [key: string]: unknown;
  };
}

/**
 * Chuẩn hóa khung căn chỉnh (`object-position`, `transform-origin`, `transform`) cho banner đầu trang `/products`
 * khớp 1:1 với bộ kéo/cắt ảnh trong Admin ERP. Mặc định `50% 28%` ưu tiên nửa trên khung hình thời trang.
 */
export function bannerMediaFraming(
  banner: Pick<BannerSummary, 'metadata'> | null | undefined,
): { objectPosition: string; transformOrigin: string; transform: string | null } {
  const meta = banner?.metadata ?? {};
  const clamp = (val: unknown, fallback: number, min: number, max: number): number =>
    typeof val === 'number' && Number.isFinite(val) ? Math.round(Math.min(max, Math.max(min, val)) * 100) / 100 : fallback;
  const x = clamp(meta.focal_x, 50, 0, 100);
  const y = clamp(meta.focal_y, 28, 0, 100);
  const zoom = clamp(meta.focal_zoom, 1, 1, 2.4);
  const pos = `${x}% ${y}%`;
  return {
    objectPosition: pos,
    transformOrigin: pos,
    transform: zoom > 1.001 ? `scale(${zoom})` : null,
  };
}
