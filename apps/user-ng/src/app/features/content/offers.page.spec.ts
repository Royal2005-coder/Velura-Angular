import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ApiService } from '../../core/services/api.service';
import { parseCampaignBannerFraming, type OfferCampaign, type OfferVoucher, type OffersResponse } from '../../core/models/offer.interface';
import { CAMPAIGN_AUTO_SLIDE_MS, OffersPage } from './offers.page';

function voucher(overrides: Partial<OfferVoucher>): OfferVoucher {
  return {
    voucher_id: 'v',
    promo_id: null,
    code: 'X',
    name: 'X',
    description: 'Giảm 10%',
    discount_type: 'percentage',
    min_order_value: 0,
    end_date: null,
    remaining_uses: null,
    usable: true,
    blocked_reason: null,
    condition_text: 'Không yêu cầu giá trị tối thiểu',
    group: 'running',
    ...overrides,
  };
}

const RESPONSE: OffersResponse = {
  success: true,
  generated_at: '2026-10-10T00:00:00Z',
  is_member: true,
  featured: [],
  campaigns: [
    {
      promo_id: 'p1',
      title: 'Sale 10.10',
      description: null,
      type: 'flash_sale',
      banner_image_url: null,
      highlight_label: null,
      is_featured: false,
      start_date: null,
      end_date: null,
      days_left: 3,
    },
  ],
  vouchers: [
    voucher({ voucher_id: 'v1', code: 'VIP', group: 'personal' }),
    voucher({ voucher_id: 'v2', code: 'SALE10', promo_id: 'p1', group: 'running' }),
    voucher({ voucher_id: 'v3', code: 'CUOITUAN', group: 'ending' }),
  ],
  birthday_prompt: null,
};

async function createPage(offer: string | null, customResponse: OffersResponse = RESPONSE): Promise<OffersPage> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [OffersPage],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: { get: () => of(customResponse) } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(offer ? { offer } : {}) } },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(OffersPage);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('OffersPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(OffersPage);
    expect(page).toBeTruthy();
  });

  it('xếp mã thành Dành riêng cho bạn, Đang diễn ra, Sắp hết hạn', async () => {
    const page = await createPage(null);
    expect(page.voucherGroups().map((group) => [group.title, group.items.map((item) => item.code)])).toEqual([
      ['Dành riêng cho bạn', ['VIP']],
      ['Đang diễn ra', ['SALE10']],
      ['Sắp hết hạn', ['CUOITUAN']],
    ]);
  });

  it('?offer= mở thẳng vào chiến dịch và hiện riêng mã của chiến dịch đó', async () => {
    const page = await createPage('p1');
    expect(page.focusedCampaign()?.title).toBe('Sale 10.10');
    expect(page.focusedVouchers().map((item) => item.code)).toEqual(['SALE10']);
    expect(page.voucherGroups().flatMap((group) => group.items.map((item) => item.code))).not.toContain('SALE10');
  });

  it('preserves the campaign title entered by the administrator', async () => {
    const page = await createPage(null);
    expect(page.cleanTitle('Summer test collection')).toBe('Summer test collection');
  });

  it('?offer= mang mã banner cũ (A1) thì bỏ qua, không vỡ trang', async () => {
    const page = await createPage('A1');
    expect(page.focusedCampaign()).toBeNull();
    expect(page.voucherGroups().length).toBe(3);
  });

  it('navigates to products page with voucher and category params when using a voucher', async () => {
    const page = await createPage(null);
    const testVoucher: OfferVoucher = voucher({
      code: 'FALL10',
      voucher_id: 'v-fall10',
      category_names: ['Áo'],
    });

    const params = page.useVoucherParams(testVoucher);
    expect(params['voucher']).toBe('FALL10');
    expect(params['category']).toBe('ao');

    page.onUseVoucher(testVoucher);
    expect(sessionStorage.getItem('checkout_voucher_code')).toBe('FALL10');
    expect(sessionStorage.getItem('checkout_voucher_id')).toBe('v-fall10');
  });

  it('auto-slides campaigns every 5s in a seamless infinite loop and pauses on hover', async () => {
    vi.useFakeTimers();
    try {
      const multiCampaigns: OfferCampaign[] = [
        { ...RESPONSE.campaigns[0], promo_id: 'c1', title: 'Chiến dịch 1' },
        { ...RESPONSE.campaigns[0], promo_id: 'c2', title: 'Chiến dịch 2' },
        { ...RESPONSE.campaigns[0], promo_id: 'c3', title: 'Chiến dịch 3' },
      ];
      const page = await createPage(null, { ...RESPONSE, campaigns: multiCampaigns });

      // Cloned head & tail slides enable continuous unidirectional infinite wrap.
      expect(page.renderedSlides().length).toBe(5);
      expect(page.activeSlideIndex()).toBe(0);
      expect(page.trackPosition()).toBe(1);

      vi.advanceTimersByTime(CAMPAIGN_AUTO_SLIDE_MS);
      expect(page.activeSlideIndex()).toBe(1);
      expect(page.trackPosition()).toBe(2);

      vi.advanceTimersByTime(CAMPAIGN_AUTO_SLIDE_MS);
      expect(page.activeSlideIndex()).toBe(2);
      expect(page.trackPosition()).toBe(3);

      // Wrapping from last slide -> first slide moves forward to clone index 4, then snaps silently to 1.
      vi.advanceTimersByTime(CAMPAIGN_AUTO_SLIDE_MS);
      expect(page.activeSlideIndex()).toBe(0);
      expect(page.trackPosition()).toBe(4);
      vi.advanceTimersByTime(700);
      expect(page.trackPosition()).toBe(1);

      // Hovering pauses the 5s auto-advance timer.
      page.onCarouselPause(true);
      vi.advanceTimersByTime(CAMPAIGN_AUTO_SLIDE_MS * 2);
      expect(page.activeSlideIndex()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses #focal framing, filters usable vouchers, and copies voucher codes', async () => {
    const framing = parseCampaignBannerFraming('https://cdn.velura.vn/promo.mp4#focal=42,26,1.25');
    expect(framing).toEqual({
      cleanUrl: 'https://cdn.velura.vn/promo.mp4',
      mediaType: 'video',
      objectPosition: '42% 26%',
      transformOrigin: '42% 26%',
      transform: 'scale(1.25)',
    });

    const page = await createPage(null, {
      ...RESPONSE,
      vouchers: [
        voucher({ voucher_id: 'v-ok', code: 'VELURA20', description: 'Giảm 20%', usable: true, group: 'running' }),
        voucher({
          voucher_id: 'v-locked',
          code: 'HPBD2026',
          description: 'Giảm 150.000đ',
          discount_type: 'fixed_amount',
          usable: false,
          blocked_reason: 'Vui lòng cập nhật ngày sinh trong hồ sơ cá nhân.',
          group: 'personal',
        }),
      ],
    });

    expect(page.usableVoucherCount()).toBe(1);
    page.setWalletFilter('usable');
    expect(page.visibleVoucherGroups().flatMap((g) => g.items.map((i) => i.code))).toEqual(['VELURA20']);
    expect(page.voucherStub(RESPONSE.vouchers[0]).headline).toBe('10%');
    expect(page.lockedVoucherAction({ ...RESPONSE.vouchers[0], usable: false, blocked_reason: 'Thiếu ngày sinh' })?.route).toBe('/account/profile');

    page.copyVoucherCode('VELURA20');
    expect(page.copiedCode()).toBe('VELURA20');
  });
});
