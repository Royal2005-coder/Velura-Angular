import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminDashboardSummary, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminErpDashboardPage } from './admin-erp-dashboard.page';

const summary: AdminDashboardSummary = {
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
    revenueTrend: [{ date: '2026-10-24', dateStr: '24/10', revenue: 1_000_000, orderCount: 4 }],
    bestSellers: [{ name: 'Lụa Hà Nội', sku: 'VL-01', sold: 9, revenue: 2_700_000 }],
    categoryContributions: [{ name: 'Áo', revenue: 6_000_000, pct: 50 }],
  },
  recentLogs: [
    {
      audit_id: 'a1',
      timestamp: '2026-10-24T03:00:00Z',
      actor_name: 'Quản trị',
      action: 'update',
      module: 'orders',
      target_id: '1234567890',
    },
  ],
  meta: { generatedAt: '2026-10-24T03:05:00Z', source: 'oltp.rpc' },
};

describe('AdminErpDashboardPage', () => {
  async function boot(api: Pick<AdminErpApiService, 'dashboard'>) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AdminErpDashboardPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpDashboardPage);
    fixture.detectChanges();
    return fixture;
  }

  it('renders real operation KPI values from the API summary', async () => {
    const fixture = await boot({ dashboard: () => of(summary) });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBeNull();
    expect(page.loading()).toBe(false);
    expect(page.operationKpis()[0].value).toBe('3');
    expect(page.alertTotal()).toBe(21);
    expect(page.recentActivity().length).toBe(1);
  });

  it('switches to the business view without refetching', async () => {
    let calls = 0;
    const fixture = await boot({
      dashboard: () => {
        calls += 1;
        return of(summary);
      },
    });
    const page = fixture.componentInstance;

    page.setTab('business');
    fixture.detectChanges();

    expect(page.tab()).toBe('business');
    expect(page.businessKpis()[0].value).toContain('12M');
    expect(calls).toBe(1);
  });

  it('reloads with the selected fixed range', async () => {
    const ranges: string[] = [];
    const fixture = await boot({
      dashboard: (params) => {
        ranges.push(String(params?.['range'] ?? ''));
        return of(summary);
      },
    });
    const page = fixture.componentInstance;

    page.setRange('month');

    expect(ranges).toEqual(['week', 'month']);
    expect(page.periodLabel()).toBe('30 ngày gần nhất');
  });

  it('shows an error state instead of fabricated KPIs when the API fails', async () => {
    const fixture = await boot({ dashboard: () => throwError(() => new Error('API down')) });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('API down');
    expect(page.operationKpis()[0].value).toBe('0');
    expect(page.recentActivity()).toEqual([]);
  });
});
