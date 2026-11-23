import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { useBodyClass } from '../../core/utils/body-class';
import { showToast } from '../../core/utils/toast';
import {
  parseCampaignBannerFraming,
  type BirthdayPrompt,
  type CampaignBannerFraming,
  type OfferCampaign,
  type OfferVoucher,
  type OfferVoucherGroup,
  type OffersResponse,
} from '../../core/models/offer.interface';

/** Thứ tự và tiêu đề ba nhóm mã trên trang Ưu đãi (USR-MISC-06). */
const VOUCHER_GROUPS: ReadonlyArray<{ key: OfferVoucherGroup; title: string }> = [
  { key: 'personal', title: 'Dành riêng cho bạn' },
  { key: 'running', title: 'Đang diễn ra' },
  { key: 'ending', title: 'Sắp hết hạn' },
];

/** Chu kỳ tự động trượt banner chiến dịch (5 giây chuẩn UX). */
export const CAMPAIGN_AUTO_SLIDE_MS = 5000;

/** Thời gian hiệu ứng lướt track vô cực trước khi khớp slide clone ngầm. */
const INFINITE_SNAP_MS = 640;

/** Một phần tử trên track trượt vô cực (gồm cả bản nhân đôi đầu/cuối khi có >= 2 chiến dịch). */
export interface RenderedCampaignSlide {
  readonly key: string;
  readonly campaign: OfferCampaign;
  readonly realIndex: number;
  readonly isClone: boolean;
}

/** Nhãn cuống vé bên trái thẻ voucher. */
export interface VoucherStubInfo {
  readonly headline: string;
  readonly caption: string;
  readonly kind: 'percent' | 'freeship' | 'amount';
}

/**
 * Trang Ưu đãi — hiển thị chiến dịch khuyến mãi dạng Banner bo tròn tự động trượt vô cực mỗi 5s
 * kết hợp Ví Voucher dạng cuống vé đục lỗ ngay bên dưới, đồng bộ trực tiếp với `/api/user/offers`.
 */
