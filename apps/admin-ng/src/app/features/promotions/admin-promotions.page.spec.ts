import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminApiService } from '../../core/admin-api.service';
import { createAdminPage } from '../../../testing/admin-testing';
import { AdminPromotionsPage } from './admin-promotions.page';

describe('AdminPromotionsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading and empty campaign signals', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page.loading()).toBe(false);
    expect(page.promotions()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });

  it('labels guest and member vouchers with the checkout audience', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page.voucherAudience({ voucher_id: '1', applicable_user_group: 'guest' })).toBe('Khách vãng lai');
    expect(page.voucherAudience({ voucher_id: '2', applicable_user_group: 'member' })).toBe('Thành viên');
    expect(page.voucherAudience({ voucher_id: '3' })).toBe('Mọi khách');
  });
});

describe('AdminPromotionsPage with a recording API', () => {
  const calls: { statistics: Record<string, string>[]; vouchers: Record<string, string>[] } = { statistics: [], vouchers: [] };

  async function createPage(): Promise<AdminPromotionsPage> {
    calls.statistics = [];
    calls.vouchers = [];
    const empty = () => of({ rows: [], count: 0 });
    const api = {
      listPromotions: (params: Record<string, string>) =>
        of(params['limit'] === '100'
          ? { rows: [{ promo_id: 'p1', promo_name: 'Sale 10.10' }], count: 1 }
          : { rows: [], count: 12 }),
      listVouchers: (params: Record<string, string>) => {
        calls.vouchers.push(params);
        return of({ rows: [], count: 27 });
      },
      listProducts: empty,
      listCategories: () => of({ rows: [{ category_id: 'c-ao', name: 'Áo' }] }),
      pricingStatistics: (params: Record<string, string>) => {
        calls.statistics.push(params);
        return of(null);
      },
    } as unknown as AdminApiService;
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AdminPromotionsPage],
      providers: [provideRouter([]), { provide: AdminApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminPromotionsPage);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('badge tab dùng tổng thật, không phải số dòng của trang đang xem', async () => {
    const page = await createPage();
    expect(page.promoCount()).toBe(12);
    expect(page.voucherCount()).toBe(27);
  });

  it('thống kê mặc định 30 ngày, chọn Toàn bộ thì không gửi mốc ngày', async () => {
    const page = await createPage();
    page.setView('stats');
    expect(calls.statistics.at(-1)?.['from']).toBeTruthy();
    page.setStatsRange('all');
    expect(calls.statistics.at(-1)).toEqual({});
  });

  it('lọc bảng mã theo chiến dịch gửi promoId và về trang 1', async () => {
    const page = await createPage();
    page.page.set(3);
    page.setVoucherPromoFilter({ target: { value: 'p1' } } as unknown as Event);
    expect(page.page()).toBe(1);
    expect(calls.vouchers.at(-1)?.['promoId']).toBe('p1');
  });

  it('bảng mã nói mã thuộc chiến dịch nào và áp cho danh mục nào', async () => {
    const page = await createPage();
    expect(page.voucherCampaign({ voucher_id: 'v1', promo_id: 'p1' })).toBe('Sale 10.10');
    expect(page.voucherCampaign({ voucher_id: 'v2', promo_id: null })).toBe('Mã đứng riêng');
    expect(page.voucherScope({ voucher_id: 'v1', applicable_categories: ['c-ao'] })).toBe('Áo');
    expect(page.voucherScope({ voucher_id: 'v2', applicable_categories: null })).toBe('Cả giỏ');
    expect(page.voucherCap({ voucher_id: 'v3', discount_type: 'percentage', max_discount_amount: null })).toBe('Không giới hạn');
  });
});
