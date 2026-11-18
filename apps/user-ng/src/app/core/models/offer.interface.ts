/** Một chiến dịch khuyến mãi đang chạy, hiển thị trên trang Ưu đãi. */
export interface OfferCampaign {
  promo_id: string;
  title: string;
  description: string | null;
  type: string;
  banner_image_url: string | null;
  media_type?: 'image' | 'video';
  display_order?: number;
  highlight_label: string | null;
  is_featured: boolean;
  start_date: string | null;
  end_date: string | null;
  days_left: number | null;
}

/** Kết quả chuẩn hóa đường dẫn và khung cắt ảnh/video (`#focal=x,y,zoom`) cho banner chiến dịch. */
export interface CampaignBannerFraming {
  cleanUrl: string | null;
  mediaType: 'image' | 'video';
  objectPosition: string;
  transformOrigin: string;
  transform: string | null;
}

/**
 * Tách tọa độ căn khung `#focal=x,y,zoom` do Admin ERP lưu trên `banner_image_url`
 * và nhận diện loại media (`image` / `video`) để hiển thị đồng bộ 1:1 trên trang `/offers`.
 */
export function parseCampaignBannerFraming(
  rawUrl: string | null | undefined,
  explicitType?: 'image' | 'video',
): CampaignBannerFraming {
  if (!rawUrl || !rawUrl.trim()) {
    return {
      cleanUrl: null,
      mediaType: explicitType ?? 'image',
      objectPosition: '50% 32%',
      transformOrigin: '50% 32%',
      transform: null,
    };
  }
  const [beforeHash, hash = ''] = rawUrl.trim().split('#');
  const cleanUrl = beforeHash || null;
  const pathOnly = (cleanUrl ?? '').split('?')[0]?.toLowerCase() ?? '';
  const inferredVideo = pathOnly.endsWith('.mp4') || pathOnly.endsWith('.webm');
  const mediaType: 'image' | 'video' = explicitType ?? (inferredVideo ? 'video' : 'image');

  let x = 50;
  let y = 32;
  let zoom = 1;
  const focalMatch = /(?:^|&)focal=([0-9.]+),([0-9.]+)(?:,([0-9.]+))?/i.exec(hash);
  if (focalMatch) {
    const clamp = (val: string | undefined, fallback: number, min: number, max: number): number => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 100) / 100 : fallback;
    };
    x = clamp(focalMatch[1], 50, 0, 100);
    y = clamp(focalMatch[2], 32, 0, 100);
    zoom = clamp(focalMatch[3], 1, 1, 2.4);
  }
  const pos = `${x}% ${y}%`;
  return {
    cleanUrl,
    mediaType,
    objectPosition: pos,
    transformOrigin: pos,
    transform: zoom > 1.001 ? `scale(${zoom})` : null,
  };
}

/** Một mã giảm giá hiển thị ở ví trên trang Ưu đãi. */
export interface OfferVoucher {
  voucher_id: string;
  promo_id: string | null;
  code: string;
  name: string;
  description: string;
  discount_type: string;
  min_order_value: number;
  end_date: string | null;
  remaining_uses: number | null;
  usable: boolean;
  blocked_reason: string | null;
  condition_text: string;
  /** Tên danh mục mã áp dụng. Rỗng là áp cho cả giỏ. */
  category_names?: string[];
  /** Nhóm hiển thị do máy chủ xếp: dành riêng, đang diễn ra, sắp hết hạn. */
  group?: OfferVoucherGroup;
}

export type OfferVoucherGroup = 'personal' | 'running' | 'ending';

/** Lời mời hoặc thông điệp đặc quyền ưu đãi sinh nhật. */
export interface BirthdayPrompt {
  title: string;
  description: string;
  action_label: string;
  action_route: string;
  is_birthday_month?: boolean;
  voucher_code?: string;
}

/** Phản hồi của `GET /api/user/offers`. */
export interface OffersResponse {
  success: boolean;
  generated_at: string;
  is_member: boolean;
  featured: OfferCampaign[];
  campaigns: OfferCampaign[];
  vouchers: OfferVoucher[];
  birthday_prompt: BirthdayPrompt | null;
}
