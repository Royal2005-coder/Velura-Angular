import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';
import type {
  BirthdayPrompt,
  OfferCampaign,
  OfferVoucher,
  OfferVoucherGroup,
  OffersResponse
} from '../../core/models/offer.interface';

/** Thứ tự và tiêu đề ba nhóm mã trên trang Ưu đãi (USR-MISC-06). */
const VOUCHER_GROUPS: ReadonlyArray<{ key: OfferVoucherGroup; title: string }> = [
  { key: 'personal', title: 'Dành riêng cho bạn' },
  { key: 'running', title: 'Đang diễn ra' },
  { key: 'ending', title: 'Sắp hết hạn' }
];

/**
 * Trang Ưu đãi — chạy bằng dữ liệu thật từ bảng chiến dịch và mã giảm giá.
 *
 * Bản trước đọc một mảng banner viết cứng trong mã nguồn, nên admin tạm dừng chiến
 * dịch thì khách vẫn thấy y nguyên. Trang này lấy từ `/api/user/offers`, mở cho cả
 * khách vãng lai vì ưu đãi là công cụ thu hút khách mới.
 *
 * `?offer=<promo_id>` mở thẳng vào một chiến dịch: trang chủ và thanh tin khuyến mãi
 * dẫn về đây. Nút "Dùng mã" dẫn sang `/cart?voucher=CODE`, ví ở giỏ áp sẵn mã đó. Đó
 * là cách "thu thập mã" mà không cần bảng lưu mã riêng cho từng khách: ví chấm điều
 * kiện trực tiếp nên mã nào khách dùng được là hiện ra.
 */
@Component({
  selector: 'app-offers-page',
  imports: [RouterLink],
  host: { style: 'display:block' },
  templateUrl: './offers.page.html'
})
export class OffersPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly campaigns = signal<OfferCampaign[]>([]);
  readonly featured = signal<OfferCampaign[]>([]);
  readonly vouchers = signal<OfferVoucher[]>([]);
  readonly isMember = signal(false);
  readonly birthdayPrompt = signal<BirthdayPrompt | null>(null);
  /** Chiến dịch đang mở qua `?offer=`. Giá trị lạ (ví dụ mã banner cũ A1) thì bỏ qua. */
  readonly focusedOffer = signal<string | null>(this.route.snapshot.queryParamMap.get('offer'));

  readonly focusedCampaign = computed(
    () => this.campaigns().find((campaign) => campaign.promo_id === this.focusedOffer()) ?? null
  );
  /** Mã của chiến dịch đang mở, hiện riêng ở đầu ví để khách không phải dò. */
  readonly focusedVouchers = computed(() => {
    const campaign = this.focusedCampaign();
    return campaign ? this.vouchers().filter((voucher) => voucher.promo_id === campaign.promo_id) : [];
  });
  readonly voucherGroups = computed(() =>
    VOUCHER_GROUPS.map((group) => ({
      ...group,
      items: this.vouchers().filter((voucher) => (voucher.group ?? 'running') === group.key)
    })).filter((group) => group.items.length > 0)
  );

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
        this.scrollToFocused();
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.loadError.set(error.message || 'Không tải được danh sách ưu đãi.');
      }
    });
  }

  /** Mở một chiến dịch ngay trên trang, không tải lại. */
  focus(campaign: OfferCampaign): void {
    this.focusedOffer.set(campaign.promo_id);
    this.scrollToFocused();
  }

  /** Số mã của một chiến dịch, cho nút "Xem N mã". */
  voucherCount(campaign: OfferCampaign): number {
    return this.vouchers().filter((voucher) => voucher.promo_id === campaign.promo_id).length;
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

  private scrollToFocused(): void {
    if (!this.focusedCampaign()) return;
    // Chờ lượt vẽ kế tiếp để khối mã của chiến dịch đã có trong DOM.
    setTimeout(() => document.getElementById('offer-focused')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}
