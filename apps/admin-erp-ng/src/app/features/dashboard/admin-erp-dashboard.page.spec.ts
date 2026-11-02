import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminDashboardSummary, AdminErpApiService } from '../../core/admin-erp-api.service';
import { DashboardService } from './services/dashboard.service';
import { AdminErpDashboardPage } from './admin-erp-dashboard.page';

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

describe('AdminErpDashboardPage', () => {
  async function boot(apiMock?: Partial<AdminErpApiService>, dashboardServiceMock?: Partial<DashboardService>) {
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
            getSlaMetrics: () => of([]),
            getInventoryAlerts: () => of([]),
            getModuleHealth: () => of({
              total_issues: 34,
              orders_pending_24h: 16,
              variants_out_of_stock: 10,
              tickets_open_24h: 4,
              promotions_near_budget: 1,
              reviews_urgent: 2,
              admin_requests_pending: 1,
            }),
            ...dashboardServiceMock,
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpDashboardPage);
    fixture.detectChanges();
    return fixture;
  }

  it('renders operations dashboard successfully with initial signals', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    expect(page.tab()).toBe('operations');
    expect(page.loadError()).toBeNull();
    expect(page.loading()).toBe(false);
    expect(page.q1ModuleRows().length).toBe(6);
  });

  it('switches between operations and business tabs', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    expect(page.tab()).toBe('operations');
    page.setTab('business');
    fixture.detectChanges();
    expect(page.tab()).toBe('business');
  });

  it('switches range filter without breaking signal consistency', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    page.setRange('month');
    expect(page.range()).toBe('month');
  });

  it('handles API errors gracefully and updates loadError signal', async () => {
    const fixture = await boot({
      dashboard: () => throwError(() => new Error('API down')),
    });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('API down');
    expect(page.loading()).toBe(false);
  });
});