@Component({
  selector: 'app-offers-page',
  imports: [RouterLink],
  templateUrl: './offers.page.html',
})
export class OffersPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private request?: Subscription;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private autoSlideTimer: ReturnType<typeof setInterval> | null = null;
  private cloneSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerStartX: number | null = null;
  private pointerStartY: number | null = null;
  private pendingSnapTarget: number | null = null;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly campaigns = signal<OfferCampaign[]>([]);
  readonly featured = signal<OfferCampaign[]>([]);
  readonly vouchers = signal<OfferVoucher[]>([]);
  readonly isMember = signal(false);
  readonly birthdayPrompt = signal<BirthdayPrompt | null>(null);
  /** Chiến dịch đang mở qua `?offer=` hoặc khách bấm xem mã trên banner. */
  readonly focusedOffer = signal<string | null>(this.route.snapshot.queryParamMap.get('offer'));
  readonly failedImages = signal<Record<string, boolean>>({});

  /** Chỉ số chiến dịch thực đang hiển thị trên banner (`0 .. N-1`). */
  readonly activeSlideIndex = signal(0);
  /** Vị trí thực tế trên track vô cực (`1 .. N`, với `0` và `N+1` là 2 slide nối biên). */
  readonly trackPosition = signal(0);
  /** Bật tạm thời trong 1 frame khi khớp biên vô cực để không phát sinh chuyển động giật ngược. */
  readonly trackInstant = signal(false);
  /** Tạm dừng khi rê chuột / focus bàn phím vào vùng banner. */
  readonly hoverPaused = signal(false);
  /** Tạm dừng chủ động do người dùng bấm nút Tạm dừng/Tiếp tục. */
  readonly manualPaused = signal(false);
  /** Bộ đếm nhịp để khởi động lại thanh tiến trình 5s mỗi khi đổi slide. */
  readonly slideTick = signal(0);

  /** Bộ lọc nhanh tại Ví Voucher bên dưới (`all` hoặc chỉ mã `usable`). */
  readonly walletFilter = signal<'all' | 'usable'>('all');
  /** Mã voucher vừa được sao chép 1 chạm. */
  readonly copiedCode = signal<string | null>(null);

  /** Có từ 2 chiến dịch trở lên thì bật chế độ nhân bản hai đầu để trượt vô cực một chiều. */
  readonly hasInfiniteLoop = computed(() => this.campaigns().length > 1);

  /** Danh sách phần tử trên track trượt (thêm bản sao cuối ở đầu và bản sao đầu ở cuối khi `N > 1`). */
  readonly renderedSlides = computed<readonly RenderedCampaignSlide[]>(() => {
    const list = this.campaigns();
    if (list.length === 0) return [];
    if (list.length === 1) {
      return [{ key: list[0].promo_id, campaign: list[0], realIndex: 0, isClone: false }];
    }
    const first = list[0];
    const last = list[list.length - 1];
    return [
      { key: `clone-prev-${last.promo_id}`, campaign: last, realIndex: list.length - 1, isClone: true },
      ...list.map((campaign, idx) => ({ key: campaign.promo_id, campaign, realIndex: idx, isClone: false })),
      { key: `clone-next-${first.promo_id}`, campaign: first, realIndex: 0, isClone: true },
    ];
  });

  /** Chiến dịch đang hiển thị ở khung hình chính của carousel. */
  readonly activeCampaign = computed<OfferCampaign | null>(() => {
    const list = this.campaigns();
    if (!list.length) return null;
    const idx = Math.min(Math.max(0, this.activeSlideIndex()), list.length - 1);
    return list[idx] ?? list[0] ?? null;
  });

  readonly isCarouselPaused = computed(() => this.hoverPaused() || this.manualPaused() || this.prefersReducedMotion());

  readonly focusedCampaign = computed(
    () => this.campaigns().find((campaign) => campaign.promo_id === this.focusedOffer()) ?? null,
  );

  /** Mã của chiến dịch đang mở, hiện riêng ở đầu ví để khách không phải dò. */
  readonly focusedVouchers = computed(() => {
    const campaign = this.focusedCampaign();
    return campaign ? this.vouchers().filter((voucher) => voucher.promo_id === campaign.promo_id) : [];
  });

  /** Ba nhóm mã gốc (giữ nguyên hợp đồng cho mọi kiểm thử và hiển thị chuẩn). */
  readonly voucherGroups = computed(() =>
    VOUCHER_GROUPS.map((group) => ({
      ...group,
      items: this.vouchers().filter(
        (voucher) =>
          (voucher.group ?? 'running') === group.key &&
          !this.focusedVouchers().some((focused) => focused.voucher_id === voucher.voucher_id),
      ),
    })).filter((group) => group.items.length > 0),
  );

  /** Nhóm mã áp dụng thêm bộ lọc nhanh `Tất cả` / `Dùng được ngay` trên giao diện ví. */
  readonly visibleVoucherGroups = computed(() => {
    const mode = this.walletFilter();
    const groups = this.voucherGroups();
    if (mode === 'all') return groups;
    return groups
      .map((group) => ({ ...group, items: group.items.filter((v) => v.usable) }))
      .filter((group) => group.items.length > 0);
  });

  readonly usableVoucherCount = computed(() => this.vouchers().filter((v) => v.usable).length);

  constructor() {
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.scrollTimer);
      this.stopAutoSlide();
      this.clearCloneSnap();
      if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
    });
    useBodyClass('page-offers');
    effect(() => {
      this.auth.session();
      untracked(() => {
        this.vouchers.set([]);
        this.birthdayPrompt.set(null);
        this.isMember.set(false);
        this.load();
      });
    });
  }

  /** Tải danh sách chiến dịch và mã đang chạy từ `/api/user/offers`. */
  load(): void {
    this.request?.unsubscribe();
    this.stopAutoSlide();
    this.clearCloneSnap();
    this.loading.set(true);
    this.loadError.set(null);
    const session = this.auth.session();
    this.request = this.api
      .get<OffersResponse>('/api/user/offers')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (session !== this.auth.session()) return;
          this.loading.set(false);
          this.failedImages.set({});
          const loadedCampaigns = response.campaigns ?? [];
          this.campaigns.set(loadedCampaigns);
          this.featured.set(response.featured ?? []);
          this.vouchers.set(response.vouchers ?? []);
          this.isMember.set(Boolean(response.is_member));
          this.birthdayPrompt.set(response.birthday_prompt ?? null);
          this.initializeCarouselPosition(loadedCampaigns);
          this.syncAutoSlide();
          this.scrollToFocused();
        },
        error: (error: Error) => {
          if (session !== this.auth.session()) return;
          this.loading.set(false);
          this.loadError.set(error.message || 'Không tải được danh sách ưu đãi.');
        },
      });
  }

  /** Chuyển sang banner chiến dịch kế tiếp theo chiều tiến vô cực. */
  nextSlide(): void {
    const total = this.campaigns().length;
    if (total <= 1) return;
    this.flushPendingCloneSnap();
    const reduced = this.prefersReducedMotion();
    const nextLogical = (this.activeSlideIndex() + 1) % total;
    this.activeSlideIndex.set(nextLogical);
    this.slideTick.update((v) => v + 1);

    if (reduced) {
      this.trackInstant.set(true);
      this.trackPosition.set(nextLogical + 1);
      this.syncAutoSlide();
      return;
    }

    this.trackInstant.set(false);
    const nextTrack = this.trackPosition() + 1;
    this.trackPosition.set(nextTrack);
    if (nextTrack === total + 1) {
      this.scheduleCloneSnap(1);
    }
    this.syncAutoSlide();
  }

  /** Lùi về banner chiến dịch trước đó theo chiều lùi vô cực. */
  prevSlide(): void {
    const total = this.campaigns().length;
    if (total <= 1) return;
    this.flushPendingCloneSnap();
    const reduced = this.prefersReducedMotion();
    const prevLogical = (this.activeSlideIndex() - 1 + total) % total;
    this.activeSlideIndex.set(prevLogical);
    this.slideTick.update((v) => v + 1);

    if (reduced) {
      this.trackInstant.set(true);
      this.trackPosition.set(prevLogical + 1);
      this.syncAutoSlide();
      return;
    }

    this.trackInstant.set(false);
    const prevTrack = this.trackPosition() - 1;
    this.trackPosition.set(prevTrack);
    if (prevTrack === 0) {
      this.scheduleCloneSnap(total);
    }
    this.syncAutoSlide();
  }

  /** Nhảy trực tiếp tới một chiến dịch theo chỉ số từ thanh chấm tiến trình hoặc dải chọn nhanh. */
  goToSlide(index: number): void {
    const total = this.campaigns().length;
    if (index < 0 || index >= total) return;
    this.flushPendingCloneSnap();
    this.clearCloneSnap();
    this.trackInstant.set(this.prefersReducedMotion());
    this.activeSlideIndex.set(index);
    this.trackPosition.set(total > 1 ? index + 1 : 0);
    this.slideTick.update((v) => v + 1);
    this.syncAutoSlide();
  }

  /** Hoàn tất bước khớp biên vô cực ngay khi CSS `transform` kết thúc. */
  onTrackTransitionEnd(event: TransitionEvent): void {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    this.flushPendingCloneSnap();
  }

  /** Tạm dừng đếm tự động khi người dùng di chuột hoặc focus vào banner. */
  onCarouselPause(paused: boolean): void {
    this.hoverPaused.set(paused);
    this.syncAutoSlide();
  }

  /** Bật/tắt tạm dừng thủ công cho người dùng muốn đọc kỹ thông tin chiến dịch. */
  toggleManualPause(): void {
    this.manualPaused.update((v) => !v);
    this.syncAutoSlide();
  }

  /** Hỗ trợ phím mũi tên trái/phải ngay trên vùng banner chiến dịch. */
  onCarouselKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.nextSlide();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.prevSlide();
    }
  }

  /** Bắt đầu cử chỉ vuốt ngang trên cảm ứng hoặc chuột. */
  onStagePointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
  }

  /** Nhận diện thao tác vuốt trái/phải để chuyển banner mượt trên di động. */
  onStagePointerUp(event: PointerEvent): void {
    if (this.pointerStartX === null || this.pointerStartY === null) return;
    const dx = event.clientX - this.pointerStartX;
    const dy = event.clientY - this.pointerStartY;
    this.pointerStartX = null;
    this.pointerStartY = null;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) this.nextSlide();
      else this.prevSlide();
    }
  }

  /** Ghim và cuộn xuống danh sách mã giảm giá thuộc chiến dịch khách chọn. */
  focus(campaign: OfferCampaign): void {
    const idx = this.campaigns().findIndex((c) => c.promo_id === campaign.promo_id);
    if (idx >= 0 && idx !== this.activeSlideIndex()) {
      this.goToSlide(idx);
    }
    this.focusedOffer.set(campaign.promo_id);
    this.scrollToFocused();
  }

  /** Bỏ ghim lọc chiến dịch để xem lại toàn bộ ví voucher chung. */
  clearFocusedCampaign(): void {
    this.focusedOffer.set(null);
  }

  /** Thay đổi bộ lọc nhanh của Ví Voucher (`all` / `usable`). */
  setWalletFilter(mode: 'all' | 'usable'): void {
    this.walletFilter.set(mode);
  }

  /** Sao chép nhanh mã giảm giá vào bộ nhớ tạm và hiển thị phản hồi tức thì. */
  copyVoucherCode(code: string, event?: Event): void {
    event?.stopPropagation();
    const normalized = code.trim();
    if (!normalized) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(normalized).catch(() => undefined);
    }
    this.copiedCode.set(normalized);
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
    this.copyResetTimer = setTimeout(() => this.copiedCode.set(null), 2200);
    showToast(`Đã sao chép mã ${normalized}.`);
  }

  /** Đánh dấu ảnh banner lỗi để hiển thị khung typography thay thế sang trọng. */
  onImageError(promoId: string): void {
    this.failedImages.update((prev) => ({ ...prev, [promoId]: true }));
  }

  /** Chuẩn hóa khung cắt và loại media (`image` / `video`) của một chiến dịch. */
  bannerFraming(campaign: OfferCampaign): CampaignBannerFraming {
    return parseCampaignBannerFraming(campaign.banner_image_url, campaign.media_type);
  }

  /** Giữ nguyên tiêu đề chiến dịch do quản trị viên nhập. */
  cleanTitle(title: string | undefined): string {
    return title?.trim() || 'Ưu đãi Velura';
  }

  /** Nhãn loại chiến dịch khi quản trị viên không đặt `highlight_label` riêng. */
  campaignTypeLabel(type: string | undefined): string {
    const labels: Record<string, string> = {
      flash_sale: 'Flash Sale giới hạn',
      seasonal_sale: 'Bộ sưu tập theo mùa',
      combo_discount: 'Đặc quyền phối set',
      bulk_discount: 'Ưu đãi mua kèm',
      product_discount: 'Ưu đãi thiết kế chọn lọc',
    };
    return labels[type ?? ''] || 'Chiến dịch ưu đãi';
  }

  /** Dòng mô tả bổ trợ trung thực từ dữ liệu thật khi chiến dịch không nhập mô tả dài. */
  campaignFallbackDescription(campaign: OfferCampaign): string {
    const count = this.voucherCount(campaign);
    if (count > 0) {
      return `Chương trình gồm ${count} mã giảm giá đang mở trong Ví Voucher bên dưới để áp dụng trực tiếp khi thanh toán.`;
    }
    if (campaign.end_date) {
      return `Áp dụng cho các thiết kế tuyển chọn tại cửa hàng trực tuyến Velura đến hết ngày ${this.expiryLabel(campaign.end_date)}.`;
    }
    return 'Áp dụng trực tiếp trên danh mục thiết kế Velura trong thời gian diễn ra chiến dịch.';
  }

  /** Tối đa 2 voucher tiêu biểu thuộc chiến dịch để hiển thị chip xem nhanh ngay trên banner. */
  campaignVoucherPreview(campaign: OfferCampaign): OfferVoucher[] {
    return this.vouchers()
      .filter((voucher) => voucher.promo_id === campaign.promo_id)
      .slice(0, 2);
  }

  /** Định dạng số thứ tự slide `01`, `02`... */
  slideNumber(index: number): string {
    return String(index + 1).padStart(2, '0');
  }

  /** Bóc tách nhãn mức giảm nổi bật cho phần cuống vé bên trái mỗi thẻ voucher. */
  voucherStub(voucher: OfferVoucher): VoucherStubInfo {
    if (voucher.discount_type === 'free_shipping') {
      return { headline: 'FREESHIP', caption: 'Vận chuyển', kind: 'freeship' };
    }
    if (voucher.discount_type === 'percentage') {
      const pctMatch = /(\d+(?:[.,]\d+)?)\s*%/.exec(voucher.description || voucher.name);
      return {
        headline: pctMatch ? `${pctMatch[1]}%` : 'ƯU ĐÃI',
        caption: 'Giảm giá',
        kind: 'percent',
      };
    }
    const numMatch = /(\d[\d.]*)\s*đ/i.exec(voucher.description || voucher.name);
    if (numMatch) {
      const raw = Number(numMatch[1].replace(/\./g, ''));
      if (Number.isFinite(raw) && raw >= 1000) {
        const compact = raw >= 1_000_000 ? `${Math.round((raw / 1_000_000) * 10) / 10}TR` : `${Math.round(raw / 1000)}K`;
        return { headline: compact, caption: 'Trừ thẳng', kind: 'amount' };
      }
    }
    return { headline: 'VOUCHER', caption: 'Ưu đãi', kind: 'amount' };
  }

  /** Gợi ý hành động mở khóa hợp ngữ cảnh cho các mã đang tạm khóa (ví dụ thiếu ngày sinh). */
  lockedVoucherAction(voucher: OfferVoucher): { label: string; route: string } | null {
    if (voucher.usable) return null;
    const reason = (voucher.blocked_reason || '').toLowerCase();
    if (reason.includes('ngày sinh') || reason.includes('hồ sơ')) {
      return { label: 'Cập nhật hồ sơ', route: '/account/profile' };
    }
    if (!this.isMember() && (reason.includes('thành viên') || reason.includes('đăng nhập'))) {
      return { label: 'Đăng nhập nhận mã', route: '/auth/signin' };
    }
    return null;
  }

  useVoucherParams(voucher: OfferVoucher): Record<string, string> {
    const params: Record<string, string> = { voucher: voucher.code };
    const categorySlug = this.getCategorySlugForVoucher(voucher);
    if (categorySlug) {
      params['category'] = categorySlug;
    }
    return params;
  }

  onUseVoucher(voucher: OfferVoucher): void {
    sessionStorage.setItem('checkout_voucher_code', voucher.code);
    if (voucher.voucher_id) {
      sessionStorage.setItem('checkout_voucher_id', voucher.voucher_id);
    }
    sessionStorage.removeItem('checkout_voucher_declined');
    showToast(`Đã lưu mã ${voucher.code}! Hãy chọn sản phẩm thỏa điều kiện để áp dụng mã.`);
  }

  /** Số mã của một chiến dịch, cho nút "Nhận N mã ưu đãi". */
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

  private initializeCarouselPosition(list: readonly OfferCampaign[]): void {
    if (!list.length) {
      this.activeSlideIndex.set(0);
      this.trackPosition.set(0);
      this.trackInstant.set(true);
      return;
    }
    const focusedId = this.focusedOffer();
    const matchedIdx = focusedId ? list.findIndex((c) => c.promo_id === focusedId) : -1;
    const initialIdx = matchedIdx >= 0 ? matchedIdx : 0;
    this.trackInstant.set(true);
    this.activeSlideIndex.set(initialIdx);
    this.trackPosition.set(list.length > 1 ? initialIdx + 1 : 0);
    this.slideTick.update((v) => v + 1);
  }

  private scheduleCloneSnap(realTrackPos: number): void {
    this.clearCloneSnap();
    this.pendingSnapTarget = realTrackPos;
    this.cloneSnapTimer = setTimeout(() => {
      this.flushPendingCloneSnap();
    }, INFINITE_SNAP_MS);
  }

  private flushPendingCloneSnap(): void {
    if (this.pendingSnapTarget === null) return;
    const target = this.pendingSnapTarget;
    this.pendingSnapTarget = null;
    this.clearCloneSnap();
    this.trackInstant.set(true);
    this.trackPosition.set(target);
  }

  private clearCloneSnap(): void {
    if (this.cloneSnapTimer !== null) {
      clearTimeout(this.cloneSnapTimer);
      this.cloneSnapTimer = null;
    }
  }

  private syncAutoSlide(): void {
    this.stopAutoSlide();
    if (this.campaigns().length <= 1 || this.isCarouselPaused()) {
      return;
    }
    this.autoSlideTimer = setInterval(() => {
      this.nextSlide();
    }, CAMPAIGN_AUTO_SLIDE_MS);
  }

  private stopAutoSlide(): void {
    if (this.autoSlideTimer !== null) {
      clearInterval(this.autoSlideTimer);
      this.autoSlideTimer = null;
    }
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  private getCategorySlugForVoucher(voucher: OfferVoucher): string | null {
    if (!voucher.category_names || !voucher.category_names.length) {
      return null;
    }
    const map: Record<string, string> = {
      áo: 'ao',
      ao: 'ao',
      quần: 'quan',
      quan: 'quan',
      'đầm & váy': 'dam-vay',
      đầm: 'dam-vay',
      váy: 'dam-vay',
      dam: 'dam-vay',
      vay: 'dam-vay',
      'áo khoác': 'ao-khoac',
      'ao khoac': 'ao-khoac',
      'set đồ': 'set-do',
      'set do': 'set-do',
      'phụ kiện': 'phu-kien',
      'phu kien': 'phu-kien',
      'giày dép': 'giay-dep',
      'giay dep': 'giay-dep',
    };
    const first = voucher.category_names[0].trim().toLowerCase();
    return map[first] || null;
  }

  private scrollToFocused(): void {
    if (!this.focusedCampaign()) return;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() =>
      document.getElementById('offer-focused')?.scrollIntoView({
        behavior: this.prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      }),
    );
  }
}
