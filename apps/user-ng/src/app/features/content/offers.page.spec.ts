import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ApiService } from '../../core/services/api.service';
import type { OfferVoucher, OffersResponse } from '../../core/models/offer.interface';
import { OffersPage } from './offers.page';

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

async function createPage(offer: string | null): Promise<OffersPage> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [OffersPage],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: { get: () => of(RESPONSE) } },
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
  });

  it('?offer= mang mã banner cũ (A1) thì bỏ qua, không vỡ trang', async () => {
    const page = await createPage('A1');
    expect(page.focusedCampaign()).toBeNull();
    expect(page.voucherGroups().length).toBe(3);
  });
});
