import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminDashboardSummary, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { DashboardService } from './services/dashboard.service';
import { AdminErpDashboardPage, NO_DATA_SOURCE } from './admin-erp-dashboard.page';

const mockSummary: AdminDashboardSummary = {
  operations: {
    pendingOrders: 3,
    paymentErrors: 1,
    openReturns: 2,
    openSupportTickets: 4,
    lowStockProducts: 5,
    urgentReviews: 6,
  },
  business: {
    revenue: 12_000_000,
    orderCount: 40,
    averageOrderValue: 300_000,
    completionRate: 92,
    promotionRevenue: 2_000_000,
    promotionRevenueShare: 16,
    pendingReviews: 7,
    comparisons: { revenuePct: 15.2, orderCountPct: 10 },
    revenueTrend: [{ date: '2026-10-24', dateStr: '24/10', revenue: 1_000_000, orderCount: 4 }],
    bestSellers: [{ name: 'Lụa Hà Nội', sku: 'VL-01', sold: 9, revenue: 2_700_000 }],
    categoryContributions: [{ name: 'Áo', revenue: 6_000_000, pct: 50 }],
  },
  recentLogs: [],
  periodDays: 7,
  range: 'week',
  meta: { generatedAt: '2026-10-24T03:05:00Z', source: 'oltp.rpc' },
};

const moduleHealth = {
  orders_pending_24h: 7,
  variants_out_of_stock: 3,
  tickets_open_24h: 2,
  promotions_near_budget: 0,
  reviews_urgent: 1,
  admin_requests_pending: 4,
  total_issues: 17,
  fetched_at: '2026-10-24T03:00:00Z',
};

describe('AdminErpDashboardPage', () => {
  async function boot(
    apiMock?: Partial<AdminErpApiService>,
    dashboardServiceMock?: Partial<DashboardService>,
    operatorName: string | null = 'Lan Phạm',
  ) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AdminErpDashboardPage],
      providers: [
        provideRouter([]),
        {
          provide: AdminErpApiService,
          useValue: {
            dashboard: () => of(mockSummary),
            recommendInsights: () => of({ lines: [] }),
            ...apiMock,
          },
        },
        {
          provide: DashboardService,
          useValue: {
            getSlaMetrics: () => of({ success: true, data: [], fetched_at: '' }),
            getInventoryAlerts: () => of({ success: true, data: [], fetched_at: '' }),
            getModuleHealth: () => of({ success: true, data: moduleHealth, fetched_at: '' }),
            ...dashboardServiceMock,
          },
        },
        {
          provide: AdminErpSessionService,
          useValue: { session: signal(operatorName === null ? null : { name: operatorName }) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpDashboardPage);
    fixture.detectChanges();
    return fixture;
  }

  function panel(root: HTMLElement, id: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    if (!el) {
      throw new Error(`panel ${id} not rendered`);
    }
    return el;
  }

  it('renders operations dashboard successfully with initial signals', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    expect(page.tab()).toBe('operations');
    expect(page.loadError()).toBeNull();
    expect(page.loading()).toBe(false);
    expect(page.q1ModuleRows().length).toBe(6);
  });

  it('greets the signed-in operator and falls back to a neutral greeting', async () => {
    let fixture = await boot();
    let greeting = (fixture.nativeElement as HTMLElement).querySelector('.bi-greeting')?.textContent ?? '';
    expect(greeting).toContain('Xin chào, Lan Phạm');

    fixture = await boot(undefined, undefined, null);
    greeting = (fixture.nativeElement as HTMLElement).querySelector('.bi-greeting')?.textContent ?? '';
    expect(greeting).toContain('Xin chào, bạn');
  });

  it('computes Q1 and KPI figures from the real responses', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    expect(page.q1ModuleRows().map((row) => row.count)).toEqual([7, 3, 2, 0, 1, 4]);
    expect(page.totalSystemIssues()).toBe(17);
    expect(page.totalProcessingOrders()).toBe(3);
    expect(page.totalPaymentErrors()).toBe(1);
    expect(page.totalCskhQueue()).toBe(6);
    expect(page.totalLowStockVariants()).toBe(5);
    expect(panel(fixture.nativeElement, 'Q1').textContent).toContain('17 mục');
  });

  it('shows the empty state for panels without a data source', async () => {
    const fixture = await boot();
    const root = fixture.nativeElement as HTMLElement;

    expect(panel(root, 'Q3').querySelector('.bi-empty-state')?.textContent).toContain(NO_DATA_SOURCE);

    fixture.componentInstance.setTab('business');
    fixture.detectChanges();
    expect(root.querySelector('[data-kpi="gross-profit"]')?.textContent).toContain(NO_DATA_SOURCE);
    expect(root.querySelector('[data-kpi="repeat-customers"]')?.textContent).toContain(NO_DATA_SOURCE);
    expect(panel(root, 'B5').querySelector('.bi-empty-state')?.textContent).toContain(NO_DATA_SOURCE);

    fixture.componentInstance.setB1Tab('price_bar');
    fixture.detectChanges();
    expect(panel(root, 'B1').querySelector('.bi-empty-state')?.textContent).toContain(NO_DATA_SOURCE);
  });

  it('never renders sample records', async () => {
    const fixture = await boot();
    const root = fixture.nativeElement as HTMLElement;
    const operations = root.textContent ?? '';
    fixture.componentInstance.setTab('business');
    fixture.detectChanges();
    const text = operations + (root.textContent ?? '');

    for (const fabricated of ['PAY-991', 'Super Admin', 'Catalog V4', 'VNPay', 'Hoàng Tuấn', '34 Sự cố', 'Quá SLA 24h']) {
      expect(text).not.toContain(fabricated);
    }
  });

  it('switches between operations and business tabs', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    expect(page.tab()).toBe('operations');
    page.setTab('business');
    fixture.detectChanges();
    expect(page.tab()).toBe('business');
    expect(page.revenue()).toBe(12_000_000);
    expect(page.topCategory()?.name).toBe('Áo');
  });

  it('switches range filter without breaking signal consistency', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    page.setRange('month');
    expect(page.range()).toBe('month');
  });

  it('handles API errors gracefully and shows no figures', async () => {
    const fixture = await boot(
      { dashboard: () => throwError(() => new Error('API down')) },
      { getModuleHealth: () => throwError(() => new Error('down')) },
    );
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('API down');
    expect(page.loading()).toBe(false);
    expect(page.totalProcessingOrders()).toBeNull();
    expect(page.totalSystemIssues()).toBeNull();
    expect(page.revenue()).toBeNull();
    expect(page.countText(page.totalPaymentErrors())).toBe('—');
  });
});
