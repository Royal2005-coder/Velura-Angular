import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { AdminDashboardSummary, AdminErpApiService, AdminManagementInsight } from '../../core/admin-erp-api.service';
import { AdminErpSessionService, type AdminAuthMe } from '../../core/admin-erp-session.service';
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
  async function boot(api: Pick<AdminErpApiService, 'dashboard'> & Partial<Pick<AdminErpApiService, 'refreshDashboard'>>) {
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

  it('sends each alert to the exact queue it counts', async () => {
    const fixture = await boot({ dashboard: () => of(summary) });
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role: 'super_admin',
      roleName: 'Quản trị',
      isAdmin: true,
      allowedPages: ['dashboard', 'orders', 'returns-cskh', 'products', 'reviews'],
      allowedModules: ['orders', 'returns', 'products', 'reviews'],
      capabilities: {},
      user: { id: 'u0', email: 'root@velura.test' },
      profile: { user_id: 'u0', email: 'root@velura.test', full_name: 'Root', is_active: true },
    } as AdminAuthMe);
    const page = fixture.componentInstance;

    expect(page.alertLink('orders')).toEqual({ commands: ['/orders'], query: { tab: 'attention' } });
    expect(page.alertLink('returns-cskh')?.query).toEqual({ tab: 'returns', status: 'REQUESTED' });
    expect(page.alertLink('products')?.query).toEqual({ tab: 'stock' });
    expect(page.alertLink('reviews')?.query).toEqual({ tab: 'urgent' });
  });

  it('offers no alert route for a page the session cannot open', async () => {
    const fixture = await boot({ dashboard: () => of(summary) });
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role: 'admin_viewer',
      roleName: 'Xem',
      isAdmin: true,
      allowedPages: ['dashboard'],
      allowedModules: [],
      capabilities: {},
      user: { id: 'u9', email: 'v@velura.test' },
      profile: { user_id: 'u9', email: 'v@velura.test', full_name: 'Viewer', is_active: true },
    } as AdminAuthMe);

    expect(fixture.componentInstance.alertLink('orders')).toBeNull();
  });

  const asSession = (role: string, allowedPages: string[], capabilities: Record<string, string[]> = {}) =>
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role,
      roleName: role,
      isAdmin: true,
      allowedPages,
      allowedModules: [],
      capabilities,
      user: { id: 'u1', email: 'a@velura.test' },
      profile: { user_id: 'u1', email: 'a@velura.test', full_name: 'A', is_active: true },
    } as AdminAuthMe);

  const readyInsight: AdminManagementInsight = {
    id: 'AD_DB_02',
    title: 'Điểm nghẽn đơn hàng và SLA',
    availability: 'ready',
    severity: 'watch',
    phenomenon: '4 đơn ở trạng thái xử lý trên 24 giờ.',
    scope: '12 đơn đang mở.',
    magnitude: '33% trên số đơn có đủ dấu thời gian.',
    consequence: 'Đối chiếu hàng đợi trước khi phân công.',
    action: { label: 'Kiểm tra hàng đợi', route: '/orders', module: 'orders' },
  };
  const missingInsight: AdminManagementInsight = {
    id: 'AD_DB_09',
    title: 'Giữ chân khách hàng',
    availability: 'insufficient_data',
    severity: 'watch',
    dataNote: 'Chưa có cohort mua lại.',
  };

  it('renders the four parts and a deep link for ready insights, and a dimmed reason for missing data', async () => {
    const fixture = await boot({
      dashboard: () => of({ ...summary, management: { groups: [readyInsight, missingInsight] } }),
    });
    asSession('super_admin', ['dashboard', 'orders']);
    const page = fixture.componentInstance;
    page.setTab('insights');
    fixture.detectChanges();

    const [ready, missing] = page.insightCards();
    expect(ready.parts.map((part) => part.label)).toEqual(['Hiện tượng', 'Phạm vi', 'Mức độ / tác động', 'Hệ quả']);
    expect(ready.action?.link).toEqual({ commands: ['/orders'], query: {} });
    expect(missing.ready).toBe(false);
    expect(missing.parts).toEqual([]);
    expect(missing.severityLabel).toBe('Chưa đủ dữ liệu');
    expect(missing.note).toBe('Chưa có cohort mua lại.');
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.insight').length).toBe(2);
    expect(host.querySelectorAll('.insight--muted').length).toBe(1);
    expect(page.readyInsightCount()).toBe(1);
  });

  it('keeps a drill-down link for admin viewer once the target page is readable, and none otherwise', async () => {
    const fixture = await boot({ dashboard: () => of({ ...summary, management: { groups: [readyInsight] } }) });
    asSession('admin_viewer', ['dashboard', 'orders']);
    expect(fixture.componentInstance.insightCards()[0].action?.link?.commands).toEqual(['/orders']);
    asSession('admin_viewer', ['dashboard']);
    expect(fixture.componentInstance.insightView(readyInsight).action?.link).toBeNull();
  });

  it('shows an em dash and "Chưa có dữ liệu" for a null revenue instead of 0đ', async () => {
    const fixture = await boot({
      dashboard: () => of({ ...summary, business: { ...summary.business, revenue: null, orderCount: null } }),
    });
    const [revenue, orders] = fixture.componentInstance.businessKpis();
    expect(revenue.value).toBe('—');
    expect(revenue.hint).toBe('Chưa có dữ liệu');
    expect(orders.value).toBe('—');
    expect(orders.hint).toBe('Chưa có dữ liệu');
  });

  it('does not flag live operations as stale when only the warehouse snapshot is old', async () => {
    const fixture = await boot({
      dashboard: () => of({ ...summary, meta: { ...summary.meta, freshness: 'stale', pendingEvents: 3 } }),
    });
    const page = fixture.componentInstance;
    expect(page.dataStatus().label).toBe('Hàng đợi trực tiếp');
    page.setTab('business');
    expect(page.dataStatus().label).toBe('Dữ liệu cũ');
    expect(page.footerNote()).toContain('3 sự kiện giao dịch chờ đồng bộ');
  });

  it('super admin refresh re-syncs the warehouse, locks the button for 10 s and reloads', async () => {
    let syncs = 0;
    let reads = 0;
    const fixture = await boot({
      dashboard: () => {
        reads += 1;
        return of(summary);
      },
      refreshDashboard: () => {
        syncs += 1;
        return of({ success: true, status: 'succeeded' });
      },
    });
    asSession('super_admin', ['dashboard'], { '*': ['read', 'update'] });
    const page = fixture.componentInstance;
    vi.useFakeTimers();
    try {
      page.refresh();
      expect(syncs).toBe(1);
      expect(reads).toBe(2);
      expect(page.cooldown()).toBe(10);
      expect(page.notice()?.tone).toBe('success');
      page.refresh();
      expect(syncs).toBe(1);
      vi.advanceTimersByTime(10_000);
      expect(page.cooldown()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a 429 throttle into a friendly warning and keeps the verified snapshot', async () => {
    let reads = 0;
    const fixture = await boot({
      dashboard: () => {
        reads += 1;
        return of(summary);
      },
      refreshDashboard: () => throwError(() => new HttpErrorResponse({ status: 429 })),
    });
    asSession('super_admin', ['dashboard'], { '*': ['read', 'update'] });
    const page = fixture.componentInstance;
    vi.useFakeTimers();
    try {
      page.refresh();
      expect(page.notice()).toEqual({ tone: 'warning', text: 'Kho dữ liệu vừa được đồng bộ. Vui lòng chờ 10 giây rồi thử lại.' });
      expect(page.refreshing()).toBe(false);
      expect(reads).toBe(1);
      vi.advanceTimersByTime(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('roles without update permission only re-read the dashboard', async () => {
    let syncs = 0;
    let reads = 0;
    const fixture = await boot({
      dashboard: () => {
        reads += 1;
        return of(summary);
      },
      refreshDashboard: () => {
        syncs += 1;
        return of({});
      },
    });
    asSession('admin_viewer', ['dashboard'], { dashboard: ['read'] });

    fixture.componentInstance.refresh();

    expect(syncs).toBe(0);
    expect(reads).toBe(2);
  });
});
