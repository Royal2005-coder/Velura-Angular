/** Một chiến dịch khuyến mãi đang chạy, hiển thị trên trang Ưu đãi. */
export interface OfferCampaign {
  promo_id: string;
  title: string;
  description: string | null;
  type: string;
  banner_image_url: string | null;
  highlight_label: string | null;
  is_featured: boolean;
  start_date: string | null;
  end_date: string | null;
  days_left: number | null;
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

/** Lời mời bổ sung ngày sinh để nhận ưu đãi sinh nhật. */
export interface BirthdayPrompt {
  title: string;
  description: string;
  action_label: string;
  action_route: string;
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
