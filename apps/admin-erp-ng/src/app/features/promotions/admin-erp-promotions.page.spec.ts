import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import {
  AdminErpApiService,
  AdminPricingStatistics,
  AdminPromotionListPayload,
  AdminPromotionRow,
  AdminVoucherRow,
} from '../../core/admin-erp-api.service';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpPromotionsPage } from './admin-erp-promotions.page';

const campaigns: AdminPromotionRow[] = [
  {
    promo_id: 'p1',
    promo_name: 'Thu đông 2026',
    promo_type: 'seasonal_sale',
    lifecycle_status: 'running',
    lifecycle_label: 'Đang chạy',
    is_active: true,
    start_date: '2026-10-01T00:00:00Z',
    end_date: '2026-11-30T00:00:00Z',
    budget_limit: 10_000_000,
    total_discount_issued: 2_000_000,
    voucher_count: 4,
    can_pause: true,
    version: 2,
  },
];

const vouchers: AdminVoucherRow[] = [
  {
    voucher_id: 'v1',
    code: 'THUDONG26',
    name: 'Giảm 10%',
    discount_type: 'percentage',
    discount_value: 10,
    min_order_value: 500_000,
    used_count: 3,
    usage_limit_total: 100,
    usage_limit_per_user: 1,
    is_active: true,
    start_date: '2026-10-01T00:00:00Z',
    end_date: '2026-11-30T00:00:00Z',
    version: 1,
  },
];

const stats: AdminPricingStatistics = {
  range: { from: null, to: null },
  orders: {
    total: 12,
    withVoucher: 5,
    voucherRate: 41.7,
    revenueWithVoucher: 5_000_000,
    revenueWithoutVoucher: 7_000_000,
    revenueShareWithVoucher: 41.7,
    discountTotal: 500_000,
    aovWithVoucher: 1_000_000,
    aovWithoutVoucher: 875_000,
  },
  promotions: {
    total: 1,
    running: 1,
    scheduled: 0,
    paused: 0,
    ended: 0,
    budgetExhausted: 0,
    totalBudget: 10_000_000,
    issuedDiscount: 2_000_000,
    budgetedCampaigns: 1,
    activeVouchers: 1,
    budgetRemaining: 8_000_000,
    budgetUsagePercent: 20,
  },
  vouchers: { total: 1, active: 1, scheduled: 0, expired: 0, disabled: 0, unlimited: 0, totalUsed: 3, totalLimit: 100, usagePercent: 3 },
  campaigns: [],
  topVouchers: [{ voucherId: 'v1', code: 'THUDONG26', orders: 3, discount: 300_000, revenue: 2_000_000 }],
};

type ListPromotionsFn = (params?: Record<string, string>) => Observable<AdminPromotionListPayload>;

describe('AdminErpPromotionsPage', () => {
  async function boot(listPromotions: ListPromotionsFn) {
    TestBed.resetTestingModule();
    let toggled = '';
    const api = {
      listPromotions,
      listVouchers: () => of({ rows: vouchers, count: 1 }),
      listPricingAuditLogs: () => of({ rows: [], count: 0 }),
      pricingStatistics: () => of(stats),
      toggleVoucher: (voucherId: string) => {
        toggled = voucherId;
        return of({});
      },
      activatePromotion: () => of({}),
      pausePromotion: () => of({}),
      createPromotion: () => of(campaigns[0]),
      updatePromotion: () => of(campaigns[0]),
      createVoucher: () => of({}),
      updateVoucher: () => of(vouchers[0]),
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpPromotionsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext({
      role: 'admin_operator_gia_km',
      roleName: 'Admin giá & KM',
      isAdmin: true,
      allowedPages: ['promotions'],
      allowedModules: ['promotions'],
      capabilities: { promotions: ['read', 'update'] },
      user: { id: 'promo', email: 'promo@velura.test' },
      profile: { user_id: 'promo', email: 'promo@velura.test', full_name: 'Promo', role: 'admin', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpPromotionsPage);
    fixture.detectChanges();
    return { fixture, toggled: () => toggled };
  }

  it('loads campaigns and the API summary', async () => {
    const { fixture } = await boot(() =>
      of({
        rows: campaigns,
        count: 1,
        summary: stats.promotions,
      }),
    );
    const page = fixture.componentInstance;

    expect(page.campaigns().length).toBe(1);
    expect(page.promoCount()).toBe(1);
    expect(page.activeCampaigns()).toBe(1);
    expect(page.activeVouchers()).toBe(1);
    expect(page.canMutate()).toBe(true);
  });

  it('switches to vouchers and stats views', async () => {
    const { fixture } = await boot(() => of({ rows: campaigns, count: 1, summary: stats.promotions }));
    const page = fixture.componentInstance;

    page.setView('vouchers');
    expect(page.view()).toBe('vouchers');
    expect(page.vouchers().length).toBe(1);

    page.setView('stats');
    expect(page.stats()?.orders.total).toBe(12);
    expect(page.stats()?.topVouchers.length).toBe(1);
  });

  it('opens campaign detail and maps lifecycle', async () => {
    const { fixture } = await boot(() => of({ rows: campaigns, count: 1, summary: stats.promotions }));
    const page = fixture.componentInstance;

    page.openCampaign(campaigns[0]);
    expect(page.selectedCampaign()?.promo_id).toBe('p1');
    expect(page.lifecycleLabel(campaigns[0])).toBe('Đang chạy');
    expect(page.lifecycleTone(campaigns[0])).toBe('success');
  });

  it('toggles the selected voucher through the API', async () => {
    const { fixture, toggled } = await boot(() => of({ rows: campaigns, count: 1, summary: stats.promotions }));
    const page = fixture.componentInstance;

    page.setView('vouchers');
    page.openVoucher(vouchers[0]);
    page.toggleVoucher();

    expect(toggled()).toBe('v1');
  });

  it('surfaces campaign API errors', async () => {
    const { fixture } = await boot(() => throwError(() => new Error('promotions down')));
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('promotions down');
    expect(page.campaigns()).toEqual([]);
  });
});
