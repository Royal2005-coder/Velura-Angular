import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminDashboardSummary, AdminErpApiService } from '../../core/admin-erp-api.service';
import { DashboardService } from './services/dashboard.service';
import { AdminErpDashboardPage } from './admin-erp-dashboard.page';
import { MacroKpiResponse } from './models/macro-kpi.model';

// Mock ResizeObserver for JSDOM/Vitest environment
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

const mockMacroKpisResponse: MacroKpiResponse = {
  status: 'success',
  data: {
    period: {
      from: '2026-10-17T00:00:00Z',
      to: '2026-10-24T00:00:00Z',
      range: '7d',
      cached_at: '2026-10-24T03:00:00Z',
      cache_ttl_seconds: 600,
    },
    kpis: {
      net_revenue: {
        title: 'Doanh thu thuần',
        value: 12_000_000,
        formatted: '12 Tr',
        trend_value: 15.2,
        trend_direction: 'up',
        is_inverted_metric: false,
        unit: 'VND',
        trend_label: '+15.2% so kỳ trước',
      },
      gross_margin: {
        title: 'Biên LN gộp',
        value: 45.0,
        formatted: '45.0%',
        trend_value: 2.1,
        trend_direction: 'up',
        is_inverted_metric: false,
        unit: 'pct',
        trend_label: '+2.1 pp so kỳ trước',
      },
      aov: {
        title: 'AOV Đơn hàng',
        value: 300_000,
        formatted: '300,000 đ',
        trend_value: 5.0,
        trend_direction: 'up',
        is_inverted_metric: false,
        unit: 'VND',
        trend_label: '+5.0% so kỳ trước',
      },
      repeat_rate: {
        title: 'Khách mua lại',
        value: 28.5,
        formatted: '28.5%',
        trend_value: 1.0,
        trend_direction: 'up',
        is_inverted_metric: false,
        unit: 'pct',
        trend_label: '+1.0 pp so kỳ trước',
      },
      return_rate: {
        title: 'Tỷ lệ đổi trả',
        value: 3.2,
        formatted: '3.2%',
        trend_value: -0.5,
        trend_direction: 'down',
        is_inverted_metric: true,
        unit: 'pct',
        trend_label: '-0.5 pp so kỳ trước',
      },
    },
  },
};

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
            getMacroKpis: () => of(mockMacroKpisResponse),
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

  it('renders 5 Macro KPIs with real-data signals when switching to business tab', async () => {
    const fixture = await boot();
    const page = fixture.componentInstance;

    page.setTab('business');
    fixture.detectChanges();

    expect(page.macroKpis()).toEqual(mockMacroKpisResponse.data);
    expect(page.macroNetRevenue()?.formatted).toBe('12 Tr');
    expect(page.macroGrossMargin()?.formatted).toBe('45.0%');
    expect(page.macroAov()?.formatted).toBe('300,000 đ');
    expect(page.macroRepeatRate()?.formatted).toBe('28.5%');
    expect(page.macroReturnRate()?.formatted).toBe('3.2%');

    // Test trend pill classes & inverted metric logic
    expect(page.getTrendPillClass(page.macroNetRevenue())).toBe('bi-trend-pill bi-trend-pill--up');
    expect(page.getTrendPillClass(page.macroReturnRate())).toBe('bi-trend-pill bi-trend-pill--up'); // negative return rate is good/up!
    expect(page.getTrendPillText(page.macroNetRevenue())).toBe('↑ +15.2%');
    expect(page.getTrendPillText(page.macroReturnRate())).toBe('↓ -0.5 pp');
  });
});
