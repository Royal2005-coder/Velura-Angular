import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';
import type {
  BirthdayPrompt,
  OfferCampaign,
  OfferVoucher,
  OffersResponse
} from '../../core/models/offer.interface';

/**
 * Trang Ưu đãi — chạy bằng dữ liệu thật từ bảng chiến dịch và mã giảm giá.
 *
 * Bản trước đọc một mảng banner viết cứng trong mã nguồn, nên admin tạm dừng chiến
 * dịch thì khách vẫn thấy y nguyên. Trang này lấy từ `/api/user/offers`, mở cho cả
 * khách vãng lai vì ưu đãi là công cụ thu hút khách mới.
 */
@Component({
  selector: 'app-offers-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './offers.page.html'
})
export class OffersPage {
  private readonly api = inject(ApiService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly campaigns = signal<OfferCampaign[]>([]);
  readonly featured = signal<OfferCampaign[]>([]);
  readonly vouchers = signal<OfferVoucher[]>([]);
  readonly isMember = signal(false);
  readonly birthdayPrompt = signal<BirthdayPrompt | null>(null);

  constructor() {
    useBodyClass('page-offers');
    this.load();
  }

  /**
   * Tải danh sách chiến dịch và mã đang chạy.
   */
  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.get<OffersResponse>('/api/user/offers').subscribe({
      next: (response) => {
        this.loading.set(false);
        this.campaigns.set(response.campaigns ?? []);
        this.featured.set(response.featured ?? []);
        this.vouchers.set(response.vouchers ?? []);
        this.isMember.set(Boolean(response.is_member));
        this.birthdayPrompt.set(response.birthday_prompt ?? null);
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.loadError.set(error.message || 'Không tải được danh sách ưu đãi.');
      }
    });
  }

  /** Định dạng tiền Việt cho template. */
  money(value: number | null | undefined): string {
    return `${Number(value ?? 0).toLocaleString('vi-VN')}đ`;
  }

  /** Nhãn ngày hết hạn. */
  expiryLabel(value: string | null): string {
    if (!value) return 'Không giới hạn';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('vi-VN');
  }

  /** Số thứ tự hiển thị kiểu A1, A2… giữ lại ngôn ngữ thị giác của bản thiết kế cũ. */
  campaignIndex(index: number): string {
    return `A${index + 1}`;
  }
}
